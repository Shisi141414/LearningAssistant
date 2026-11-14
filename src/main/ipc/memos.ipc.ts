import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  listMemos,
  memoDetail,
  saveMemo,
  archiveMemo,
  importInspiration,
  previewMemoRoute,
  applyMemoRoute,
  undoMemoRoute,
  memoReferences
} from '../services/memos'
import {
  recognizeMemo,
  cancelMemoRecognition
} from '../services/memo-recognition'

export function registerMemosIpc(): void {
  ipcMain.handle(IPC.MemosList, (_e, input) =>
    handleResult(() => listMemos(input))
  )
  ipcMain.handle(IPC.MemosGet, (_e, id) => handleResult(() => memoDetail(id)))
  ipcMain.handle(IPC.MemosSave, (_e, input) =>
    handleResult(() => saveMemo(input))
  )
  ipcMain.handle(IPC.MemosArchive, (_e, input) =>
    handleResult(() => archiveMemo(input))
  )
  ipcMain.handle(IPC.MemosInspiration, (_e, id) =>
    handleResult(() => importInspiration(id))
  )
  ipcMain.handle(IPC.MemosPreview, (_e, input) =>
    handleResult(() => previewMemoRoute(input))
  )
  ipcMain.handle(IPC.MemosApply, (_e, input) =>
    handleResult(() => applyMemoRoute(input))
  )
  ipcMain.handle(IPC.MemosUndo, (_e, id) =>
    handleResult(() => undoMemoRoute(id))
  )
  ipcMain.handle(IPC.MemosReferences, (_e, input) =>
    handleResult(() => memoReferences(input))
  )
  ipcMain.handle(IPC.MemosRecognize, (_e, input) =>
    handleResult(() => recognizeMemo(input))
  )
  ipcMain.handle(IPC.MemosCancel, (_e, id) =>
    handleResult(() => cancelMemoRecognition(id))
  )
}
