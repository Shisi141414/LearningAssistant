// Isolated real Electron/SQLite/IPC/UI, with deterministic OS notification and tray adapters.
// No desktop banners, real user data, login settings, or shutdown settings are touched.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-reminders-')
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const result = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 120000 }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, '提醒验收失败：' + phase)
  }
  console.log('REMINDERS_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app, powerMonitor } = electron,
    { EventEmitter } = require('node:events')
  const root = process.argv[2],
    phase = process.argv[3],
    data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  app.disableHardwareAcceleration()
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  const notices = [],
    trays = [],
    windows = []
  let mode = 'shown'
  class Notice extends EventEmitter {
    static isSupported() {
      return true
    }
    constructor(options) {
      super()
      this.options = options
      this.closed = false
      notices.push(this)
    }
    show() {
      if (mode === 'shown') this.emit('show')
      else if (mode === 'failed') this.emit('failed', {}, '测试适配器拒绝')
    }
    close() {
      this.closed = true
    }
  }
  class TestTray extends EventEmitter {
    constructor(icon) {
      super()
      assert.equal(icon.isEmpty(), false)
      trays.push(this)
      this.destroyed = false
    }
    setToolTip(text) {
      this.tooltip = text
    }
    setContextMenu(menu) {
      this.menu = menu
    }
    destroy() {
      this.destroyed = true
    }
  }
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        show: false,
        webPreferences: {
          ...options.webPreferences,
          offscreen: true,
          backgroundThrottling: false
        }
      })
      this.virtualVisible = false
      windows.push(this)
    }
    // Electron's native getAllWindows excludes subclass instances used by this hidden harness.
    static getAllWindows() {
      return windows.filter((w) => !w.isDestroyed())
    }
    show() {
      this.virtualVisible = true
    }
    hide() {
      this.virtualVisible = false
    }
    isVisible() {
      return this.virtualVisible
    }
    focus() {}
  }
  const Module = require('node:module'),
    load = Module._load
  Module._load = function (request, parent, main) {
    return request === 'electron'
      ? {
          ...electron,
          BrowserWindow: HiddenWindow,
          Notification: Notice,
          Tray: TestTray
        }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('REMINDERS_TIMEOUT')
    app.exit(2)
  }, 110000)
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (check, label) => {
    const end = Date.now() + 12000
    while (!(await check())) {
      if (Date.now() > end) throw Error('等待失败：' + label)
      await pause(25)
    }
  }
  app.once('browser-window-created', (_event, win) =>
    win.webContents.once('did-finish-load', async () => {
      win.webContents.on('console-message', (event) => {
        if (event.level === 'error') console.error('RENDERER', event.message)
      })
      const js = (code) => win.webContents.executeJavaScript(code)
      const wait = (code) => until(() => js(code), code)
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const click = (text, scope = '.page') =>
        js(
          `(()=>{const b=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(text)});b.click()})()`
        )
      const set = (label, value) =>
        js(
          `(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e)throw Error('输入框不存在');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
      const toggle = (label) =>
        js(
          `document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']').click()`
        )
      const navigate = async (route) => {
        await js(`location.hash=${JSON.stringify(route)}`)
        await pause(50)
      }
      const page = () => call('reminders', 'list', { view: 'attention' })
      const configure = async (patch) => {
        const s = await call('reminders', 'settings')
        return call('reminders', 'saveSettings', {
          expected_revision: s.revision,
          value: { ...s.value, ...patch }
        })
      }
      const capture = async (name) => {
        await js(
          'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))'
        )
        await new Promise((resolve) => {
          win.webContents.once('paint', resolve)
          win.webContents.invalidate()
        })
        await pause(80)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      const pulse = async () => {
        powerMonitor.emit('resume')
        await pause(60)
      }
      try {
        await wait('!!window.api')
        await js('window.confirm=()=>true;true')
        win.setMinimumSize(800, 680)
        win.setContentSize(1023, 899)
        await wait('innerWidth===1024')
        if (phase === 'resume') {
          const saved = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          await navigate('/review?reminders=1')
          await wait('!!document.querySelector(".reminder-center[open]")')
          const items = (await page()).items
          assert.equal(
            items.find((r) => r.task_id === saved.crash).system_status,
            'uncertain'
          )
          assert.equal(
            items.find((r) => r.task_id === saved.failed).system_status,
            'failed'
          )
          assert.ok(
            !(await call('reminders', 'list', { view: 'upcoming' })).items.some(
              (r) => r.task_id === saved.completed
            )
          )
          assert.ok(
            (await call('reminders', 'list', { view: 'upcoming' })).items.some(
              (r) => r.task_id === saved.snoozed
            )
          )
          assert.equal(
            (await call('reminders', 'task', saved.future)).start_lead_minutes,
            1
          )
          assert.equal(
            (await call('reminders', 'settings')).value.background_enabled,
            false
          )
          await pulse()
          assert.equal(
            notices.length,
            0,
            '重启不重发已展示、失败或状态不确定的提醒'
          )
          const selector = `.reminder-item[data-reminder-id="${saved.crashReminder}"]`
          await click('重试系统通知', selector)
          await until(
            async () =>
              (await page()).items.find((r) => r.task_id === saved.crash)
                ?.system_status === 'shown',
            '手动重试展示确认'
          )
          assert.equal(notices.length, 1)
          await capture('reminders-recovered.png')
          await configure({ background_enabled: true })
          await until(
            async () =>
              (await call('reminders', 'settings')).capabilities
                .background_active,
            '退出前后台已启用'
          )
          console.log(
            'REMINDERS_RESTART_OK durable options/inbox/snooze, uncertain recovery without duplicate, manual retry'
          )
          clearTimeout(deadline)
          app.quit()
          return
        }
        await navigate('/settings?tab=reminders')
        await wait('!!document.querySelector(".reminder-settings input")')
        assert.equal(
          (await call('reminders', 'settings')).value.system_enabled,
          false
        )
        await set('默认开始提醒提前量', '0')
        await set('默认截止提醒提前量', '0')
        await toggle('启用系统通知')
        await click('保存提醒设置')
        await wait(
          'document.querySelector(".reminder-settings [role=status]")?.textContent.includes("已保存")'
        )
        await click('测试系统通知')
        await wait(
          'document.querySelector(".reminder-settings [role=status]")?.textContent.includes("系统已确认")'
        )
        assert.equal(notices.length, 1)
        assert.equal(
          await js(
            'document.querySelector(".reminder-settings").getBoundingClientRect().width>700&&document.documentElement.scrollWidth<=innerWidth'
          ),
          true
        )
        await capture('reminder-settings.png')
        const n = Date.now() - 1000
        const a = await call('tasks', 'create', {
          title: '力学复习提醒',
          due_at: n,
          location: '六教 301'
        })
        const b = await call('tasks', 'create', {
          title: '热力学复习提醒',
          due_at: n
        })
        await pulse()
        await until(
          async () =>
            (await page()).items.length === 2 &&
            (await page()).items.every((r) => r.system_status === 'shown'),
          '两个提醒已保存并收到展示回执'
        )
        assert.equal(notices.length, 2, '两项合并为一次系统提醒')
        assert.match(notices[1].options.body, /六教 301/)
        notices[1].emit('click')
        await wait(
          'location.hash.includes("/review?reminders=1")&&!!document.querySelector(".reminder-center[open]")'
        )
        assert.equal(
          await js('document.documentElement.scrollWidth<=innerWidth'),
          true
        )
        const aReminder = (await page()).items.find((r) => r.task_id === a.id)
        const bReminder = (await page()).items.find((r) => r.task_id === b.id)
        await click(
          '完成任务',
          `.reminder-item[data-reminder-id="${bReminder.id}"]`
        )
        await until(
          async () => !(await page()).items.some((r) => r.task_id === b.id),
          '完成任务清除关联提醒'
        )
        await click(
          '稍后提醒',
          `.reminder-item[data-reminder-id="${aReminder.id}"]`
        )
        await until(
          async () =>
            (await call('reminders', 'list', { view: 'upcoming' })).items.some(
              (r) => r.task_id === a.id
            ),
          '稍后十分钟保存'
        )
        assert.equal((await page()).items.length, 0)
        const future = await call('tasks', 'create', {
          title: '自定义提前量',
          planned_at: Date.now() + 3600000
        })
        await navigate('/review?task=' + future.id)
        await wait('!!document.querySelector(".task-reminders input")')
        await js('document.querySelector(".task-reminders").open=true')
        await set('任务开始提醒提前量', '1')
        await click('保存任务提醒')
        await wait(
          'document.querySelector(".task-reminders [role=status]")?.textContent==="任务提醒已保存"'
        )
        await set('任务截止提醒提前量', '2')
        await js(
          'window.confirm=()=>false;document.querySelector("[aria-label=关闭日程编辑]").click();true'
        )
        assert.equal(
          await js('!!document.querySelector(".schedule-editor")'),
          true,
          '提醒草稿阻止直接关闭'
        )
        await js('window.confirm=()=>true;true')
        await click('刷新任务提醒')
        await wait(
          'document.querySelector("[aria-label=任务截止提醒提前量]").value===""'
        )
        await capture('task-reminder-options.png')
        const clock = (stamp) => {
          const date = new Date(stamp)
          return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        }
        await configure({
          quiet_enabled: true,
          quiet_start: clock(Date.now() - 60000),
          quiet_end: clock(Date.now() + 30 * 60000)
        })
        const countBeforeQuiet = notices.length
        const quiet = await call('tasks', 'create', {
          title: '免打扰后提醒',
          due_at: Date.now() - 1000
        })
        await pulse()
        assert.equal(
          (await page()).items.find((r) => r.task_id === quiet.id)
            .system_status,
          'pending'
        )
        assert.equal(notices.length, countBeforeQuiet, '免打扰期间没有系统通知')
        await configure({ quiet_enabled: false })
        await until(
          async () =>
            (await page()).items.find((r) => r.task_id === quiet.id)
              ?.system_status === 'shown',
          '结束免打扰立即展示'
        )
        assert.equal(notices.length, countBeforeQuiet + 1)
        notices.at(-1).emit('click')
        await wait(
          'document.querySelector("[aria-label=日程名称]")?.value==="免打扰后提醒"'
        )
        await set('日程名称', '尚未保存的名称')
        notices.at(-1).emit('click')
        await pause(100)
        assert.equal(
          await js('document.querySelector("[aria-label=日程名称]").value'),
          '尚未保存的名称',
          '再次点击同一通知不覆盖当前草稿'
        )
        await js('document.querySelector("[aria-label=关闭日程编辑]").click()')
        // Recheck after task rescheduling invalidates both inbox and old OS banner.
        await call('tasks', 'update', quiet.id, {
          due_at: Date.now() + 7200000
        })
        await pulse()
        assert.ok(!(await page()).items.some((r) => r.task_id === quiet.id))
        assert.equal(notices.at(-1).closed, true)
        mode = 'failed'
        const failed = await call('tasks', 'create', {
          title: '系统拒绝提醒',
          due_at: Date.now() - 1000
        })
        await pulse()
        assert.equal(
          (await page()).items.find((r) => r.task_id === failed.id)
            .system_status,
          'failed'
        )
        mode = 'shown'
        await navigate('/settings?tab=reminders')
        await wait('!!document.querySelector(".reminder-settings input")')
        await toggle('启用关闭窗口后台提醒')
        await click('保存提醒设置')
        await until(
          async () =>
            (await call('reminders', 'settings')).capabilities
              .background_active,
          '后台托盘就绪'
        )
        assert.equal(trays.length, 1)
        win.close()
        assert.equal(win.isDestroyed(), false, '关闭窗口保留后台进程')
        assert.equal(win.isVisible(), false)
        trays[0].emit('double-click')
        await wait('location.hash.includes("/review?reminders=1")')
        assert.equal(win.isVisible(), true, '托盘打开原窗口')
        await configure({ background_enabled: false })
        await until(() => trays[0].destroyed, '关闭后台销毁托盘')
        await navigate('/review?reminders=1')
        await wait('!!document.querySelector(".reminder-center[open]")')
        await click('刷新提醒')
        await capture('reminders-center.png')
        // Persist a claimed delivery then stop without normal shutdown, reproducing a crash mid-send.
        mode = 'silent'
        const crash = await call('tasks', 'create', {
          title: '中断恢复提醒',
          due_at: Date.now() - 1000
        })
        await pulse()
        const crashReminder = (await page()).items.find(
          (r) => r.task_id === crash.id
        )
        assert.equal(crashReminder.system_status, 'claimed')
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({
            crash: crash.id,
            crashReminder: crashReminder.id,
            failed: failed.id,
            completed: b.id,
            snoozed: a.id,
            future: future.id
          })
        )
        console.log(
          'REMINDERS_NATIVE_OK settings/test UI, grouped delivery, click navigation, completion/snooze, custom leads/draft guard, quiet changes, reschedule, failure, tray close/reopen/disable'
        )
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error(error.stack || error)
        try {
          console.error(await js('document.body.innerText'))
          await capture('failure.png')
        } catch {}
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  )
  require(path.resolve('out/main/index.js'))
}
