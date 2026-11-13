import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  addTaskResource,
  editTaskResource,
  listTaskResources,
  removeTaskResource,
  taskResourceBacklinks
} from '../services/task-resources'

export function registerTaskResourcesIpc(): void {
  ipcMain.handle(IPC.TaskResourcesList, (_e, input) =>
    handleResult(() => listTaskResources(input))
  )
  ipcMain.handle(IPC.TaskResourcesBacklinks, (_e, input) =>
    handleResult(() => taskResourceBacklinks(input))
  )
  ipcMain.handle(IPC.TaskResourcesAdd, (_e, input) =>
    handleResult(() => addTaskResource(input))
  )
  ipcMain.handle(IPC.TaskResourcesEdit, (_e, input) =>
    handleResult(() => editTaskResource(input))
  )
  ipcMain.handle(IPC.TaskResourcesRemove, (_e, input) =>
    handleResult(() => removeTaskResource(input))
  )
}
