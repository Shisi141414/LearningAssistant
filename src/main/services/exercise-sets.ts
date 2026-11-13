import { nanoid } from 'nanoid'
import type { LearningDocument, LearningState } from '@shared/types'
import type {
  ExerciseSetPreview,
  ExerciseSetResult
} from '@shared/exercise-set'
import {
  exerciseEntryText,
  isExerciseApproach,
  splitExerciseSet
} from '@shared/exercise-set'
import { getDb } from './db'
import { materialDetail } from './materials'
import {
  getLearningDocument,
  prepareLearningDocument,
  publishLearningRevision
} from './learning-documents'
import { importExercises } from './exercises'
import type { ExerciseSource } from '@shared/exercises'

type Pending = {
  token: string
  created: number
  materialId: string
  document: LearningDocument
  state: LearningState
  changed: boolean
  ids: Set<string>
}
const pending = new Map<number, Pending>(),
  generations = new Map<number, number>()
const expireAfter = 20 * 60_000
export function discardExerciseSet(owner: number): boolean {
  pending.delete(owner)
  generations.set(owner, (generations.get(owner) ?? 0) + 1)
  return true
}
export async function previewExerciseSet(
  owner: number,
  versionId: string
): Promise<ExerciseSetPreview> {
  discardExerciseSet(owner)
  const generation = generations.get(owner)
  const materialId = (
    getDb()
      .prepare('SELECT material_id FROM material_versions WHERE id=?')
      .get(versionId) as { material_id: string } | undefined
  )?.material_id
  if (!materialId) throw new Error('材料版本不存在')
  const detail = materialDetail(materialId),
    version = detail.versions.find((v) => v.id === versionId)!
  if (detail.material.archived || version.status !== 'ready')
    throw new Error('请选择未删除且已解析完成的习题集版本')
  const document = await prepareLearningDocument(versionId)
  const plan = splitExerciseSet(document.sources, document.state, nanoid)
  const entries = plan.state.entries.filter(
    (e) => e.type === 'exercise' || e.type === 'example'
  )
  if (entries.length > 500)
    throw new Error('一次最多转换 500 道题，请先按章节拆分习题集')
  const sourceMap = new Map(document.sources.map((s) => [s.id, s]))
  const candidates = entries.map((entry) => {
    const linked = new Set(
      plan.state.relations
        .filter((r) => r.type === 'solves' && r.to === entry.id)
        .map((r) => r.from)
    )
    const solutions = plan.state.entries.filter((e) => linked.has(e.id))
    const existing = !plan.changed
      ? (getDb()
          .prepare('SELECT id,deleted_at FROM exercises WHERE source_key=?')
          .get(JSON.stringify([versionId, document.revision_id, entry.id])) as
          | { id: string; deleted_at: number | null }
          | undefined)
      : undefined
    const location = [
      ...new Set(
        entry.sources.map((ref) => {
          const source = sourceMap.get(ref.source_id)!,
            locator = JSON.parse(source.locator_json)
          return locator.page
            ? `第 ${locator.page} 页`
            : locator.slide
              ? `幻灯片 ${locator.slide}`
              : `段落 ${source.ordinal + 1}`
        })
      )
    ].join('、')
    const statement = exerciseEntryText(entry, sourceMap),
      approach = solutions
        .filter(isExerciseApproach)
        .map((e) => exerciseEntryText(e, sourceMap))
        .join('\n\n'),
      answer = solutions
        .filter((e) => !isExerciseApproach(e))
        .map((e) => exerciseEntryText(e, sourceMap))
        .join('\n\n')
    if ([statement, approach, answer].some((s) => s.length > 200_000))
      throw new Error('某道题超过 20 万字符，请先在材料中拆分')
    return {
      id: entry.id,
      title: entry.title || statement.slice(0, 80),
      statement,
      approach,
      answer,
      location,
      existing_id: existing?.id ?? null,
      in_trash:
        existing?.deleted_at !== null && existing?.deleted_at !== undefined
    }
  })
  const warnings = [
    ...plan.warnings,
    ...(JSON.parse(version.warnings_json) as string[]),
    '自动切分需核对：括号小问保留在原题中；无明确关联的题后答案、复杂排版与配图请对照原件。未补写答案或判定对错。'
  ]
  if (generations.get(owner) !== generation)
    throw new Error('此次预览已取消或被新预览替代')
  const token = nanoid()
  pending.set(owner, {
    token,
    created: Date.now(),
    materialId,
    document,
    state: plan.state,
    changed: plan.changed,
    ids: new Set(entries.map((e) => e.id))
  })
  return {
    token,
    material_id: materialId,
    version_id: versionId,
    revision_id: document.revision_id,
    title: detail.material.title,
    candidates,
    warnings: [...new Set(warnings)]
  }
}
export function importExerciseSet(
  owner: number,
  input: { token: string; entry_ids: string[] }
): ExerciseSetResult {
  const plan = pending.get(owner)
  if (
    !plan ||
    plan.token !== input.token ||
    Date.now() - plan.created > expireAfter
  )
    throw new Error('预览已失效，请重新预览习题集')
  if (
    !input.entry_ids.length ||
    input.entry_ids.length > 500 ||
    new Set(input.entry_ids).size !== input.entry_ids.length ||
    input.entry_ids.some((id) => !plan.ids.has(id))
  )
    throw new Error('请选择本次预览中不重复的习题')
  const db = getDb()
  const result = db.transaction(() => {
    const detail = materialDetail(plan.materialId)
    if (
      detail.material.archived ||
      detail.versions.find((v) => v.id === plan.document.version_id)?.status !==
        'ready'
    )
      throw new Error('习题集已删除或版本不可用，请重新选择')
    const current = getLearningDocument({
      version_id: plan.document.version_id
    })
    if (current?.current_revision_id !== plan.document.current_revision_id)
      throw new Error('材料整理已有更新，请重新预览，避免使用旧的切分结果')
    const document = plan.changed
      ? publishLearningRevision(plan.document, plan.state)
      : plan.document
    const result: ExerciseSetResult = {
      added: 0,
      skipped: 0,
      in_trash: 0,
      ids: [],
      material_id: plan.materialId,
      revision_id: document.revision_id
    }
    const incoming: ExerciseSource[] = [],
      resolved = new Map<string, string>()
    for (const id of input.entry_ids) {
      const existing = db
        .prepare('SELECT id,deleted_at FROM exercises WHERE source_key=?')
        .get(
          JSON.stringify([document.version_id, document.revision_id, id])
        ) as { id: string; deleted_at: number | null } | undefined
      if (existing) {
        result.skipped++
        if (existing.deleted_at !== null) result.in_trash++
        resolved.set(id, existing.id)
        continue
      }
      incoming.push({
        material_id: plan.materialId,
        version_id: document.version_id,
        revision_id: document.revision_id,
        entry_id: id
      })
    }
    const added = importExercises(incoming)
    added.forEach((exercise, index) =>
      resolved.set(incoming[index].entry_id, exercise.id)
    )
    result.added = added.length
    result.ids = input.entry_ids.map((id) => resolved.get(id)!)
    return result
  })()
  pending.delete(owner)
  return result
}
