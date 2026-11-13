import { mathTokens } from '@shared/math-editor'
import { nanoid } from 'nanoid'
import type {
  ProjectDocumentAction,
  ProjectDocumentChange,
  ProjectDocumentDetail,
  ProjectDocumentSave,
  ProjectDocumentSnapshot,
  ProjectDocumentSummary
} from '@shared/project-documents'
import {
  changeLearningState,
  initialLearningState,
  validateLearningState
} from '@shared/learning-document'
import { getDb } from './db'
import { getLearningDocument } from './learning-documents'

function requireProject(id: string): void {
  if (!getDb().prepare('SELECT id FROM projects WHERE id=?').get(id)) throw new Error('项目不存在')
}
function requireConcepts(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('关联知识点不能重复')
  for (const id of ids)
    if (!getDb().prepare('SELECT id FROM knowledge_points WHERE id=?').get(id))
      throw new Error('关联知识点不存在，请刷新')
}
function publish(id: string, snapshot: ProjectDocumentSnapshot): void {
  validateLearningState(snapshot.state, snapshot.sources)
  const db = getDb(),
    revision = nanoid(),
    now = Date.now()
  db.prepare(
    'INSERT INTO project_document_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,?)'
  ).run(revision, id, JSON.stringify(snapshot), now)
  db.prepare(
    'UPDATE project_documents SET title=?,kind=?,head_revision_id=?,updated_at=? WHERE id=?'
  ).run(snapshot.title, snapshot.kind, revision, now, id)
}
export function getProjectDocument(input: {
  id: string
  revision_id?: string
}): ProjectDocumentDetail {
  return getDb().transaction(() => {
    const db = getDb(),
      row = db.prepare('SELECT * FROM project_documents WHERE id=?').get(input.id) as
        | ProjectDocumentSummary
        | undefined
    if (!row) throw new Error('项目文档不存在')
    const revision = input.revision_id ?? row.head_revision_id
    const saved = db
      .prepare('SELECT snapshot_json FROM project_document_revisions WHERE document_id=? AND id=?')
      .get(input.id, revision) as { snapshot_json: string } | undefined
    if (!saved) throw new Error('所选修订不属于此文档')
    return {
      ...row,
      revision_id: revision,
      snapshot: JSON.parse(saved.snapshot_json),
      history: db
        .prepare(
          'SELECT id,created_at FROM project_document_revisions WHERE document_id=? ORDER BY rowid DESC'
        )
        .all(input.id) as ProjectDocumentDetail['history']
    }
  })()
}
export function listProjectDocuments(input: {
  project_id: string
  trash?: boolean
}): ProjectDocumentSummary[] {
  requireProject(input.project_id)
  return getDb()
    .prepare(
      `SELECT * FROM project_documents WHERE project_id=? AND deleted_at IS ${input.trash ? 'NOT ' : ''}NULL ORDER BY updated_at DESC,id`
    )
    .all(input.project_id) as ProjectDocumentSummary[]
}
function current(input: ProjectDocumentAction, deleted = false): ProjectDocumentDetail {
  const doc = getProjectDocument({ id: input.id })
  if (doc.head_revision_id !== input.expected_revision_id)
    throw new Error('文档已有更新，请保留草稿并重新读取当前修订')
  if ((doc.deleted_at !== null) !== deleted)
    throw new Error(deleted ? '文档未在回收站' : '请先从回收站恢复文档')
  return doc
}
export function saveProjectDocument(input: ProjectDocumentSave): ProjectDocumentDetail {
  return getDb().transaction(() => {
    requireProject(input.project_id)
    requireConcepts(input.concept_ids)
    const id = input.id ?? nanoid(),
      now = Date.now()
    let previous: ProjectDocumentSnapshot | undefined
    if (input.id) {
      const doc = current({ id, expected_revision_id: input.expected_revision_id ?? '' })
      if (doc.project_id !== input.project_id) throw new Error('文档不属于此项目')
      previous = doc.snapshot
    } else {
      if (input.expected_revision_id) throw new Error('新文档不能指定旧修订')
      if (!input.body?.trim()) throw new Error('请填写文档正文')
      getDb()
        .prepare(
          'INSERT INTO project_documents(id,project_id,title,kind,head_revision_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(id, input.project_id, input.title.trim(), input.kind, '', now, now)
    }
    if (input.body !== undefined && !input.body.trim()) throw new Error('文档正文不能为空')
    const sources =
      input.body === undefined
        ? previous!.sources
        : [
            {
              id: nanoid(),
              ordinal: 0,
              raw_text: input.body,
              heading: input.title.trim(),
              locator_json: JSON.stringify({ kind: 'project_document', document_id: id }),
              extraction: 'manual' as const
            }
          ]
    const state = input.body === undefined ? previous!.state : initialLearningState(sources, nanoid)
    if (input.body !== undefined) {
      let cursor = 0
      const formulas = mathTokens(input.body).flatMap((token) => {
        const start = cursor
        cursor += token.text.length
        return token.type === 'formula'
          ? [
              {
                range: [start, cursor] as [number, number],
                latex: token.latex!,
                display: !!token.display
              }
            ]
          : []
      })
      state.entries[0].formulas = formulas
      state.entries[0].analysis = { method: 'manual', review_status: 'confirmed' }
    }
    const snapshot: ProjectDocumentSnapshot = {
      format_version: 1,
      title: input.title.trim(),
      kind: input.kind,
      concept_ids: [...input.concept_ids],
      sources,
      state,
      assets: input.body === undefined ? previous!.assets : [],
      ...(previous?.origin ? { origin: previous.origin } : {})
    }
    publish(id, snapshot)
    return getProjectDocument({ id })
  })()
}
export function changeProjectDocument(input: ProjectDocumentChange): ProjectDocumentDetail {
  return getDb().transaction(() => {
    const doc = current(input),
      snapshot = doc.snapshot
    snapshot.state = changeLearningState(snapshot.state, snapshot.sources, input, nanoid)
    publish(input.id, snapshot)
    return getProjectDocument({ id: input.id })
  })()
}
export function restoreProjectDocumentRevision(
  input: ProjectDocumentAction & { revision_id: string }
): ProjectDocumentDetail {
  return getDb().transaction(() => {
    current(input)
    // Restoring appends a snapshot; the intervening work and old head remain readable.
    const old = getProjectDocument({ id: input.id, revision_id: input.revision_id })
    publish(input.id, old.snapshot)
    return getProjectDocument({ id: input.id })
  })()
}
export function trashProjectDocument(
  input: ProjectDocumentAction,
  restore = false
): ProjectDocumentDetail {
  return getDb().transaction(() => {
    const doc = current(input, restore)
    getDb()
      .prepare('UPDATE project_documents SET deleted_at=? WHERE id=?')
      .run(restore ? null : Date.now(), input.id)
    publish(input.id, doc.snapshot)
    return getProjectDocument({ id: input.id })
  })()
}
export function importProjectDocument(input: {
  project_id: string
  material_id: string
  version_id: string
  revision_id: string
  kind: ProjectDocumentSnapshot['kind']
}): ProjectDocumentDetail {
  return getDb().transaction(() => {
    const db = getDb()
    requireProject(input.project_id)
    const material = db
      .prepare(
        'SELECT m.title FROM materials m JOIN material_versions v ON v.material_id=m.id WHERE m.id=? AND v.id=?'
      )
      .get(input.material_id, input.version_id) as { title: string } | undefined
    if (!material) throw new Error('材料与版本不匹配')
    const source = getLearningDocument(input)
    if (!source) throw new Error('请先在材料库中建立学习文档，再导入项目')
    if (source.sources.reduce((sum, item) => sum + item.raw_text.length, 0) > 2_000_000)
      throw new Error('文档超过本批 200 万字符导入限制，请先拆分材料')
    const key = JSON.stringify([input.material_id, input.version_id, input.revision_id, input.kind])
    const duplicate = db
      .prepare('SELECT id,deleted_at FROM project_documents WHERE project_id=? AND source_key=?')
      .get(input.project_id, key) as { id: string; deleted_at: number | null } | undefined
    if (duplicate) {
      if (duplicate.deleted_at !== null) throw new Error('此来源已在项目文档回收站，请先恢复')
      return getProjectDocument({ id: duplicate.id })
    }
    const id = nanoid(),
      now = Date.now()
    db.prepare(
      'INSERT INTO project_documents(id,project_id,title,kind,head_revision_id,source_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(id, input.project_id, material.title, input.kind, '', key, now, now)
    publish(id, {
      format_version: 1,
      title: material.title,
      kind: input.kind,
      concept_ids: [],
      sources: source.sources,
      state: source.state,
      assets: source.assets ?? [],
      origin: {
        material_id: input.material_id,
        version_id: input.version_id,
        revision_id: input.revision_id,
        title: material.title
      }
    })
    return getProjectDocument({ id })
  })()
}
