import { nanoid } from 'nanoid'
import type {
  TaskResource,
  TaskResourceAdd,
  TaskResourceEdit,
  TaskResourcePage,
  TaskResourceSnapshot,
  TaskResourceSource
} from '@shared/task-resources'
import { taskResourceKey } from '@shared/task-resources'
import { entryText } from '@shared/learning-document'
import type {
  LearningAsset,
  LearningSource,
  LearningState
} from '@shared/types'
import { getDb } from './db'
import { getLearningDocument } from './learning-documents'
import { getNoteLearning } from './note-learning'
import { getExercise } from './exercises'
import { getProjectDocument } from './project-documents'

const select = `SELECT r.*,t.title AS task_title,t.project_id,p.title AS project_title FROM task_resource_links r JOIN tasks t ON t.id=r.task_id LEFT JOIN projects p ON p.id=t.project_id`
type Row = Omit<TaskResource, 'snapshot' | 'available'> & {
  snapshot_json: string
  material_revision_id: string | null
  note_revision_id: string | null
  note_id: string | null
  exercise_revision_id: string | null
  project_document_revision_id: string | null
}
function publicResource(row: Row): TaskResource {
  return {
    id: row.id,
    task_id: row.task_id,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    role: row.role,
    concept_id: row.concept_id,
    why: row.why,
    verification: row.verification,
    snapshot: JSON.parse(row.snapshot_json),
    available: !!(
      row.material_revision_id ||
      (row.note_revision_id && row.note_id) ||
      row.exercise_revision_id ||
      row.project_document_revision_id
    ),
    task_title: row.task_title,
    project_id: row.project_id,
    project_title: row.project_title
  }
}
function getResource(id: string): TaskResource {
  const row = getDb()
    .prepare(select + ' WHERE r.id=?')
    .get(id) as Row | undefined
  if (!row) throw new Error('任务资料关联不存在')
  return publicResource(row)
}
function requireTask(id: string): void {
  if (!getDb().prepare('SELECT id FROM tasks WHERE id=?').get(id))
    throw new Error('任务不存在，请刷新')
}
function requireConcept(id: string | null): void {
  if (
    id &&
    !getDb().prepare('SELECT id FROM knowledge_points WHERE id=?').get(id)
  )
    throw new Error('知识点不存在，请刷新')
}
function capture(source: TaskResourceSource): {
  snapshot: TaskResourceSnapshot
  column: string
  note_id: string | null
} {
  let title: string,
    sources: LearningSource[],
    state: LearningState,
    assets: LearningAsset[] = [],
    original: string | undefined,
    projectId: string | undefined
  const db = getDb()
  if (source.kind === 'material') {
    const material = db
      .prepare(
        'SELECT m.title FROM materials m JOIN material_versions v ON v.material_id=m.id WHERE m.id=? AND v.id=?'
      )
      .get(source.material_id, source.version_id) as
      | { title: string }
      | undefined
    const doc = getLearningDocument(source)
    if (!material || !doc) throw new Error('材料、修订或来源不匹配')
    title = material.title
    sources = doc.sources
    state = doc.state
    assets = doc.assets ?? []
  } else if (source.kind === 'note') {
    const doc = getNoteLearning(source)
    title = doc.title
    sources = doc.sources
    state = doc.state
    const entry = state.entries.find((item) => item.id === source.entry_id)
    original = entry
      ? [...new Set(entry.sources.map((ref) => ref.source_id))]
          .map((id) => doc.origins[id]?.raw_text ?? '')
          .filter(Boolean)
          .join('\n')
      : ''
  } else if (source.kind === 'exercise') {
    const doc = getExercise({
      id: source.exercise_id,
      revision_id: source.revision_id
    })
    title = doc.snapshot.title
    sources = doc.snapshot.document.sources
    state = doc.snapshot.document.state
    assets = doc.snapshot.origin?.assets ?? []
  } else {
    const doc = getProjectDocument({
      id: source.document_id,
      revision_id: source.revision_id
    })
    title = doc.snapshot.title
    sources = doc.snapshot.sources
    state = doc.snapshot.state
    assets = doc.snapshot.assets
    projectId = doc.project_id
  }
  const entry = state.entries.find((item) => item.id === source.entry_id)
  if (!entry) throw new Error('所选修订中没有此条目，请重新选择')
  const byId = new Map(sources.map((item) => [item.id, item])),
    quote = entryText(entry, byId)
  if (quote.length > 40_000 || (original?.length ?? 0) > 200_000)
    throw new Error(
      '此条目过长，请先拆分后关联任务（摘录最多4万字符，原始转写最多20万字符）'
    )
  const labels = [
    ...new Set(
      entry.sources.map((ref) => {
        const s = byId.get(ref.source_id)!,
          location = JSON.parse(s.locator_json) as {
            page?: number
            slide?: number
          }
        return location.page
          ? `PDF 第 ${location.page} 页`
          : location.slide
            ? `幻灯片 ${location.slide}`
            : s.heading || `来源 ${s.ordinal + 1}`
      })
    )
  ]
  const figures = entry.figures ?? [],
    used = new Set(figures.map((item) => item.asset_id))
  if (
    figures.some(
      (figure) => !assets.some((asset) => asset.id === figure.asset_id)
    )
  )
    throw new Error('条目配图缺失，请先修复来源')
  return {
    snapshot: {
      source,
      title,
      entry_title: entry.title,
      entry_type: entry.type,
      quote,
      location: labels.join('、'),
      formulas: entry.formulas ?? [],
      figures,
      assets: assets.filter((item) => used.has(item.id)),
      ...(original !== undefined ? { original_text: original } : {}),
      ...(projectId ? { source_project_id: projectId } : {})
    },
    column:
      source.kind === 'material'
        ? 'material_revision_id'
        : source.kind === 'note'
          ? 'note_revision_id'
          : source.kind === 'exercise'
            ? 'exercise_revision_id'
            : 'project_document_revision_id',
    note_id: source.kind === 'note' ? source.note_id : null
  }
}
function page(
  where: string,
  args: unknown[],
  offset: number
): TaskResourcePage {
  const db = getDb()
  const items = (
    db
      .prepare(
        select +
          ` WHERE ${where} ORDER BY r.created_at DESC,r.id LIMIT 50 OFFSET ?`
      )
      .all(...args, offset) as Row[]
  ).map(publicResource)
  const total = (
    db
      .prepare('SELECT count(*) AS n FROM task_resource_links r WHERE ' + where)
      .get(...args) as { n: number }
  ).n
  return {
    items,
    total,
    next_offset: offset + items.length < total ? offset + items.length : null
  }
}
export function listTaskResources(input: {
  task_id: string
  offset?: number
}): TaskResourcePage {
  return getDb().transaction(() => {
    requireTask(input.task_id)
    return page('r.task_id=?', [input.task_id], input.offset ?? 0)
  })()
}
export function taskResourceBacklinks(input: {
  source: TaskResourceSource
  offset?: number
}): TaskResourcePage {
  return getDb().transaction(() =>
    page('r.source_key=?', [taskResourceKey(input.source)], input.offset ?? 0)
  )()
}
export function addTaskResource(input: TaskResourceAdd): {
  resource: TaskResource
  created: boolean
} {
  return getDb().transaction(() => {
    requireTask(input.task_id)
    requireConcept(input.concept_id)
    const key = taskResourceKey(input.source),
      db = getDb()
    const duplicate = db
      .prepare(
        'SELECT id FROM task_resource_links WHERE task_id=? AND source_key=?'
      )
      .get(input.task_id, key) as { id: string } | undefined
    if (duplicate)
      return { resource: getResource(duplicate.id), created: false }
    if (
      (
        db
          .prepare(
            'SELECT count(*) AS n FROM task_resource_links WHERE task_id=?'
          )
          .get(input.task_id) as { n: number }
      ).n >= 64
    )
      throw new Error('单个任务最多关联64处资料，请先整理')
    const { snapshot, column, note_id } = capture(input.source),
      id = nanoid(),
      now = Date.now()
    db.prepare(
      `INSERT INTO task_resource_links(id,task_id,source_key,snapshot_json,role,concept_id,why,verification,revision,created_at,updated_at,${column},note_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      input.task_id,
      key,
      JSON.stringify(snapshot),
      input.role,
      input.concept_id,
      input.why.trim(),
      input.verification.trim(),
      nanoid(),
      now,
      now,
      input.source.revision_id,
      note_id
    )
    return { resource: getResource(id), created: true }
  })()
}
export function editTaskResource(input: TaskResourceEdit): TaskResource {
  return getDb().transaction(() => {
    requireConcept(input.concept_id)
    const changed = getDb()
      .prepare(
        'UPDATE task_resource_links SET role=?,concept_id=?,why=?,verification=?,revision=?,updated_at=? WHERE id=? AND revision=?'
      )
      .run(
        input.role,
        input.concept_id,
        input.why.trim(),
        input.verification.trim(),
        nanoid(),
        Date.now(),
        input.id,
        input.expected_revision
      ).changes
    if (!changed) throw new Error('资料关联已变化，请保留草稿并刷新后再编辑')
    return getResource(input.id)
  })()
}
export function removeTaskResource(input: {
  id: string
  expected_revision: string
}): boolean {
  const changed = getDb()
    .prepare('DELETE FROM task_resource_links WHERE id=? AND revision=?')
    .run(input.id, input.expected_revision).changes
  if (!changed) throw new Error('资料关联已变化或已移除，请刷新后再操作')
  return true
}
