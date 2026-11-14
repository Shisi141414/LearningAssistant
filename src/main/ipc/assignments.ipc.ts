import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  archiveAssignment,
  getAssignment,
  listAssignments,
  saveAssignment
} from '../services/assignments'

export function registerAssignmentsIpc(): void {
  ipcMain.handle(IPC.AssignmentsList, (_e, input) =>
    handleResult(() => listAssignments(input))
  )
  ipcMain.handle(IPC.AssignmentsGet, (_e, id) =>
    handleResult(() => getAssignment(id))
  )
  ipcMain.handle(IPC.AssignmentsSave, (_e, input) =>
    handleResult(() => saveAssignment(input))
  )
  ipcMain.handle(IPC.AssignmentsArchive, (_e, input) =>
    handleResult(() => archiveAssignment(input))
  )
}
