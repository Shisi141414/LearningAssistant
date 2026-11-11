/**
 * main/index.ts —— 主进程入口：窗口、生命周期、IPC 注册
 */
import { app, shell, BrowserWindow, session, dialog } from 'electron'
import { join } from 'node:path'
import { registerAllIpc } from './ipc'
import { closeDb, getDb } from './services/db'
import { safeExternal, trustedRenderer } from './services/security'
import { startOrganizationRecovery } from './services/organizer'
import { stopClassroom } from './ipc/classroom.ipc'
import { stopAllChats } from './ipc/chat.ipc'

let stopRecovery: (() => void) | undefined

function createWindow(): void {
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

  // 外部链接交给系统浏览器，不在应用内导航（防钓鱼/安全）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => { if (!trustedRenderer(url)) event.preventDefault() })

  if (process.env.ELECTRON_RENDERER_URL) {
    // 开发模式：electron-vite dev server
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    // 生产模式：打包产物
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 课堂模式需要麦克风：只放行媒体权限（'media' 含音视频采集），其余默认拒绝
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && trustedRenderer(wc.getURL()) && details.isMainFrame)
  })

  getDb() // 初始化数据库（迁移 + 种子）
  registerAllIpc()
  stopRecovery = startOrganizationRecovery()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => { dialog.showErrorBox('学习助手启动失败', error instanceof Error ? error.message : String(error)); app.quit() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopRecovery?.()
  stopClassroom()
  stopAllChats()
  closeDb()
})
