/**
 * ipc/helpers.ts —— IPC handler 通用包装
 * 约定：所有 handler 返回 ApiResult<T>，不 reject（渲染进程统一处理错误）
 */
import type { ApiResult } from '@shared/types'
import { ipcMain as nativeIpc } from 'electron'
import { trustedRenderer, validateIpc } from '../services/security'

function authorize(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, channel: string, args: unknown[]): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !trustedRenderer(event.senderFrame.url)) throw new Error('请求来源不受信任')
  validateIpc(channel, args)
}

/** 所有业务 handler 经过同一个来源与载荷边界，类型声明不能代替运行时校验。 */
export const ipcMain = {
  handle(channel: string, listener: Parameters<typeof nativeIpc.handle>[1]): void {
    nativeIpc.handle(channel, async (event, ...args) => {
      try { authorize(event, channel, args); return await listener(event, ...args) } catch (error) { return fail(error) }
    })
  },
  on(channel: string, listener: Parameters<typeof nativeIpc.on>[1]): void {
    nativeIpc.on(channel, (event, ...args) => {
      try { authorize(event, channel, args); listener(event, ...args) } catch { /* 无效或过大的音频帧直接丢弃。 */ }
    })
  }
}

export function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

export function fail(error: unknown): ApiResult<never> {
  const msg = error instanceof Error ? error.message : String(error)
  return { ok: false, error: msg }
}

/** 包装 ipcMain.handle，自动 try/catch */
export function handleResult<T>(fn: () => T | Promise<T>): Promise<ApiResult<T>> {
  return (async () => {
    try {
      return ok(await fn())
    } catch (e) {
      return fail(e)
    }
  })()
}
