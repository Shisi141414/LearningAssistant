import { nanoid } from 'nanoid'
import type { ClassroomPosition, MaterialAnchor, MaterialLocateInput, MaterialNoteRef, NoteSegment } from '@shared/types'
import { getDb } from './db'

const anchorSelect = `SELECT b.*, m.id AS material_id, m.title AS material_title, v.file_name, v.format
  FROM material_blocks b JOIN material_versions v ON v.id = b.version_id JOIN materials m ON m.id = v.material_id`
export function materialAnchor(id: string): MaterialAnchor {
  const result = getDb().prepare(`${anchorSelect} WHERE b.id = ?`).get(id) as MaterialAnchor | undefined
  if (!result) throw new Error('教材位置不存在')
  return result
}
export function locateMaterial(input: MaterialLocateInput): MaterialAnchor | null {
  const predicate = input.unit === 'block' ? 'b.ordinal = ?' : input.unit === 'page' ? "json_extract(b.locator_json, '$.page') = ?" : "json_extract(b.locator_json, '$.slide') = ?"
  return getDb().prepare(`${anchorSelect} WHERE b.version_id = ? AND ${predicate} ORDER BY b.ordinal LIMIT 1`).get(input.version_id, input.unit === 'block' ? input.index - 1 : input.index) as MaterialAnchor | undefined ?? null
}
export function classroomPosition(noteId: string): ClassroomPosition | null {
  const row = getDb().prepare('SELECT * FROM classroom_positions WHERE note_id = ?').get(noteId) as { note_id: string; block_id: string | null; updated_at: number } | undefined
  return row ? { note_id: row.note_id, block: row.block_id ? materialAnchor(row.block_id) : null, updated_at: row.updated_at } : null
}
export function calibrateClassroom(noteId: string, blockId: string | null, sessionId?: string): ClassroomPosition {
  const db = getDb()
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM notes WHERE id = ?').get(noteId)) throw new Error('课堂笔记不存在')
    if (blockId) {
      const block = materialAnchor(blockId)
      const version = db.prepare('SELECT status FROM material_versions WHERE id = ?').get(block.version_id) as { status: string }
      if (version.status !== 'ready') throw new Error('材料尚未解析成功，请选择可阅读版本')
    }
    const now = Date.now()
    db.prepare('INSERT INTO classroom_positions (note_id, block_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(note_id) DO UPDATE SET block_id = excluded.block_id, updated_at = excluded.updated_at').run(noteId, blockId, now)
    db.prepare('INSERT INTO classroom_calibrations (id, note_id, session_id, block_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(nanoid(), noteId, sessionId ?? null, blockId, blockId ? sessionId ? 'manual' : 'start' : 'detach', now)
    db.prepare(`INSERT INTO classroom_alignment_settings(note_id,revision,enabled,hold_segment) VALUES(?,?,0,1)
      ON CONFLICT(note_id) DO UPDATE SET revision=excluded.revision,hold_segment=1,enabled=CASE WHEN ? IS NULL THEN 0 ELSE enabled END`).run(noteId, nanoid(), blockId)
    db.prepare("UPDATE classroom_alignment_jobs SET status='cancelled',reason='手动校准优先；保留当时来源',updated_at=? WHERE note_id=? AND status IN ('queued','running')").run(now, noteId)
    return classroomPosition(noteId)!
  })()
}
export function segmentMaterialRef(segmentId: string): MaterialAnchor | null {
  const row = getDb().prepare(`SELECT COALESCE(j.applied_block_id,r.block_id) AS block_id FROM note_segments s
    LEFT JOIN segment_material_refs r ON r.segment_id=s.id
    LEFT JOIN classroom_alignment_jobs j ON j.segment_id=s.id AND j.status='applied' WHERE s.id=?`).get(segmentId) as { block_id: string | null } | undefined
  return row?.block_id ? materialAnchor(row.block_id) : null
}
export function attachMaterialRefs(noteId: string, segments: NoteSegment[]): NoteSegment[] {
  // Start from this note, then look up block primary keys; never cross-scan the material library.
  const refs = getDb().prepare(`SELECT b.*,m.id AS material_id,m.title AS material_title,v.file_name,v.format,s.id AS segment_id
    FROM note_segments s LEFT JOIN segment_material_refs r ON r.segment_id=s.id
    LEFT JOIN classroom_alignment_jobs j ON j.segment_id=s.id AND j.status='applied'
    JOIN material_blocks b ON b.id=COALESCE(j.applied_block_id,r.block_id)
    JOIN material_versions v ON v.id=b.version_id JOIN materials m ON m.id=v.material_id WHERE s.note_id=?`).all(noteId) as Array<MaterialAnchor & {segment_id:string}>
  const bySegment = new Map(refs.map(({segment_id,...ref}) => [segment_id,ref]))
  return segments.map(segment => ({ ...segment, material_ref: bySegment.get(segment.id) ?? null }))
}
export function materialNoteRefs(blockId: string): MaterialNoteRef[] {
  materialAnchor(blockId)
  return getDb().prepare(`SELECT segment_id,note_id,title,raw_text FROM (
    SELECT s.id AS segment_id,s.note_id,n.title,substr(s.raw_text,1,240) AS raw_text,s.created_at
    FROM segment_material_refs r JOIN note_segments s ON s.id=r.segment_id JOIN notes n ON n.id=s.note_id
    LEFT JOIN classroom_alignment_jobs j ON j.segment_id=s.id AND j.status='applied'
    WHERE r.block_id=? AND j.applied_block_id IS NULL
    UNION ALL
    SELECT s.id,s.note_id,n.title,substr(s.raw_text,1,240),s.created_at FROM classroom_alignment_jobs j
    JOIN note_segments s ON s.id=j.segment_id JOIN notes n ON n.id=s.note_id
    WHERE j.status='applied' AND j.applied_block_id=?
    ) ORDER BY created_at DESC LIMIT 50`).all(blockId,blockId) as MaterialNoteRef[]
}
export function segmentMaterialContext(segmentId: string): string {
  const anchor = segmentMaterialRef(segmentId)
  if (!anchor) return ''
  const neighbors = getDb().prepare('SELECT ordinal, text FROM material_blocks WHERE version_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal').all(anchor.version_id, Math.max(0, anchor.ordinal - 1), anchor.ordinal + 1) as Array<{ ordinal: number; text: string }>
  return `材料：${anchor.material_title}；版本：${anchor.version_id}；当前定位：${anchor.locator_json}\n` + neighbors.map(block => `[条目 ${block.ordinal + 1}${block.ordinal === anchor.ordinal ? '，讲授位置' : '，附近参考'}] ${block.text}`).join('\n').slice(0, 6000)
}
