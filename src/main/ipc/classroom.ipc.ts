/**
 * ipc/classroom.ipc.ts —— 课堂模式：ASR 启停/喂数据 + 段落 AI 整理
 */
import { ipcMain, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type { AsrStatus, ClassroomStartResult, ID, SegmentType } from '@shared/types'
import { getDb } from '../services/db'
import { configGet } from '../services/config'
import { asrService, findModelFiles, checkSherpaInstalled } from '../services/asr'
import { buildOrganizePrompt, parseOrganizedResponse } from '../services/organize'
import { completeChat } from '../services/llm'
import { getProviderWithKey } from './providers.ipc'
import { pickModel } from './chat.ipc'
import { handleResult } from './helpers'

/** 进行中的整理任务（segment_id → AbortController 暂未支持取消，标记用） */
const organizing = new Set<ID>()

export function registerClassroomIpc(): void {
  /* ---------- ASR 启停与音频流 ---------- */

  ipcMain.handle(IPC.ClassroomStart, (event: IpcMainInvokeEvent, _noteId: ID) =>
    handleResult(async (): Promise<ClassroomStartResult> => {
      const modelDir = configGet('asr.model_dir')
      const hotwords = configGet('asr.hotwords') ?? ''
      if (!modelDir) {
        return { mode: 'manual', message: '未配置语音模型目录，已进入手动转写模式（设置 → 语音引擎）' }
      }
      await asrService.start({
        modelDir,
        hotwords,
        events: {
          onPartial: (text) => safeSend(event.sender, IPC_EVENTS.ClassroomPartial, { text }),
          onFinal: (text) => safeSend(event.sender, IPC_EVENTS.ClassroomFinal, { text })
        }
      })
      return { mode: 'asr' }
    })
  )

  ipcMain.handle(IPC.ClassroomStop, () =>
    handleResult(() => {
      asrService.stop()
      return true
    })
  )

  // 高频音频块：单向 send，不做 invoke 往返（性能）
  ipcMain.on(IPC.ClassroomFeedAudio, (_e, chunk: Uint8Array) => {
    if (!asrService.running || !chunk || chunk.byteLength === 0) return
    const i16 = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
    asrService.feed(f32)
  })

  /* ---------- ASR 状态与目录选择 ---------- */

  ipcMain.handle(IPC.AsrStatus, () =>
    handleResult(async (): Promise<AsrStatus> => {
      const modelDir = configGet('asr.model_dir')
      const inst = await checkSherpaInstalled()
      let modelReady = false
      let missingFiles: string[] = []
      if (modelDir) {
        const found = findModelFiles(modelDir)
        if ('missing' in found) missingFiles = found.missing
        else modelReady = true
      } else {
        missingFiles = ['未配置模型目录']
      }
      return {
        installed: inst.installed,
        moduleError: inst.error,
        modelDir,
        modelReady,
        missingFiles
      }
    })
  )

  ipcMain.handle(IPC.AsrPickDir, () =>
    handleResult(async (): Promise<string | null> => {
      const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    })
  )

  /* ---------- 段落 AI 整理 ---------- */

  ipcMain.handle(IPC.NotesOrganizeSegment, (event: IpcMainInvokeEvent, segmentId: ID) =>
    handleResult(async () => {
      const db = getDb()
      if (organizing.has(segmentId)) return { seg_type: 'other' as SegmentType, organized_text: '', fallback: true }
      organizing.add(segmentId)
      try {
        const seg = db.prepare(
          'SELECT s.raw_text, s.organized_text, n.subject_id, n.activity_id FROM note_segments s JOIN notes n ON s.note_id = n.id WHERE s.id = ?'
        ).get(segmentId) as { raw_text: string; organized_text: string; subject_id: string | null; activity_id: string | null } | undefined
        if (!seg) throw new Error('段落不存在')
        if (!seg.raw_text.trim()) throw new Error('段落无原文可整理')

        // 学科名（含活动关联的学科）
        let subjectName = ''
        if (seg.subject_id) {
          const r = db.prepare('SELECT name FROM subjects WHERE id = ?').get(seg.subject_id) as { name: string } | undefined
          subjectName = r?.name ?? ''
        } else if (seg.activity_id) {
          const r = db.prepare(
            'SELECT s.name FROM activities a LEFT JOIN subjects s ON a.subject_id = s.id WHERE a.id = ?'
          ).get(seg.activity_id) as { name: string | null } | undefined
          subjectName = r?.name ?? ''
        }

        const model = pickModel(null) // 后台任务用默认模型
        const { provider, apiKey } = getProviderWithKey(model.provider_id)
        if (!apiKey) throw new Error('未配置模型服务（设置 → 模型服务），无法自动整理')

        const response = await completeChat(
          { base_url: provider.base_url, api_format: provider.api_format, apiKey },
          model.model_id,
          buildOrganizePrompt(seg.raw_text, subjectName || undefined)
        )
        const parsed = parseOrganizedResponse(response, seg.raw_text)

        db.prepare('UPDATE note_segments SET seg_type = ?, organized_text = ?, updated_at = ? WHERE id = ?').run(
          parsed.seg_type,
          parsed.organized_text,
          Date.now(),
          segmentId
        )
        db.prepare('UPDATE notes SET updated_at = ? WHERE id = (SELECT note_id FROM note_segments WHERE id = ?)').run(Date.now(), segmentId)

        const payload = { segment_id: segmentId, ...parsed }
        safeSend(event.sender, IPC_EVENTS.SegmentOrganized, payload)
        return payload
      } finally {
        organizing.delete(segmentId)
      }
    })
  )
}

function safeSend(wc: WebContents, channel: string, payload: unknown): void {
  try {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  } catch {
    /* 窗口已关闭等 */
  }
}
