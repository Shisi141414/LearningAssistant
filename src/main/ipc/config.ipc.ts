/**
 * ipc/config.ipc.ts —— KV 配置与存储位置管理
 */
import { ipcMain, dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { StorageInfo } from '@shared/types'
import { configGet, configSet } from '../services/config'
import { storageInfo, migrateStorage, resetStorage } from '../services/storage'
import { handleResult } from './helpers'

export function registerConfigIpc(): void {
  ipcMain.handle(IPC.ConfigGet, (_e, key: string) => handleResult(() => configGet(key)))

  ipcMain.handle(IPC.ConfigSet, (_e, key: string, value: string | null) =>
    handleResult(() => {
      configSet(key, value)
      return true
    })
  )

  ipcMain.handle(IPC.StorageInfo, () => handleResult((): StorageInfo => storageInfo()))

  ipcMain.handle(IPC.StoragePick, () =>
    handleResult(async (): Promise<string | null> => {
      const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    })
  )

  ipcMain.handle(IPC.StorageMigrate, (_e, newDir: string) =>
    handleResult((): StorageInfo => migrateStorage(newDir))
  )

  ipcMain.handle(IPC.StorageReset, () =>
    handleResult((): StorageInfo => resetStorage())
  )
}
