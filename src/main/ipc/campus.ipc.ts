import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  campusApply,
  campusDiscard,
  campusLogin,
  campusMap,
  campusPreview,
  campusState,
  disconnectCampus
} from '../services/campus'
import { campusProvenance } from '../services/campus-store'

export function registerCampusIpc(): void {
  ipcMain.handle(IPC.CampusState, () => handleResult(campusState))
  ipcMain.handle(IPC.CampusLogin, (e) =>
    handleResult(() => campusLogin(e.sender))
  )
  ipcMain.handle(IPC.CampusDisconnect, () => handleResult(disconnectCampus))
  ipcMain.handle(IPC.CampusMap, (e, input) =>
    handleResult(() => campusMap(e.sender.id, input))
  )
  ipcMain.handle(IPC.CampusPreview, (e, ids) =>
    handleResult(() => campusPreview(e.sender.id, ids))
  )
  ipcMain.handle(IPC.CampusApply, (e, input) =>
    handleResult(() => campusApply(e.sender.id, input))
  )
  ipcMain.handle(IPC.CampusDiscard, (e) =>
    handleResult(() => campusDiscard(e.sender.id))
  )
  ipcMain.handle(IPC.CampusProvenance, (_e, id) =>
    handleResult(() => campusProvenance(id))
  )
}
