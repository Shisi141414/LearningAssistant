import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  actOnReminder,
  listReminders,
  reminderSettings,
  requestReminderTest,
  saveReminderSettings,
  saveTaskReminderOptions,
  taskReminderOptions
} from '../services/reminders'
export function registerRemindersIpc(): void {
  ipcMain.handle(IPC.RemindersSettings, () => handleResult(reminderSettings))
  ipcMain.handle(IPC.RemindersSaveSettings, (_e, input) =>
    handleResult(() => saveReminderSettings(input))
  )
  ipcMain.handle(IPC.RemindersTask, (_e, id) =>
    handleResult(() => taskReminderOptions(id))
  )
  ipcMain.handle(IPC.RemindersSaveTask, (_e, input) =>
    handleResult(() => saveTaskReminderOptions(input))
  )
  ipcMain.handle(IPC.RemindersList, (_e, input) =>
    handleResult(() => listReminders(input))
  )
  ipcMain.handle(IPC.RemindersAction, (_e, input) =>
    handleResult(() => actOnReminder(input))
  )
  ipcMain.handle(IPC.RemindersTest, () => handleResult(requestReminderTest))
}
