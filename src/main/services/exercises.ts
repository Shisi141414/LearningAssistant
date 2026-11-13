import { nanoid } from 'nanoid'
import type {
  ExerciseDetail,
  ExerciseInput,
  ExerciseListInput,
  ExercisePage,
  ExerciseSnapshot,
  ExerciseSource
} from '@shared/exercises'
import { exerciseSnapshot, exerciseTexts } from '@shared/exercises'
import { entryText, validateLearningState } from '@shared/learning-document'
import { exerciseEntryText, isExerciseApproach } from '@shared/exercise-set'
import type { LearningDocument, LearningEntry, LearningSource } from '@shared/types'
import { getDb } from './db'
import { getLearningDocument } from './learning-documents'

type Row = {
  id: string
  head_revision_id: string | null
  deleted_at: number | null
  created_at: number
  updated_at: number
  subject_id: string | null
  statement: string
  user_solution: string | null
  std_answer: string | null
  approach_json: string | null
  error_points_json: string | null
  no_idea: number
  [key: string]: unknown
}
const row = (id: string): Row => {
  const result = getDb().prepare('SELECT * FROM exercises WHERE id=?').get(id) as Row | undefined
  if (!result) throw new Error('习题不存在')
  return result
}
function references(input: ExerciseInput): void {
  const db = getDb()
  if (input.subject_id && !db.prepare('SELECT id FROM subjects WHERE id=?').get(input.subject_id))
    throw new Error('学科不存在，请刷新')
  if (new Set(input.review_concept_ids).size !== input.review_concept_ids.length)
    throw new Error('复习知识点不能重复')
  for (const id of input.review_concept_ids)
    if (!db.prepare('SELECT id FROM knowledge_points WHERE id=?').get(id))
      throw new Error('复习知识点不存在，请刷新')
}
/** Flat columns are compatibility/search indexes; the revision is the canonical document. */
function publish(id: string, snapshot: ExerciseSnapshot): string {
  const db = getDb(),
    revision = nanoid(),
    now = Date.now(),
    fields = exerciseTexts(snapshot)
  db.prepare(
    'INSERT INTO exercise_revisions(id,exercise_id,snapshot_json,created_at) VALUES (?,?,?,?)'
  ).run(revision, id, JSON.stringify(snapshot), now)
  db.prepare(
    `UPDATE exercises SET title=?,subject_id=?,status=?,question_type=?,source_label=?,no_idea=?,review_concepts_json=?,statement=?,approach_json=?,std_answer=?,user_solution=?,error_points_json=?,head_revision_id=?,updated_at=? WHERE id=?`
  ).run(
    snapshot.title,
    snapshot.subject_id,
    snapshot.status,
    snapshot.question_type,
    snapshot.source_label,
    Number(snapshot.no_idea),
    JSON.stringify(snapshot.review_concept_ids),
    fields.statement,
    JSON.stringify(fields.approach),
    fields.standard_answer,
    fields.user_answer,
    JSON.stringify(fields.error_reason),
    revision,
    now,
    id
  )
  return revision
}
function snapshotAt(id: string, revision: string): ExerciseSnapshot {
  const result = getDb()
    .prepare('SELECT snapshot_json FROM exercise_revisions WHERE exercise_id=? AND id=?')
    .get(id, revision) as { snapshot_json: string } | undefined
  if (!result) throw new Error('习题修订不属于此题或已不存在')
  return JSON.parse(result.snapshot_json)
}
function oldText(value: string | null): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
  } catch {
    return value
  }
}
function initializeLegacy(existing: Row): void {
  if (existing.head_revision_id) return
  const snapshot = exerciseSnapshot(existing.id, {
    title: existing.statement.trim().slice(0, 80) || '未命名习题',
    subject_id: existing.subject_id,
    status: 'unfinished',
    question_type: '',
    source_label: '',
    no_idea: !!existing.no_idea,
    review_concept_ids: [],
    fields: {
      statement: existing.statement,
      approach: oldText(existing.approach_json),
      standard_answer: existing.std_answer ?? '',
      user_answer: existing.user_solution ?? '',
      error_reason: oldText(existing.error_points_json)
    }
  })
  snapshot.legacy = { ...existing }
  // Initial upgrade must not normalize or overwrite any original legacy column.
  const revision = nanoid()
  getDb()
    .prepare(
      'INSERT INTO exercise_revisions(id,exercise_id,snapshot_json,created_at) VALUES (?,?,?,?)'
    )
    .run(revision, existing.id, JSON.stringify(snapshot), existing.updated_at)
  getDb().prepare('UPDATE exercises SET head_revision_id=? WHERE id=?').run(revision, existing.id)
}
export function getExercise(input: { id: string; revision_id?: string }): ExerciseDetail {
  return getDb().transaction(() => {
    initializeLegacy(row(input.id))
    const existing = row(input.id),
      revision = input.revision_id ?? existing.head_revision_id!
    const snapshot = snapshotAt(input.id, revision)
    // Subject deletion uses ON DELETE SET NULL; immutable historical snapshots stay intact.
    if (revision === existing.head_revision_id) snapshot.subject_id = existing.subject_id
    return {
      id: input.id,
      revision_id: revision,
      current_revision_id: existing.head_revision_id!,
      deleted_at: existing.deleted_at,
      created_at: existing.created_at,
      updated_at: existing.updated_at,
      snapshot,
      history: getDb()
        .prepare(
          'SELECT id,created_at FROM exercise_revisions WHERE exercise_id=? ORDER BY created_at DESC,rowid DESC'
        )
        .all(input.id) as ExerciseDetail['history']
    }
  })()
}
export function listExercises(input: ExerciseListInput): ExercisePage {
  const db = getDb(),
    clauses = [input.trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'],
    args: (string | number)[] = []
  if (input.subject_id === null) clauses.push('subject_id IS NULL')
  else if (input.subject_id) {
    clauses.push('subject_id=?')
    args.push(input.subject_id)
  }
  for (const key of ['status', 'question_type'] as const)
    if (input[key]) {
      clauses.push(`${key}=?`)
      args.push(input[key]!)
    }
  if (input.concept_id) {
    clauses.push('EXISTS(SELECT 1 FROM json_each(review_concepts_json) WHERE value=?)')
    args.push(input.concept_id)
  }
  if (input.query?.trim()) {
    clauses.push(
      "(title||char(10)||statement||char(10)||source_label||char(10)||COALESCE(approach_json,'')||char(10)||COALESCE(std_answer,'')||char(10)||COALESCE(user_solution,'')||char(10)||COALESCE(error_points_json,'')) LIKE ? ESCAPE '\\'"
    )
    args.push(`%${input.query.trim().replace(/[\\%_]/g, '\\$&')}%`)
  }
  const where = clauses.join(' AND ')
  return db.transaction(() => {
    const ids = db
      .prepare(
        `SELECT id FROM exercises WHERE ${where} ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?`
      )
      .all(...args, input.offset ?? 0) as { id: string }[]
    for (const item of ids) initializeLegacy(row(item.id))
    const items = ids.map(({ id }) => {
      const item = row(id)
      return {
        id,
        revision_id: item.head_revision_id!,
        title: String(item.title || item.statement.slice(0, 80) || '未命名习题'),
        subject_id: item.subject_id,
        status: item.status as ExerciseSnapshot['status'],
        question_type: String(item.question_type),
        source_label: String(item.source_label),
        no_idea: !!item.no_idea,
        updated_at: item.updated_at
      }
    })
    const total = (
      db.prepare(`SELECT COUNT(*) AS total FROM exercises WHERE ${where}`).get(...args) as {
        total: number
      }
    ).total
    const next = (input.offset ?? 0) + items.length
    return { items, total, next_offset: next < total ? next : null }
  })()
}
export function saveExercise(input: ExerciseInput): ExerciseDetail {
  return getDb().transaction(() => {
    references(input)
    let previous: ExerciseSnapshot | undefined
    const id = input.id ?? nanoid(),
      now = Date.now()
    if (input.id) {
      const current = getExercise({ id })
      if (current.deleted_at !== null) throw new Error('请先从回收站恢复此题')
      if (current.current_revision_id !== input.expected_revision_id)
        throw new Error('习题已有更新，请保留草稿并重新读取当前修订')
      previous = current.snapshot
    } else {
      if (input.expected_revision_id) throw new Error('新习题不能指定旧修订')
      getDb()
        .prepare('INSERT INTO exercises(id,created_at,updated_at) VALUES (?,?,?)')
        .run(id, now, now)
    }
    publish(id, exerciseSnapshot(id, input, previous))
    return getExercise({ id })
  })()
}
export function importExercise(source: ExerciseSource): ExerciseDetail {
  return importExercises([source])[0]
}
/** Reuse one fixed source document for the whole batch, rather than loading it per question. */
export function importExercises(sources: ExerciseSource[]): ExerciseDetail[] {
  if (!sources.length) return []
  const first = sources[0]
  if (sources.length > 500 || sources.some(source => source.version_id !== first.version_id || source.revision_id !== first.revision_id || source.material_id !== first.material_id)) throw new Error('批量转入必须来自同一材料修订，最多 500 道')
  return getDb().transaction(() => {
    const document = getLearningDocument({ version_id: first.version_id, revision_id: first.revision_id })
    if (!document) throw new Error('教材尚未建立学习文档')
    validateLearningState(document.state, document.sources)
    return sources.map(source => importExerciseFromDocument(source, document))
  })()
}
function importExerciseFromDocument(source: ExerciseSource, document: LearningDocument): ExerciseDetail {
  const db = getDb()
  return db.transaction(() => {
    const material = db
      .prepare(
        'SELECT m.title,m.subject_id FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=? AND m.id=?'
      )
      .get(source.version_id, source.material_id) as
      | { title: string; subject_id: string | null }
      | undefined
    if (!material) throw new Error('教材与版本不匹配')
    const entry = document.state.entries.find((item) => item.id === source.entry_id)
    if (!entry || !['exercise', 'example'].includes(entry.type))
      throw new Error('只能从指定修订转入习题或例题条目')
    const sourceKey = JSON.stringify([source.version_id, source.revision_id, source.entry_id])
    const duplicate = db
      .prepare('SELECT id,deleted_at FROM exercises WHERE source_key=?')
      .get(sourceKey) as { id: string; deleted_at: number | null } | undefined
    if (duplicate) {
      if (duplicate.deleted_at !== null)
        throw new Error('此题已在习题回收站，请先恢复，已有答案不会被覆盖')
      return getExercise({ id: duplicate.id })
    }
    const sources = new Map(document.sources.map((item) => [item.id, item]))
    const solutionIds = new Set(
      document.state.relations
        .filter((item) => item.to === entry.id && item.type === 'solves')
        .map((item) => item.from)
    )
    const solutions = document.state.entries.filter((item) => solutionIds.has(item.id))
    const text = (item: LearningEntry): string => exerciseEntryText(item, sources)
    const statement = text(entry),
      approach = solutions.filter(isExerciseApproach).map(text).join('\n\n'),
      answer = solutions.filter(item => !isExerciseApproach(item)).map(text).join('\n\n')
    if ([statement, approach, answer].some(value => value.length > 200_000))
      throw new Error('此条目超过单题 20 万字符限制，请先在教材中拆分')
    // Snapshot just the referenced ranges. A page/source may contain hundreds of questions.
    const originSources = new Map<string, LearningSource>()
    const captureEntry = (item: LearningEntry): LearningEntry => ({ ...item, sources: item.sources.map(ref => {
      const original = sources.get(ref.source_id)!
      const [start, end] = ref.text_range ?? [0, original.raw_text.length]
      if (start === 0 && end === original.raw_text.length) { originSources.set(original.id, original); return ref }
      const id = nanoid()
      originSources.set(id, { ...original, id, raw_text: original.raw_text.slice(start, end), locator_json: JSON.stringify({ ...JSON.parse(original.locator_json), original_source: { id: original.id, text_range: [start, end] } }) })
      return { source_id: id }
    }) })
    const originEntry = captureEntry(entry), originSolutions = solutions.map(captureEntry)
    const usedAssets = new Set(
      [entry, ...solutions].flatMap((item) => item.figures?.map((figure) => figure.asset_id) ?? [])
    )
    const positions = [
      ...new Set(
        entry.sources.map((ref) => {
          const source = sources.get(ref.source_id)!,
            location = JSON.parse(source.locator_json) as { page?: number; slide?: number }
          return location.page
            ? `第 ${location.page} 页`
            : location.slide
              ? `幻灯片 ${location.slide}`
              : `段落 ${source.ordinal + 1}`
        })
      )
    ].join('、')
    const label =
      `${material.title} · ${entry.title || '第 ' + (document.state.entries.indexOf(entry) + 1) + ' 条'} · ${positions}`.slice(
        0,
        2000
      )
    const id = nanoid(),
      now = Date.now()
    const input: ExerciseInput = {
      title: (entry.title || statement.trim().slice(0, 80) || '教材习题').slice(0, 500),
      subject_id: material.subject_id,
      status: 'unfinished',
      question_type: '',
      source_label: label,
      no_idea: false,
      review_concept_ids: [],
      fields: {
        statement,
        approach,
        standard_answer: answer,
        user_answer: '',
        error_reason: ''
      }
    }
    const base = exerciseSnapshot(id, input)
    base.origin = {
      reference: source,
      label,
      raw_text: entryText(entry, sources),
      entry: originEntry,
      solutions: originSolutions,
      sources: [...originSources.values()],
      assets: (document.assets ?? []).filter((item) => usedAssets.has(item.id))
    }
    const snapshot = exerciseSnapshot(id, input, base)
    db.prepare('INSERT INTO exercises(id,source_key,created_at,updated_at) VALUES (?,?,?,?)').run(
      id,
      sourceKey,
      now,
      now
    )
    publish(id, snapshot)
    return getExercise({ id })
  })()
}
export function trashExercise(
  input: { id: string; expected_revision_id: string },
  restore = false
): ExerciseDetail {
  return getDb().transaction(() => {
    const current = getExercise({ id: input.id })
    if (current.current_revision_id !== input.expected_revision_id)
      throw new Error('习题已有更新，请刷新后再操作')
    if ((current.deleted_at !== null) !== restore)
      throw new Error(restore ? '习题未在回收站' : '习题已删除')
    getDb()
      .prepare('UPDATE exercises SET deleted_at=?,updated_at=? WHERE id=?')
      .run(restore ? null : Date.now(), Date.now(), input.id)
    publish(input.id, current.snapshot)
    return getExercise({ id: input.id })
  })()
}
