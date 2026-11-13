import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  Tray
} from 'electron'
import type { ReminderCapabilities } from '@shared/reminders'
import {
  activeReminder,
  attachReminderRuntime,
  claimSystemReminders,
  finishSystemDelivery,
  publishDueReminders,
  recoverReminderDeliveries,
  reminderSettings,
  type DeliveryBatch
} from './reminders'
import { dbFilePath } from './db'
import { reminderTrayPng } from './reminder-tray-icon'

export interface ReminderRuntime {
  stop: () => void
  keepInBackground: () => boolean
}
export function startReminderRuntime(
  open: (taskId?: string) => void
): ReminderRuntime {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    tray: Tray | undefined,
    error = '',
    database = '',
    testNotice: Notification | undefined
  const notices = new Map<
    string,
    {
      notice: Notification
      batch: DeliveryBatch
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const supported = (): boolean => Notification.isSupported()
  const capabilities = (): ReminderCapabilities => ({
    system_supported: supported(),
    background_active: !!tray,
    packaged: app.isPackaged,
    error
  })
  function ensureTray(): void {
    if (!reminderSettings().value.background_enabled) {
      if (tray && BrowserWindow.getAllWindows().every((w) => !w.isVisible()))
        open()
      tray?.destroy()
      tray = undefined
      return
    }
    if (tray) return
    try {
      const icon = nativeImage.createFromDataURL(reminderTrayPng)
      if (icon.isEmpty()) throw Error('后台提醒图标不可用')
      tray = new Tray(icon)
      tray.setToolTip('LearningAssistant 学习助手 · 后台提醒')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开学习助手与提醒中心', click: () => open() },
          { type: 'separator' },
          { label: '退出学习助手', click: () => app.quit() }
        ])
      )
      tray.on('double-click', () => open())
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      tray?.destroy()
      tray = undefined
    }
  }
  function removeNotice(key: string): void {
    const entry = notices.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    finishSystemDelivery(
      entry.batch,
      'uncertain',
      '系统通知已关闭且未返回展示结果；可手动重试'
    )
    try {
      entry.notice.close()
    } catch {}
    notices.delete(key)
  }
  function send(batch: DeliveryBatch): void {
    if (!supported()) {
      finishSystemDelivery(
        batch,
        'failed',
        '此系统不支持桌面通知；应用内提醒仍可查看'
      )
      return
    }
    try {
      const body =
        batch.items
          .slice(0, 3)
          .map(
            (r) =>
              `${r.title} · ${r.kind === 'due' ? '截止' : '开始'} ${new Date(r.event_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}${r.location ? ' · ' + r.location : ''}`
          )
          .join('\n') +
        (batch.items.length > 3
          ? `\n另有 ${batch.items.length - 3} 项，请打开提醒中心`
          : '')
      const notice = new Notification({
        title:
          batch.items.length === 1
            ? '学习提醒'
            : `学习提醒（${batch.items.length} 项）`,
        body,
        silent: false
      })
      const timeout = setTimeout(() => {
        finishSystemDelivery(
          batch,
          'uncertain',
          '系统未返回展示结果；不会自动重发，可在提醒中心手动重试'
        )
      }, 15000)
      timeout.unref()
      notices.set(batch.attempt, { notice, batch, timer: timeout })
      notice.on?.('show', () => {
        clearTimeout(timeout)
        finishSystemDelivery(batch, 'shown')
      })
      notice.on?.('failed', (_event, reason) => {
        clearTimeout(timeout)
        finishSystemDelivery(
          batch,
          'failed',
          String(reason || '系统通知未能展示')
        )
      })
      notice.on?.('click', () => {
        const current = batch.items
          .map((r) => activeReminder(r.id))
          .filter((r) => r !== null)
        open(current.length === 1 ? current[0]!.task_id : undefined)
      })
      notice.show()
      if (notices.size > 100) removeNotice(notices.keys().next().value!)
    } catch (e) {
      finishSystemDelivery(
        batch,
        'failed',
        e instanceof Error ? e.message : String(e)
      )
    }
  }
  function tick(): void {
    if (stopped) return
    clearTimeout(timer)
    try {
      if (database !== dbFilePath()) {
        for (const key of notices.keys()) removeNotice(key)
        recoverReminderDeliveries()
        database = dbFilePath()
      }
      error = ''
      ensureTray()
      publishDueReminders()
      const settings = reminderSettings().value
      for (const [key, entry] of notices)
        if (
          !settings.enabled ||
          !settings.system_enabled ||
          entry.batch.database !== database ||
          entry.batch.items.some((r) => !activeReminder(r.id))
        )
          removeNotice(key)
      const batch = claimSystemReminders()
      if (batch) send(batch)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      console.warn('提醒检查失败', error)
    }
    timer = setTimeout(tick, 30000)
    timer.unref()
  }
  const test = async (): Promise<string> => {
    if (!supported()) throw Error('此系统不支持桌面通知')
    testNotice?.close()
    return new Promise((resolve) => {
      const n = new Notification({
        title: '学习助手通知测试',
        body: '如果你看到了这条通知，系统通知可以正常展示。应用内提醒始终保存在日程页。'
      })
      testNotice = n
      const timeout = setTimeout(
        () =>
          resolve(
            '系统尚未确认展示，请检查 Windows 通知设置和免打扰。应用内提醒不受影响。'
          ),
        8000
      )
      timeout.unref()
      n.on?.('show', () => {
        clearTimeout(timeout)
        resolve('系统已确认展示测试通知，请同时核对桌面是否可见。')
      })
      n.on?.('failed', (_event, reason) => {
        clearTimeout(timeout)
        resolve(`系统通知失败：${String(reason)}`)
      })
      try {
        n.show()
      } catch (e) {
        clearTimeout(timeout)
        resolve(`系统通知失败：${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }
  const refresh = (): void => {
    if (!stopped) {
      clearTimeout(timer)
      timer = setTimeout(tick, 0)
      timer.unref()
    }
  }
  const detach = attachReminderRuntime({ capabilities, refresh, test })
  recoverReminderDeliveries()
  database = dbFilePath()
  powerMonitor.on('resume', refresh)
  tick()
  return {
    keepInBackground: () =>
      !!tray && reminderSettings().value.background_enabled,
    stop: () => {
      stopped = true
      clearTimeout(timer)
      powerMonitor.removeListener('resume', refresh)
      detach()
      tray?.destroy()
      tray = undefined
      // Do not mark in-flight claims shown. Restart will recover them as uncertain.
      for (const entry of notices.values()) clearTimeout(entry.timer)
      notices.clear()
      try {
        testNotice?.close()
      } catch {}
    }
  }
}
