/**
 * ipc/notes.ipc.ts —— 笔记、段落与标注
 */
import { IPC } from '@shared/ipc-channels'
import type {
  Note, NoteSegment, NoteWithSegments, Annotation, AnnotationKind,
  SegmentType, ID, Timestamp
} from '@shared/types'
import { getDb } from '../services/db'
import { ipcMain, handleResult } from './helpers'
import { nanoid } from 'nanoid'
import { addSegment } from '../services/segments'
import { attachMaterialRefs } from '../services/classroom-materials'
import { captureNoteLearning, getNoteLearning } from '../services/note-learning'

interface NoteRow {
  id: string
  subject_id: string | null
  activity_id: string | null
  title: string
  source: 'manual' | 'class' | 'import'
  created_at: number
  updated_at: number
  activity_title?: string | null
}

interface SegmentRow {
  id: string
  note_id: string
  sort_order: number
  seg_type: SegmentType
  raw_text: string
  organized_text: string
  image_path: string | null
  created_at: number
  updated_at: number
}

interface AnnotationRow {
  id: string
  segment_id: string
  kind: AnnotationKind
  anchor_json: string | null
  comment: string
  created_at: number
}

const rowToNote = (r: NoteRow): Note => ({ ...r })
const rowToSegment = (r: SegmentRow): NoteSegment => ({ ...r })
const rowToAnnotation = (r: AnnotationRow): Annotation => ({ ...r })

function touchNote(db: ReturnType<typeof getDb>, noteId: ID): void {
  db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), noteId)
}

export function registerNotesIpc(): void {
  ipcMain.handle(IPC.NotesLearningGet, (_e, input: { note_id: ID; revision_id?: ID }) => handleResult(() => getNoteLearning(input)))
  /* ---------- 笔记 ---------- */

  ipcMain.handle(IPC.NotesList, (_e, filter?: { subject_id?: ID | null; activity_id?: ID | null }) =>
    handleResult(() => {
      const db = getDb()
      // "全部"视图混入活动笔记时，带出活动标题供标识
      let rows: NoteRow[]
      if (filter?.activity_id) {
        rows = db.prepare(
          'SELECT n.*, a.title AS activity_title FROM notes n LEFT JOIN activities a ON n.activity_id = a.id WHERE n.activity_id = ? ORDER BY n.updated_at DESC'
        ).all(filter.activity_id) as NoteRow[]
      } else if (filter?.subject_id) {
        rows = db.prepare(
          'SELECT n.*, a.title AS activity_title FROM notes n LEFT JOIN activities a ON n.activity_id = a.id WHERE n.subject_id = ? ORDER BY n.updated_at DESC'
        ).all(filter.subject_id) as NoteRow[]
      } else {
        rows = db.prepare(
          'SELECT n.*, a.title AS activity_title FROM notes n LEFT JOIN activities a ON n.activity_id = a.id ORDER BY n.updated_at DESC'
        ).all() as NoteRow[]
      }
      return rows.map(rowToNote)
    })
  )

  ipcMain.handle(IPC.NotesGet, (_e, id: ID) =>
    handleResult((): NoteWithSegments => {
      const db = getDb()
      const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
      if (!note) throw new Error('笔记不存在')
      const segments = (db.prepare('SELECT * FROM note_segments WHERE note_id = ? ORDER BY sort_order').all(id) as SegmentRow[]).map(rowToSegment)
      const annRows = db.prepare(
        `SELECT a.* FROM annotations a JOIN note_segments s ON a.segment_id = s.id WHERE s.note_id = ? ORDER BY a.created_at`
      ).all(id) as AnnotationRow[]
      return { ...rowToNote(note), segments: attachMaterialRefs(id, segments), annotations: annRows.map(rowToAnnotation) }
    })
  )

  ipcMain.handle(IPC.NotesCreate, (_e, input: { title: string; subject_id?: ID | null; activity_id?: ID | null; source?: Note['source'] }) =>
    handleResult(() => {
      const db = getDb()
      // ADR-5：subject 与 activity 二选一（都不挂 = 通用笔记）
      if (input.subject_id && input.activity_id) throw new Error('笔记不能同时挂学科与活动')
      const now = Date.now()
      const note: Note = {
        id: nanoid(),
        subject_id: input.subject_id ?? null,
        activity_id: input.activity_id ?? null,
        title: input.title,
        source: input.source ?? 'manual',
        created_at: now,
        updated_at: now
      }
      db.prepare('INSERT INTO notes (id, subject_id, activity_id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        note.id, note.subject_id, note.activity_id, note.title, note.source, note.created_at, note.updated_at
      )
      return note
    })
  )

  ipcMain.handle(IPC.NotesUpdate, (_e, { id, ...patch }: { id: ID; title?: string; subject_id?: ID | null; activity_id?: ID | null }) =>
    handleResult(() => {
      const db = getDb()
      const cur = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
      if (!cur) throw new Error('笔记不存在')
      const next = { ...rowToNote(cur), ...patch } as Note
      if (next.subject_id && next.activity_id) throw new Error('笔记不能同时挂学科与活动')
      db.prepare('UPDATE notes SET title = ?, subject_id = ?, activity_id = ?, updated_at = ? WHERE id = ?').run(
        next.title, next.subject_id, next.activity_id, Date.now(), id
      )
      return next
    })
  )

  ipcMain.handle(IPC.NotesRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM notes WHERE id = ?').run(id) // 段落/标注级联删除
      return true
    })
  )

  /* ---------- 段落（双视图核心） ---------- */

  ipcMain.handle(IPC.NotesAddSegment, (_e, input: { note_id: ID; seg_type?: SegmentType; raw_text?: string; organized_text?: string }) =>
    handleResult(() => addSegment(input))
  )

  ipcMain.handle(IPC.NotesUpdateSegment, (_e, { id, ...patch }: { id: ID; seg_type?: SegmentType; raw_text?: string; organized_text?: string }) =>
    handleResult(() => {
      const db = getDb()
      return db.transaction(() => {
        const cur = db.prepare('SELECT * FROM note_segments WHERE id = ?').get(id) as SegmentRow | undefined
        if (!cur) throw new Error('段落不存在')
        captureNoteLearning(id)
        const next: NoteSegment = { ...rowToSegment(cur), ...patch, updated_at: Date.now() }
        db.prepare("UPDATE note_segments SET seg_type = ?, raw_text = ?, organized_text = ?, updated_at = ?, revision = revision + 1, organized_by = 'user', organized_model = NULL, organize_status = 'idle', organize_error = NULL WHERE id = ?").run(
          next.seg_type, next.raw_text, next.organized_text, next.updated_at, id
        )
        touchNote(db, cur.note_id)
        captureNoteLearning(id)
        return db.prepare('SELECT * FROM note_segments WHERE id=?').get(id) as NoteSegment
      })()
    })
  )

  ipcMain.handle(IPC.NotesRemoveSegment, (_e, id: ID) =>
    handleResult(() => {
      const db = getDb()
      return db.transaction(() => {
        const cur = db.prepare('SELECT note_id FROM note_segments WHERE id = ?').get(id) as { note_id: string } | undefined
        if (cur) captureNoteLearning(id)
        db.prepare('DELETE FROM note_segments WHERE id = ?').run(id)
        if (cur) touchNote(db, cur.note_id)
        return true
      })()
    })
  )

  /* ---------- 标注 ---------- */

  ipcMain.handle(IPC.AnnotationsAdd, (_e, input: { segment_id: ID; kind: AnnotationKind; comment?: string }) =>
    handleResult(() => {
      const db = getDb()
      const ann: Annotation = {
        id: nanoid(),
        segment_id: input.segment_id,
        kind: input.kind,
        anchor_json: null, // M0 整段级；M1 BlockNote 接入后为选区 JSON
        comment: input.comment ?? '',
        created_at: Date.now() as Timestamp
      }
      db.prepare('INSERT INTO annotations (id, segment_id, kind, anchor_json, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        ann.id, ann.segment_id, ann.kind, ann.anchor_json, ann.comment, ann.created_at
      )
      return ann
    })
  )

  ipcMain.handle(IPC.AnnotationsUpdate, (_e, { id, comment }: { id: ID; comment: string }) =>
    handleResult(() => {
      const db = getDb()
      db.prepare('UPDATE annotations SET comment = ? WHERE id = ?').run(comment, id)
      const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as AnnotationRow | undefined
      if (!row) throw new Error('标注不存在')
      return rowToAnnotation(row)
    })
  )

  ipcMain.handle(IPC.AnnotationsRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM annotations WHERE id = ?').run(id)
      return true
    })
  )
}
