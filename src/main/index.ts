import { stopClassroomGuide } from './services/classroom-guide'
import { stopCampus } from './services/campus'
import { recoverMemoRecognition, stopMemoRecognition } from './services/memo-recognition'
import { startMemoAutoRuntime } from './services/memo-auto-runtime'
/**
 * main/index.ts —— 主进程入口：窗口、生命周期、IPC 注册
 */
import { app, shell, BrowserWindow, session, dialog } from 'electron'
import { join } from 'node:path'
import { registerAllIpc } from './ipc'
import { closeDb, getDb } from './services/db'
import { safeExternal, trustedRenderer } from './services/security'
import { startReminderRuntime, type ReminderRuntime } from './services/reminder-runtime'
import { startContinuousScheduleRuntime } from './services/continuous-schedule-runtime'
import { IPC_EVENTS } from '@shared/ipc-channels'
import { startOrganizationRecovery } from './services/organizer'
import { stopClassroom } from './ipc/classroom.ipc'
import { recoverClassroomAlignment, stopClassroomAlignment } from './services/classroom-alignment'
import { stopAllChats } from './ipc/chat.ipc'
import { startMaterialRecovery, stopMaterialJobs } from './services/materials'
import { stopPix2TextSidecar } from './services/pix2text'
import { stopCalendarJobs } from './services/calendar'
import { stopScheduleJobs } from './services/auto-schedule'
import { declareMaterialProtocol, registerMaterialProtocol } from './services/material-protocol'
import { stopLearningPreparation } from './services/learning-documents'
import { recoverLearningSuggestions, stopLearningSuggestions } from './services/learning-suggestions'
import { recoverNoteSuggestions, stopNoteSuggestions } from './services/note-learning-suggestions'
import { recoverKnowledgeSuggestions, stopKnowledgeSuggestions } from './services/knowledge-suggestions'
import { stopLearningAssets } from './services/learning-assets'
import { stopLearningPackageExports } from './services/learning-package-export'
import { stopLearningPdfs } from './services/learning-pdf'
import { stopLearningPackageImports } from './services/learning-package-import'
import { stopNotePackageImports } from './services/note-package-import'
import { recoverLearningPackageImports } from './services/learning-package-import-store'

declareMaterialProtocol()

let stopRecovery: (() => void) | undefined
let reminderRuntime: ReminderRuntime | undefined
let quitting = false
let stopContinuousRuntime: (() => void) | undefined
let stopMemoAutoRuntime: (() => void) | undefined

function createWindow(route?: string): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'LearningAssistant 学习助手',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全红线（docs/02-architecture.md §2）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要部分 Node 能力（electron-vite cjs 预加载脚本的通行配置）
      webSecurity: true
    },
    show: false
  })

  win.on('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (!quitting && reminderRuntime?.keepInBackground()) {
      event.preventDefault()
      win.hide()
    }
  })

  // 外部链接交给系统浏览器，不在应用内导航（防钓鱼/安全）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => { if (!trustedRenderer(url)) event.preventDefault() })

  if (process.env.ELECTRON_RENDERER_URL) {
    // 开发模式：electron-vite dev server
    void win.loadURL(process.env.ELECTRON_RENDERER_URL + (route ? '#' + route : ''))
  } else {
    // 生产模式：打包产物
    void win.loadFile(join(__dirname, '../renderer/index.html'), route ? { hash: route } : undefined)
  }
}

app.whenReady().then(async () => {
  // 课堂模式需要麦克风：只放行媒体权限（'media' 含音视频采集），其余默认拒绝
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && trustedRenderer(wc.getURL()) && details.isMainFrame)
  })

  getDb() // 初始化数据库（迁移 + 种子）
  await recoverLearningPackageImports()
  getDb().prepare("UPDATE classroom_sessions SET ended_at = ?, end_reason = 'interrupted' WHERE ended_at IS NULL").run(Date.now())
  registerAllIpc()
  registerMaterialProtocol()
  recoverClassroomAlignment()
  stopRecovery = startOrganizationRecovery()
  startMaterialRecovery()
  recoverLearningSuggestions()
  recoverNoteSuggestions()
  recoverKnowledgeSuggestions()
  recoverMemoRecognition()
  createWindow()
  if (process.platform === 'win32') app.setAppUserModelId('cn.tsinghua.learningassistant')
  reminderRuntime = startReminderRuntime((task_id) => {
    const win = BrowserWindow.getAllWindows().find(
      w => !w.isDestroyed() && trustedRenderer(w.webContents.getURL())
    )
    if (!win) {
      createWindow('/review?reminders=1' + (task_id ? '&task=' + encodeURIComponent(task_id) : ''))
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send(IPC_EVENTS.ReminderOpen, task_id ? { task_id } : {})
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  stopContinuousRuntime = startContinuousScheduleRuntime()
  stopMemoAutoRuntime = startMemoAutoRuntime()
}).catch((error) => { dialog.showErrorBox('学习助手启动失败', error instanceof Error ? error.message : String(error)); app.quit() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  stopCampus()
  stopClassroomGuide(true)
  reminderRuntime?.stop()
  stopContinuousRuntime?.()
  stopMemoAutoRuntime?.()
  stopRecovery?.()
  stopClassroomAlignment(true)
  stopClassroom()
  stopAllChats()
  stopMaterialJobs()
  stopCalendarJobs()
  stopScheduleJobs()
  stopPix2TextSidecar()
  stopLearningPreparation()
  stopLearningAssets()
  stopLearningPackageExports()
  stopLearningPdfs()
  stopLearningPackageImports()
  stopNotePackageImports()
  stopLearningSuggestions()
  stopNoteSuggestions()
  stopKnowledgeSuggestions()
  stopMemoRecognition()
  closeDb()
})
