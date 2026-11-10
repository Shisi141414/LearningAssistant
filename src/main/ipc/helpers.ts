/**
 * ipc/helpers.ts —— IPC handler 通用包装
 * 约定：所有 handler 返回 ApiResult<T>，不 reject（渲染进程统一处理错误）
 */
import type { ApiResult } from '@shared/types'

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
