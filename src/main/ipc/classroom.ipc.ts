/**
 * ipc/classroom.ipc.ts —— 课堂模式：ASR 启停/喂数据 + 段落 AI 整理
 */
import { dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type { AsrStatus, ClassroomStartResult, ID } from '@shared/types'
import { getDb } from '../services/db'
import { configGet } from '../services/config'
import { asrService, findModelFiles, checkSherpaInstalled } from '../services/asr'
import { organizeSegment, retryPending } from '../services/organizer'
import { addSegment } from '../services/segments'
import { beginWork } from '../services/work'
import { ipcMain, handleResult } from './helpers'
import { nanoid } from 'nanoid'
import { calibrateClassroom, classroomPosition, materialAnchor } from '../services/classroom-materials'

let active: { noteId: ID; sessionId: ID; sender: WebContents; release: () => void; onDestroyed: () => void } | null = null
export function stopClassroom(): void {
  try { asrService.stop() } finally {
    if (active) {
      getDb().prepare("UPDATE classroom_sessions SET ended_at = ?, end_reason = 'stopped' WHERE id = ?").run(Date.now(), active.sessionId)
      active.sender.removeListener('destroyed', active.onDestroyed); active.release(); active = null
    }
  }
}

export function registerClassroomIpc(): void {
  ipcMain.handle(IPC.ClassroomPosition, (_e, noteId: ID) => handleResult(() => classroomPosition(noteId)))
  ipcMain.handle(IPC.ClassroomCalibrate, (_e, input: { note_id: ID; block_id: ID | null }) => handleResult(() => {
    if (active && active.noteId !== input.note_id) throw new Error('请先结束另一场课堂，再设置此笔记的讲授位置')
    if (input.block_id) materialAnchor(input.block_id)
    // 未结束的尾句先归属旧位置，再切换后续段落的来源。
    if (active?.noteId === input.note_id) asrService.flush()
    return calibrateClassroom(input.note_id, input.block_id, active?.sessionId)
  }))
  /* ---------- ASR 启停与音频流 ---------- */

  ipcMain.handle(IPC.ClassroomStart, (event: IpcMainInvokeEvent, noteId: ID) =>
    handleResult(async (): Promise<ClassroomStartResult> => {
      if (active) throw new Error('已有课堂正在进行，请先结束')
      if (!getDb().prepare('SELECT 1 FROM notes WHERE id = ?').get(noteId)) throw new Error('课堂笔记不存在')
      const onDestroyed = (): void => { if (active?.sender === event.sender) stopClassroom() }
      const sessionId = nanoid()
      getDb().prepare('INSERT INTO classroom_sessions (id, note_id, started_at) VALUES (?, ?, ?)').run(sessionId, noteId, Date.now())
      active = { noteId, sessionId, sender: event.sender, release: beginWork('课堂记录'), onDestroyed }
      event.sender.once('destroyed', onDestroyed)
      const modelDir = configGet('asr.model_dir')
      const hotwords = configGet('asr.hotwords') ?? ''
      if (!modelDir) {
        return { mode: 'manual', message: '未配置语音模型目录，已进入手动转写模式（设置 → 语音引擎）' }
      }
      try { await asrService.start({
        modelDir,
        hotwords,
        events: {
          onPartial: (text) => safeSend(event.sender, IPC_EVENTS.ClassroomPartial, { text }),
          onFinal: (text) => {
            const segment = addSegment({ note_id: noteId, raw_text: text })
            safeSend(event.sender, IPC_EVENTS.ClassroomFinal, { text, segment })
            if (segment.organize_status === 'pending') void organizeSegment(segment.id).then(result => safeSend(event.sender, IPC_EVENTS.SegmentOrganized, result)).catch(() => undefined)
          }
        }
      }) } catch (error) {
        asrService.stop()
        return { mode: 'manual', message: `语音引擎未能启动，已保留课堂与教材位置，可手动转写：${error instanceof Error ? error.message : String(error)}` }
      }
      return { mode: 'asr' }
    })
  )

  ipcMain.handle(IPC.ClassroomStop, () =>
    handleResult(() => {
      stopClassroom()
      return true
    })
  )

  ipcMain.handle(IPC.ClassroomFlush, () => handleResult(() => { asrService.flush(); return true }))
  ipcMain.handle(IPC.NotesRetryPending, (_event, noteId?: ID) => handleResult(() => retryPending(noteId, true)))

  // 高频音频块：单向 send，不做 invoke 往返（性能）
  ipcMain.on(IPC.ClassroomFeedAudio, (event, chunk: Uint8Array) => {
    if (active?.sender !== event.sender || !asrService.running || !chunk || chunk.byteLength === 0) return
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
      const payload = await organizeSegment(segmentId)
      safeSend(event.sender, IPC_EVENTS.SegmentOrganized, payload)
      return payload
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
