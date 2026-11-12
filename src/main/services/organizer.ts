import type { ID, NoteSegment, SegmentOrganizedEvent } from '@shared/types'
import { getDb } from './db'
import { withWork } from './work'
import { buildOrganizePrompt, parseOrganizedResponse } from './organize'
import { completeChat } from './llm'
import { getProviderWithKey } from '../ipc/providers.ipc'
import { pickModel } from '../ipc/chat.ipc'
import { configGet } from './config'
import { segmentMaterialContext } from './classroom-materials'
import { captureNoteLearning } from './note-learning'

const running = new Map<ID, Promise<SegmentOrganizedEvent>>()
export function organizeSegment(id: ID): Promise<SegmentOrganizedEvent> {
  const existing = running.get(id)
  if (existing) return existing
  const work = withWork('笔记整理', async () => {
    const db = getDb()
    const seg = db.prepare('SELECT * FROM note_segments WHERE id = ?').get(id) as NoteSegment | undefined
    if (!seg?.raw_text.trim()) throw new Error('段落不存在或无原文可整理')
    db.prepare("UPDATE note_segments SET organize_status = 'processing', organize_attempts = organize_attempts + 1 WHERE id = ?").run(id)
    try {
      const subject = db.prepare(`SELECT s.name FROM notes n LEFT JOIN activities a ON a.id = n.activity_id
        LEFT JOIN subjects s ON s.id = COALESCE(n.subject_id, a.subject_id) WHERE n.id = ?`).get(seg.note_id) as { name: string | null }
      const model = pickModel(null)
      const { provider, apiKey } = getProviderWithKey(model.provider_id)
      if (!apiKey) throw new Error('未配置模型密钥；已保留原文，稍后可以重试')
      const response = await completeChat({ ...provider, apiKey }, model.model_id, buildOrganizePrompt(seg.raw_text, subject?.name ?? undefined, segmentMaterialContext(id)))
      const parsed = parseOrganizedResponse(response, seg.raw_text)
      if (parsed.fallback) throw new Error('模型输出无法解析，已保留原文')
      db.transaction(() => {
        // 旧笔记升级时也先保留生成前的来源；发布失败则和整理稿一起回滚。
        captureNoteLearning(id)
        const result = db.prepare(`UPDATE note_segments SET seg_type = ?, organized_text = ?, organized_by = 'ai', organized_model = ?,
          organize_status = 'done', organize_error = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`).run(parsed.seg_type, parsed.organized_text, model.model_id, Date.now(), id, seg.revision ?? 0)
        if (!result.changes) throw new Error('生成期间段落已被编辑，保留你的修改，请重新整理')
        db.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(Date.now(), seg.note_id)
        captureNoteLearning(id)
      })()
      return { segment_id: id, ...parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = db.prepare('SELECT revision, organize_attempts FROM note_segments WHERE id = ?').get(id) as { revision: number; organize_attempts: number } | undefined
      if (current) db.prepare('UPDATE note_segments SET organize_status = ?, organize_error = ?, organize_retry_at = ? WHERE id = ?').run(
        current.revision !== (seg.revision ?? 0) ? 'conflict' : 'failed', message,
        Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(current.organize_attempts, 4)), id)
      throw error
    }
  }).finally(() => running.delete(id))
  running.set(id, work)
  return work
}

let retrying = false
export async function retryPending(noteId?: ID, explicit = false): Promise<number> {
  if (retrying) return 0
  if (!explicit && configGet('classroom.autoOrganize') === '0') return 0
  retrying = true
  let done = 0
  try {
    const rows = getDb().prepare(`SELECT id FROM note_segments WHERE organize_status IN ('pending','failed') AND organized_by != 'user'
      AND (? IS NULL OR note_id = ?) AND (? OR organize_retry_at <= ?) ORDER BY created_at LIMIT 20`).all(noteId ?? null, noteId ?? null, explicit ? 1 : 0, Date.now()) as Array<{ id: ID }>
    for (const row of rows) { try { await organizeSegment(row.id); done++ } catch { /* 状态已持久化，按退避重试。 */ } }
    return done
  } finally { retrying = false }
}

export function startOrganizationRecovery(): () => void {
  getDb().prepare("UPDATE note_segments SET organize_status = 'pending' WHERE organize_status = 'processing'").run()
  void retryPending()
  const timer = setInterval(() => void retryPending(), 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
