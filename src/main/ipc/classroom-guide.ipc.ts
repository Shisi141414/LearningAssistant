import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  classroomGuideAction,
  classroomGuideState,
  saveClassroomGuide
} from '../services/classroom-guide'

export function registerClassroomGuideIpc(): void {
  ipcMain.handle(IPC.ClassroomGuideState, (_e, input) =>
    handleResult(() => classroomGuideState(input.note_id, input.offset))
  )
  ipcMain.handle(IPC.ClassroomGuideSave, (_e, input) =>
    handleResult(() => saveClassroomGuide(input))
  )
  ipcMain.handle(IPC.ClassroomGuideAction, (_e, input) =>
    handleResult(() => classroomGuideAction(input))
  )
}
