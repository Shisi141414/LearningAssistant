import { dialog } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { CalendarRange, CalendarImportOptions } from '@shared/calendar'
import { ipcMain, handleResult } from './helpers'
import {
  previewCalendar,
  importCalendar,
  exportCalendar,
  discardCalendarPreview
} from '../services/calendar'

const observedWindows = new WeakSet<Electron.WebContents>()

export function registerCalendarIpc(): void {
  ipcMain.handle(IPC.CalendarPreview, (event, range: CalendarRange) =>
    handleResult(async () => {
      if (!observedWindows.has(event.sender)) {
        observedWindows.add(event.sender)
        event.sender.once('destroyed', () => discardCalendarPreview(event.sender.id))
      }
      const selected = await dialog.showOpenDialog({
        title: '导入课表',
        properties: ['openFile'],
        filters: [{ name: 'ICS 日历', extensions: ['ics'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return null
      if (event.sender.isDestroyed()) throw new Error('日程窗口已关闭')
      const result = await previewCalendar(selected.filePaths[0], range, event.sender.id)
      if (event.sender.isDestroyed()) {
        discardCalendarPreview(event.sender.id)
        throw new Error('日程窗口已关闭')
      }
      return result
    })
  )
  ipcMain.handle(IPC.CalendarImport, (event, token: string, options?: CalendarImportOptions) =>
    handleResult(() => importCalendar(token, event.sender.id, options))
  )
  ipcMain.handle(IPC.CalendarDiscard, (event) =>
    handleResult(() => {
      discardCalendarPreview(event.sender.id)
      return true
    })
  )
  ipcMain.handle(IPC.CalendarExport, () =>
    handleResult(async () => {
      const selected = await dialog.showSaveDialog({
        title: '导出全部日程为 ICS',
        defaultPath: '学习日程.ics',
        filters: [{ name: 'ICS 日历', extensions: ['ics'] }]
      })
      return selected.canceled || !selected.filePath ? null : exportCalendar(selected.filePath)
    })
  )
}
