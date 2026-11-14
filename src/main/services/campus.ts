import { BrowserWindow, session } from 'electron'
import type { Learn2018Helper } from '@robertying/thu-learn-lib'
import type {
  CampusApply,
  CampusPreview,
  CampusSource,
  CampusState
} from '@shared/campus'
import { nanoid } from 'nanoid'
import { dbFilePath } from './db'
import { beginWork, withWork } from './work'
import {
  campusAccount,
  campusHome,
  campusLoginUrl,
  campusReadUrl,
  normalizeCampusSource,
  officialCampusUrl
} from './campus-policy'
import {
  applyCampusTicket,
  buildCampusTicket,
  campusCourses,
  mapCampusCourse,
  storeCampusCourses,
  type CampusTicket
} from './campus-store'

const empty = (): CampusState => ({
  phase: 'disconnected',
  label: '',
  semester: '',
  courses: [],
  busy: false,
  error: ''
})
let state = empty()
let loginWindow: BrowserWindow | null = null
let connection: {
  account: string
  helper: Learn2018Helper
  owner: number
  database: string
} | null = null
let remoteSession: Electron.Session | null = null
let controller = new AbortController()
let generation = 0
let stopping = false
let starting = false
let releaseOwner: (() => void) | null = null
let releaseLogin: (() => void) | null = null
let ticket: {
  value: CampusTicket
  owner: number
  database: string
  expires: number
} | null = null
// Keep this import native: the maintained helper is ESM-only; the main bundle is CJS.
const loadLibrary = new Function(
  'return import("@robertying/thu-learn-lib")'
) as () => Promise<typeof import('@robertying/thu-learn-lib')>

export function campusState(): CampusState {
  if (connection && connection.database !== dbFilePath()) {
    void disconnectCampus()
    return empty()
  }
  if (connection && state.phase === 'connected')
    state.courses = campusCourses(connection.account, state.semester)
  return structuredClone(state)
}
function check(current: number): void {
  if (stopping || current !== generation || controller.signal.aborted)
    throw Error('操作已取消')
}
export function campusDiscard(owner: number): void {
  if (ticket?.owner === owner) ticket = null
}
export async function disconnectCampus(): Promise<CampusState> {
  generation++
  controller.abort()
  controller = new AbortController()
  connection = null
  ticket = null
  state = empty()
  releaseLogin?.()
  releaseLogin = null
  releaseOwner?.()
  releaseOwner = null
  const win = loginWindow,
    ses = remoteSession
  loginWindow = null
  remoteSession = null
  if (win && !win.isDestroyed()) win.destroy()
  if (ses) await Promise.allSettled([ses.clearStorageData(), ses.clearCache()])
  return campusState()
}
export function stopCampus(): void {
  stopping = true
  void disconnectCampus()
}
export async function campusLogin(
  owner: Electron.WebContents
): Promise<CampusState> {
  if (stopping) throw Error('应用正在退出')
  if (state.busy) throw Error('正在读取学校作业，请稍候或断开连接')
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show()
    loginWindow.focus()
    return campusState()
  }
  if (starting) throw Error('正在打开登录窗口，请稍候')
  starting = true
  try {
    const clearing = disconnectCampus()
    const current = generation
    await clearing
    check(current)
    if (owner.isDestroyed() || stopping) throw Error('窗口已关闭')
    const ses = session.fromPartition('campus-' + nanoid(), { cache: false })
    remoteSession = ses
    ses.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    )
    ses.setPermissionCheckHandler(() => false)
    state = { ...empty(), phase: 'login' }
    releaseLogin = beginWork('网络学堂登录')
    let account: string | null = null,
      finishing = false
    const win = new BrowserWindow({
      width: 1080,
      height: 800,
      show: true,
      title: '网络学堂 · 官方登录',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    loginWindow = win
    ses.webRequest.onBeforeRequest(
      { urls: ['https://id.tsinghua.edu.cn/do/off/ui/auth/login/check*'] },
      (details, callback) => {
        try {
          if (
            details.webContentsId === win.webContents.id &&
            details.method === 'POST' &&
            new URL(details.url).pathname === '/do/off/ui/auth/login/check'
          ) {
            account = null
            const data = details.uploadData ?? []
            if (
              data.length &&
              data.every((d) => d.bytes && !d.file && !d.blobUUID) &&
              data.reduce((n, d) => n + (d.bytes?.length ?? 0), 0) <= 65536
            )
              account = campusAccount(Buffer.concat(data.map((d) => d.bytes!)))
          }
        } catch {
          account = null
        } finally {
          callback({ cancel: false })
        }
      }
    )
    const navigation = (e: Electron.Event, url: string) => {
      if (!officialCampusUrl(url)) e.preventDefault()
    }
    win.webContents.on('will-navigate', navigation)
    win.webContents.on('will-redirect', navigation)
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (officialCampusUrl(url)) void win.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })
    const onOwnerClosed = () => {
      if (generation === current) void disconnectCampus()
    }
    owner.once('destroyed', onOwnerClosed)
    releaseOwner = () => owner.removeListener('destroyed', onOwnerClosed)
    win.once('closed', () => {
      if (loginWindow === win) {
        loginWindow = null
        if (state.phase === 'login') void disconnectCampus()
      }
    })
    const fetchRead: typeof fetch = async (input, init) => {
      check(current)
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase()
      if (!campusReadUrl(url, method)) throw Error('不支持的学校读取接口')
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(20000),
        ...(init?.signal ? [init.signal] : [])
      ])
      const response = await ses.fetch(
        input instanceof URL ? input.href : input,
        { ...init, method, credentials: 'include', redirect: 'error', signal }
      )
      check(current)
      return response
    }
    win.webContents.on('did-finish-load', () => {
      if (
        finishing ||
        generation !== current ||
        stopping ||
        !win.webContents.getURL().startsWith(campusHome)
      )
        return
      finishing = true
      void (async () => {
        try {
          const library = await loadLibrary()
          check(current)
          const home = await (await fetchRead(campusHome)).text()
          const csrf = home.match(/&_csrf=([^\s"'<>]+)/)?.[1]
          if (!csrf) {
            state.error = '尚未完成学校认证，请在官方窗口完成登录。'
            return
          }
          if (!account) {
            state.error =
              '请使用学校账号表单登录；当前登录方式无法可靠区分账号。关闭窗口后可重试。'
            return
          }
          const helper = new library.Learn2018Helper({
            fetch: fetchRead,
            requestTimeout: 15000,
            maxConcurrentRequests: 2
          })
          helper.setCSRFToken(csrf)
          await helper.ensureSession()
          const semester = await helper.getCurrentSemester()
          const courses = await helper.getCourseList(semester.id)
          const profile = await helper.getUserInfo()
          check(current)
          if (
            typeof semester.id !== 'string' ||
            !semester.id ||
            semester.id.length > 128 ||
            courses.length > 200 ||
            courses.some(
              (c) =>
                typeof c.id !== 'string' ||
                !c.id ||
                c.id.length > 128 ||
                typeof c.name !== 'string' ||
                !c.name.trim() ||
                c.name.length > 500
            )
          )
            throw Error('无效课程信息')
          const label = [profile.name, profile.department]
            .filter(Boolean)
            .join(' · ')
            .slice(0, 200)
          storeCampusCourses(
            account,
            label,
            semester.id,
            courses.map((c) => ({ id: c.id, title: c.name }))
          )
          connection = {
            account,
            helper,
            owner: owner.id,
            database: dbFilePath()
          }
          state = {
            phase: 'connected',
            label,
            semester: semester.id,
            busy: false,
            error: '',
            courses: campusCourses(account, semester.id)
          }
          loginWindow = null
          releaseLogin?.()
          releaseLogin = null
          if (!win.isDestroyed()) win.destroy()
        } catch {
          if (generation === current && !stopping)
            state.error =
              '学校连接未完成。请检查网络和官方登录状态，关闭窗口后重新连接。'
        } finally {
          finishing = false
        }
      })()
    })
    void win.loadURL(campusLoginUrl).catch(() => {
      if (generation === current)
        state.error = '无法打开学校登录页，请检查网络后重试。'
    })
    return campusState()
  } finally {
    starting = false
  }
}
function connected(owner: number) {
  if (
    !connection ||
    state.phase !== 'connected' ||
    connection.owner !== owner ||
    connection.database !== dbFilePath()
  )
    throw Error('请在当前窗口重新连接网络学堂')
  return connection
}
export function campusMap(
  owner: number,
  input: { id: string; revision: string; subject_id: string | null }
): CampusState {
  const c = connected(owner)
  if (state.busy) throw Error('请等待读取完成后调整课程')
  mapCampusCourse(c.account, state.semester, input)
  ticket = null
  return campusState()
}
export async function campusPreview(
  owner: number,
  ids: string[]
): Promise<CampusPreview> {
  const c = connected(owner),
    current = generation
  if (state.busy) throw Error('正在读取，请稍候')
  const courses = campusCourses(c.account, state.semester).filter((course) =>
    ids.includes(course.id)
  )
  if (
    !courses.length ||
    courses.length !== new Set(ids).size ||
    ids.length > 30
  )
    throw Error('请选择最多 30 门有效课程')
  state.busy = true
  state.error = ''
  ticket = null
  try {
    return await withWork('网络学堂作业读取', async () => {
      await c.helper.ensureSession()
      check(current)
      const sources: CampusSource[] = [],
        failures: string[] = []
      for (const course of courses) {
        check(current)
        try {
          const raw = await c.helper.getHomeworkList(course.id)
          check(current)
          if (raw.length > 2000) throw Error('作业过多')
          // Reject the entire failed course; never partially interpret its records as absence.
          const normalized = raw.map((h) =>
            normalizeCampusSource(
              c.account,
              state.semester,
              course.id,
              course.title,
              h
            )
          )
          sources.push(...normalized)
        } catch {
          check(current)
          failures.push(
            course.title +
              '：读取失败或作业格式无法识别，请稍后重试；已有作业保留。'
          )
        }
      }
      check(current)
      const value = buildCampusTicket(sources, failures)
      ticket = {
        value,
        owner,
        database: dbFilePath(),
        expires: Date.now() + 600000
      }
      return value.preview
    })
  } catch {
    check(current)
    throw Error('无法读取学校作业，请检查网络；登录过期时请断开后重新连接。')
  } finally {
    if (generation === current) state.busy = false
  }
}
export function campusApply(owner: number, input: CampusApply) {
  connected(owner)
  const t = ticket
  if (
    !t ||
    t.owner !== owner ||
    t.database !== dbFilePath() ||
    t.expires < Date.now()
  )
    throw Error('预览已失效，请重新读取')
  const result = applyCampusTicket(t.value, input)
  ticket = null
  return result
}
