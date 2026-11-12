import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { LearningState, NoteLearningBlock, NoteLearningChange, NoteLearningDocument, NoteLearningSyncPreview, NoteSegment } from '@shared/types'
import { noteLearningBlock } from '@shared/note-learning'
import { reconcileNoteLearning } from '@shared/note-learning-sync'
import { changeLearningState, validateLearningState } from '@shared/learning-document'
import { getDb } from './db'
import { attachMaterialRefs, segmentMaterialRef } from './classroom-materials'

type DocumentRow = { id: string; note_id: string; created_at: number }
type RevisionRow = { id: string; document_id: string; title: string; subject_id: string | null; block_ids_json: string; state_json: string | null; created_at: number }
function ensureDocument(noteId: string): DocumentRow {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM note_learning_documents WHERE note_id = ?').get(noteId) as DocumentRow | undefined
  if (existing) return existing
  if (!db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId)) throw new Error('笔记不存在')
  const row = { id: nanoid(), note_id: noteId, created_at: Date.now() }
  db.prepare('INSERT INTO note_learning_documents (id,note_id,created_at) VALUES (?,?,?)').run(row.id, noteId, row.created_at)
  return row
}
/** 调用者将其与段落保存放进同一事务。单段常量级写入，旧来源永不覆盖。 */
export function captureNoteLearning(segmentId: string): string {
  const db = getDb(), segment = db.prepare('SELECT * FROM note_segments WHERE id = ?').get(segmentId) as NoteSegment | undefined
  if (!segment) throw new Error('段落不存在')
  return capture(ensureDocument(segment.note_id).id, { ...segment, material_ref: segmentMaterialRef(segmentId) })
}
function capture(documentId: string, segment: NoteSegment): string {
  const db = getDb(), snapshot = noteLearningBlock(segment, () => 'fingerprint')
  // 临时语义 ID 固定，仅内容/来源变化产生新版本。正文不作 trim 或回退。
  const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  const existing = db.prepare('SELECT id FROM note_learning_blocks WHERE document_id = ? AND segment_id = ? AND fingerprint = ?').get(documentId, segment.id, fingerprint) as { id: string } | undefined
  if (existing) return existing.id
  const id = nanoid(), block = noteLearningBlock(segment, nanoid)
  db.prepare('INSERT INTO note_learning_blocks (id,document_id,segment_id,fingerprint,snapshot_json,created_at) VALUES (?,?,?,?,?,?)').run(id, documentId, segment.id, fingerprint, JSON.stringify(block), Date.now())
  return id
}
function loadBlocks(documentId: string, ids: string[]): NoteLearningBlock[] {
  const statement = getDb().prepare('SELECT snapshot_json FROM note_learning_blocks WHERE id=? AND document_id=?')
  return ids.map(id => {
    const row = statement.get(id, documentId) as { snapshot_json: string } | undefined
    if (!row) throw new Error('笔记来源快照缺失')
    return JSON.parse(row.snapshot_json) as NoteLearningBlock
  })
}
function content(blocks: NoteLearningBlock[], state?: LearningState) {
  const sources = blocks.map((block, ordinal) => ({ ...block.source, ordinal }))
  state ??= { entries: blocks.flatMap(block => block.state.entries), relations: blocks.flatMap(block => block.state.relations) }
  if (sources.length) validateLearningState(state, sources)
  else if (state.entries.length || state.relations.length) throw new Error('空笔记不能包含无来源的条目')
  return { sources, state, origins: Object.fromEntries(blocks.map(block => [block.source.id, block.origin])) }
}
function liveNote(noteId: string) {
  const db = getDb()
  const note = db.prepare(`SELECT n.title, COALESCE(n.subject_id,a.subject_id) AS subject_id FROM notes n LEFT JOIN activities a ON a.id=n.activity_id WHERE n.id=?`).get(noteId) as { title: string; subject_id: string | null } | undefined
  if (!note) throw new Error('笔记不存在')
  const document = ensureDocument(noteId)
  const segments = db.prepare('SELECT * FROM note_segments WHERE note_id=? ORDER BY sort_order, rowid LIMIT 5001').all(noteId) as NoteSegment[]
  if (segments.length > 5000) throw new Error('统一视图每篇最多 5000 段，请拆分笔记')
  const ids = attachMaterialRefs(noteId, segments).map(segment => capture(document.id, segment))
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...note, ids })).digest('hex')
  return { document, note, ids, blocks: loadBlocks(document.id, ids), fingerprint }
}
type LiveNote = ReturnType<typeof liveNote>
const latestRevision = (documentId: string) => getDb().prepare('SELECT * FROM note_learning_revisions WHERE document_id=? ORDER BY rowid DESC LIMIT 1').get(documentId) as RevisionRow | undefined
function changed(latest: RevisionRow, live: LiveNote): boolean {
  return latest.block_ids_json !== JSON.stringify(live.ids) || latest.title !== live.note.title || latest.subject_id !== live.note.subject_id
}
function syncPlan(latest: RevisionRow, live: LiveNote): NoteLearningSyncPreview {
  const oldBlocks = loadBlocks(live.document.id, JSON.parse(latest.block_ids_json) as string[])
  const previous = content(oldBlocks, latest.state_json ? JSON.parse(latest.state_json) as LearningState : undefined)
  let sequence = 0
  const plan = reconcileNoteLearning(previous.state, oldBlocks, live.blocks, () => createHash('sha256').update(`${latest.id}:${live.fingerprint}:${++sequence}`).digest('base64url').slice(0, 21))
  return { base_revision_id: latest.id, fingerprint: live.fingerprint, summary: plan.summary, ...content(live.blocks, plan.state) }
}
function saveRevision(live: LiveNote, state?: LearningState): RevisionRow {
  content(live.blocks, state)
  const row: RevisionRow = { id: nanoid(), document_id: live.document.id, ...live.note, block_ids_json: JSON.stringify(live.ids), state_json: state ? JSON.stringify(state) : null, created_at: Date.now() }
  getDb().prepare('INSERT INTO note_learning_revisions (id,document_id,title,subject_id,block_ids_json,state_json,created_at) VALUES (?,?,?,?,?,?,?)').run(row.id, row.document_id, row.title, row.subject_id, row.block_ids_json, row.state_json, row.created_at)
  return row
}
function readRevision(document: DocumentRow, selected: RevisionRow, latest: RevisionRow, pending?: NoteLearningDocument['pending_sync']): NoteLearningDocument {
  const blocks = loadBlocks(document.id, JSON.parse(selected.block_ids_json) as string[])
  return { id: document.id, note_id: document.note_id, revision_id: selected.id, current_revision_id: latest.id, title: selected.title, subject_id: selected.subject_id, created_at: selected.created_at,
    ...content(blocks, selected.state_json ? JSON.parse(selected.state_json) as LearningState : undefined),
    history: getDb().prepare('SELECT id,created_at FROM note_learning_revisions WHERE document_id=? ORDER BY rowid DESC').all(document.id) as { id: string; created_at: number }[], ...(pending ? { pending_sync: pending } : {}) }
}
/** 自动接入安全变化；人工范围发生变化时保留当前修订，等待具体预览确认。 */
export function getNoteLearning(input: { note_id: string; revision_id?: string }): NoteLearningDocument {
  const db = getDb()
  return db.transaction(() => {
    const document = ensureDocument(input.note_id)
    let latest = latestRevision(document.id), pending: NoteLearningDocument['pending_sync']
    if (!input.revision_id) {
      const live = liveNote(input.note_id)
      if (!latest) latest = saveRevision(live)
      else if (changed(latest, live)) {
        if (!latest.state_json) latest = saveRevision(live)
        else {
          const plan = syncPlan(latest, live)
          if (plan.summary.requires_review) pending = { fingerprint: plan.fingerprint, summary: plan.summary }
          else latest = saveRevision(live, plan.state)
        }
      }
    }
    const selected = input.revision_id ? db.prepare('SELECT * FROM note_learning_revisions WHERE id=? AND document_id=?').get(input.revision_id, document.id) as RevisionRow | undefined : latest
    if (!selected || !latest) throw new Error('所选修订不属于此笔记')
    return readRevision(document, selected, latest, pending)
  })()
}
export function changeNoteLearning(input: NoteLearningChange): NoteLearningDocument {
  return getDb().transaction(() => {
    if (['figure', 'figure-remove'].includes(input.action)) throw new Error('笔记尚未支持配图附件')
    const current = getNoteLearning({ note_id: input.note_id })
    if (current.revision_id !== input.expected_revision_id) throw new Error('笔记已有新修订，请读取最新笔记后重试')
    if (current.pending_sync) throw new Error('来源变化涉及已整理内容，请读取最新笔记，再预览并同步来源')
    const state = changeLearningState(current.state, current.sources, input, nanoid)
    const live = liveNote(input.note_id), next = saveRevision(live, state)
    return readRevision(live.document, next, next)
  })()
}
/** AI 结构同样通过最新来源与修订检查；仅新增修订，原始段落不改写。 */
export function publishNoteLearningState(noteId: string, expectedRevision: string, state: LearningState): NoteLearningDocument {
  return getDb().transaction(() => {
    const current = getNoteLearning({ note_id: noteId })
    if (current.revision_id !== expectedRevision || current.pending_sync) throw new Error('笔记或来源已有变化，请读取最新笔记后重新生成建议')
    const live = liveNote(noteId), next = saveRevision(live, state)
    return readRevision(live.document, next, next)
  })()
}
export function previewNoteLearningSync(noteId: string): NoteLearningSyncPreview {
  return getDb().transaction(() => {
    const live = liveNote(noteId), latest = latestRevision(live.document.id)
    if (!latest || !changed(latest, live)) throw new Error('当前来源已同步，无需再次更新')
    return syncPlan(latest, live)
  })()
}
export function syncNoteLearning(input: { note_id: string; expected_revision_id: string; fingerprint: string }): NoteLearningDocument {
  return getDb().transaction(() => {
    const live = liveNote(input.note_id), latest = latestRevision(live.document.id)
    if (!latest || latest.id !== input.expected_revision_id || live.fingerprint !== input.fingerprint) throw new Error('预览后笔记或来源已变化，请重新预览')
    if (!changed(latest, live)) throw new Error('当前来源已同步，无需再次更新')
    const plan = syncPlan(latest, live), next = saveRevision(live, plan.state)
    return readRevision(live.document, next, next)
  })()
}
