import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  applySchedule,
  changeScheduleBlock,
  discardSchedulePreview,
  getPlanningState,
  previewSchedule,
  saveScheduleSettings,
  saveTaskPlanning,
  undoSchedule
} from '../services/auto-schedule'
const owners = new Set<number>()
export function registerAutoScheduleIpc(): void {
  ipcMain.handle(IPC.PlanningGet, () => handleResult(getPlanningState))
  ipcMain.handle(IPC.PlanningSettings, (_e, input) =>
    handleResult(() => saveScheduleSettings(input))
  )
  ipcMain.handle(IPC.PlanningTask, (_e, input) =>
    handleResult(() => saveTaskPlanning(input))
  )
  ipcMain.handle(IPC.PlanningBlock, (_e, input) =>
    handleResult(() => changeScheduleBlock(input))
  )
  ipcMain.handle(IPC.PlanningUndo, (_e, id) =>
    handleResult(() => undoSchedule(id))
  )
  ipcMain.handle(IPC.PlanningPreview, (e, input) =>
    handleResult(async () => {
      if (!owners.has(e.sender.id)) {
        const owner = e.sender.id
        owners.add(owner)
        e.sender.once('destroyed', () => {
          discardSchedulePreview(owner)
          owners.delete(owner)
        })
      }
      const result = await previewSchedule(e.sender.id, input)
      if (e.sender.isDestroyed()) {
        discardSchedulePreview(e.sender.id)
        throw Error('日程窗口已关闭')
      }
      return result
    })
  )
  ipcMain.handle(IPC.PlanningApply, (e, token) =>
    handleResult(() => applySchedule(e.sender.id, token))
  )
  ipcMain.handle(IPC.PlanningDiscard, (e) =>
    handleResult(() => {
      discardSchedulePreview(e.sender.id)
      return true
    })
  )
}
