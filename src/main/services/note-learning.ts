import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { NoteLearningBlock, NoteLearningDocument, NoteSegment } from '@shared/types'
import { noteLearningBlock } from '@shared/note-learning'
import { validateLearningState } from '@shared/learning-document'
import { getDb } from './db'
import { attachMaterialRefs, segmentMaterialRef } from './classroom-materials'

type DocumentRow = { id: string; note_id: string; created_at: number }
type RevisionRow = { id: string; document_id: string; title: string; subject_id: string | null; block_ids_json: string; created_at: number }
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
/** 打开统一视图时固定整篇修订；后台每段修改已独立保留，无需反复复制全篇。 */
export function getNoteLearning(input: { note_id: string; revision_id?: string }): NoteLearningDocument | null {
  const db = getDb()
  return db.transaction(() => {
    const note = db.prepare(`SELECT n.title, COALESCE(n.subject_id,a.subject_id) AS subject_id FROM notes n LEFT JOIN activities a ON a.id=n.activity_id WHERE n.id=?`).get(input.note_id) as { title: string; subject_id: string | null } | undefined
    if (!note) throw new Error('笔记不存在')
    const document = ensureDocument(input.note_id)
    let latest = db.prepare('SELECT * FROM note_learning_revisions WHERE document_id=? ORDER BY rowid DESC LIMIT 1').get(document.id) as RevisionRow | undefined
    if (!input.revision_id) {
      const segments = db.prepare('SELECT * FROM note_segments WHERE note_id=? ORDER BY sort_order, rowid LIMIT 5001').all(input.note_id) as NoteSegment[]
      if (segments.length > 5000) throw new Error('统一视图每篇最多 5000 段，请拆分笔记')
      const refs = attachMaterialRefs(input.note_id, segments)
      const ids = refs.map(segment => capture(document.id, segment)), encoded = JSON.stringify(ids)
      if (!latest || latest.block_ids_json !== encoded || latest.title !== note.title || latest.subject_id !== note.subject_id) {
        latest = { id: nanoid(), document_id: document.id, ...note, block_ids_json: encoded, created_at: Date.now() }
        db.prepare('INSERT INTO note_learning_revisions (id,document_id,title,subject_id,block_ids_json,created_at) VALUES (?,?,?,?,?,?)').run(latest.id, document.id, note.title, note.subject_id, encoded, latest.created_at)
      }
    }
    const selected = input.revision_id ? db.prepare('SELECT * FROM note_learning_revisions WHERE id=? AND document_id=?').get(input.revision_id, document.id) as RevisionRow | undefined : latest
    if (!selected) throw new Error('所选修订不属于此笔记')
    const ids = JSON.parse(selected.block_ids_json) as string[]
    const blocks = ids.map(id => {
      const row = db.prepare('SELECT snapshot_json FROM note_learning_blocks WHERE id=? AND document_id=?').get(id, document.id) as { snapshot_json: string } | undefined
      if (!row) throw new Error('笔记来源快照缺失')
      return JSON.parse(row.snapshot_json) as NoteLearningBlock
    })
    const sources = blocks.map((block, ordinal) => ({ ...block.source, ordinal })), state = { entries: blocks.flatMap(block => block.state.entries), relations: blocks.flatMap(block => block.state.relations) }
    if (sources.length) validateLearningState(state, sources)
    return { id: document.id, note_id: input.note_id, revision_id: selected.id, current_revision_id: latest?.id ?? selected.id, title: selected.title, subject_id: selected.subject_id, created_at: selected.created_at,
      sources, state, origins: Object.fromEntries(blocks.map(block => [block.source.id, block.origin])), history: db.prepare('SELECT id,created_at FROM note_learning_revisions WHERE document_id=? ORDER BY rowid DESC').all(document.id) as { id: string; created_at: number }[] }
  })()
}
