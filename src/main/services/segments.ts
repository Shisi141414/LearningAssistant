import { nanoid } from 'nanoid'
import type { NoteSegment, SegmentInput } from '@shared/types'
import { getDb } from './db'
import { configGet } from './config'
import { segmentMaterialRef } from './classroom-materials'
import { captureNoteLearning } from './note-learning'

export function addSegment(input: SegmentInput): NoteSegment {
  const db = getDb()
  return db.transaction(() => {
    const note = db.prepare('SELECT source FROM notes WHERE id = ?').get(input.note_id) as { source: string } | undefined
    if (!note) throw new Error('笔记不存在')
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM note_segments WHERE note_id = ?').get(input.note_id) as { m: number }
    const id = nanoid(), now = Date.now()
    const pending = note.source === 'class' && configGet('classroom.autoOrganize') !== '0' && !!input.raw_text?.trim()
    db.prepare(`INSERT INTO note_segments (id,note_id,sort_order,seg_type,raw_text,organized_text,created_at,updated_at,organize_status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, input.note_id, max.m + 1, input.seg_type ?? 'other', input.raw_text ?? '', input.organized_text ?? input.raw_text ?? '', now, now, pending ? 'pending' : 'idle')
    db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(now, input.note_id)
    db.prepare('INSERT INTO segment_material_refs (segment_id, block_id) SELECT ?, block_id FROM classroom_positions WHERE note_id = ? AND block_id IS NOT NULL').run(id, input.note_id)
    captureNoteLearning(id)
    return { ...db.prepare('SELECT * FROM note_segments WHERE id = ?').get(id) as NoteSegment, material_ref: segmentMaterialRef(id) }
  })()
}
