// Real Electron/SQLite/worker and UI; isolated synthetic tasks. Worker delivery can be held for race tests.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-continuous-')
    ),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 120000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '持续排程验收失败：' + phase)
  }
  console.log('CONTINUOUS_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app, powerMonitor } = electron,
    { Worker } = require('node:worker_threads'),
    { EventEmitter } = require('node:events'),
    root = process.argv[2],
    phase = process.argv[3],
    data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  app.disableHardwareAcceleration()
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  let hold = false
  const held = []
  class ControlledWorker extends EventEmitter {
    constructor(file, options) {
      super()
      this.real = new Worker(file, options)
      this.queued = []
      this.dead = false
      const forward = (name, ...args) => {
        if (this.dead) return
        if (hold) {
          this.queued.push([name, args])
          if (!held.includes(this)) held.push(this)
        } else this.emit(name, ...args)
      }
      this.real.on('message', (d) => forward('message', d))
      this.real.on('error', (e) => forward('error', e))
      this.real.on('exit', (c) => forward('exit', c))
    }
    release() {
      const events = this.queued
      this.queued = []
      for (const [name, args] of events) {
        if (!this.dead) this.emit(name, ...args)
      }
    }
    terminate() {
      this.dead = true
      this.queued = []
      return this.real.terminate()
    }
  }
  class HiddenWindow extends electron.BrowserWindow {
    constructor(o) {
      super({
        ...o,
        show: false,
        webPreferences: {
          ...o.webPreferences,
          offscreen: true,
          backgroundThrottling: false
        }
      })
    }
    show() {}
  }
  const Module = require('node:module'),
    load = Module._load
  Module._load = function (request, parent, main) {
    if (request === 'electron')
      return { ...electron, BrowserWindow: HiddenWindow }
    if (request === 'node:worker_threads')
      return {
        ...load.call(this, request, parent, main),
        Worker: ControlledWorker
      }
    return load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
      console.error('CONTINUOUS_TIMEOUT')
      app.exit(2)
    }, 110000),
    pause = (ms) => new Promise((r) => setTimeout(r, ms))
  app.once('browser-window-created', (_event, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) =>
        win.webContents.executeJavaScript(code).catch((e) => {
          throw Error(e.message + ' 表达式：' + code.slice(0, 500))
        })
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const until = async (check, label) => {
        const end = Date.now() + 12000
        while (!(await check())) {
          if (Date.now() > end) throw Error('等待失败：' + label)
          await pause(35)
        }
      }
      const wait = (code) => until(() => js(code), code)
      const click = (text, scope = '.page') =>
        js(
          `(()=>{const b=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(text)});b.click()})()`
        )
      const set = (label, value) =>
        js(
          `(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
      const state = () => call('calendar', 'continuous'),
        planning = () => call('calendar', 'planning')
      const enable = async (enabled) => {
        const s = await state()
        return call('calendar', 'saveContinuous', {
          ...s.settings,
          enabled,
          horizon_days: 3
        })
      }
      const check = () => call('calendar', 'checkContinuous')
      const options = async (id, patch) => {
        const p = (await planning()).planning.find((p) => p.task_id === id)
        const { revision, ...v } = p
        return call('calendar', 'savePlanning', {
          ...v,
          expected_revision: revision,
          ...patch
        })
      }
      const capture = async (name) => {
        await js(
          'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))'
        )
        await new Promise((r) => {
          win.webContents.once('paint', r)
          win.webContents.invalidate()
        })
        await pause(80)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
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
          assert.equal((await state()).settings.enabled, true)
          await until(
            async () => (await state()).state === 'idle',
            '中断后自动恢复检查'
          )
          const p = await planning()
          assert.ok(p.blocks.some((b) => b.id === saved.lock && b.locked))
          assert.equal(
            (await call('tasks', 'listAll')).find((t) => t.id === saved.fixed)
              .planned_at,
            saved.fixedStart
          )
          assert.ok(p.blocks.some((b) => b.task_id === saved.b))
          assert.equal(
            (await state()).history.length,
            saved.history,
            '完全相同的恢复结果不重复写排程历史'
          )
          await js("location.hash='/review'")
          await wait('!!document.querySelector(".continuous-schedule")')
          await js('document.querySelector(".continuous-schedule").open=true')
          await capture('continuous-recovered.png')
          await enable(false)
          console.log(
            'CONTINUOUS_RESTART_OK enabled scope, locks/fixed tasks, interrupted worker recovery and no duplicate history'
          )
          clearTimeout(deadline)
          app.quit()
          return
        }
        const initial = await state()
        assert.equal(initial.settings.enabled, false)
        const next = new Date()
        next.setDate(next.getDate() + 1)
        next.setHours(9, 0, 0, 0)
        const start = next.getTime(),
          hour = 3600000
        const fixed = await call('tasks', 'create', {
          title: '固定课程',
          planned_at: start,
          planned_end_at: start + hour / 2
        })
        const a = await call('tasks', 'create', {
            title: '自动前置复习',
            due_at: start + 3 * hour
          }),
          b = await call('tasks', 'create', {
            title: '自动综合练习',
            due_at: start + 86400000 + 3 * hour
          })
        const s = (await planning()).settings
        await call('calendar', 'saveSettings', {
          expected_revision: s.revision,
          value: {
            ...s.value,
            buffer_minutes: 0,
            daily_minutes: 180,
            availability: Array.from({ length: 7 }, (_, i) => ({
              weekday: i + 1,
              start: '09:00',
              end: '12:00'
            }))
          }
        })
        const opt = (id) => ({
          task_id: id,
          expected_revision: null,
          enabled: true,
          remaining_minutes: 60,
          priority: 1,
          // This fixture starts tomorrow even when the suite runs before today's availability.
          not_before: start,
          splittable: true,
          min_minutes: 15,
          max_minutes: 90,
          dependencies: []
        })
        await call('calendar', 'savePlanning', opt(a.id))
        await call('calendar', 'savePlanning', {
          ...opt(b.id),
          dependencies: [a.id]
        })
        await js("location.hash='/review'")
        await wait('!!document.querySelector("[aria-label=启用持续自动排程]")')
        await js(
          'document.querySelector(".continuous-schedule").open=true;document.querySelector("[aria-label=启用持续自动排程]").click()'
        )
        await set('持续排程天数', '3')
        await click('保存持续排程设置')
        await until(
          async () =>
            (await state()).state === 'idle' &&
            (await planning()).blocks.length === 2,
          '启用后无需手动预览自动排程'
        )
        let p = await planning()
        const aBlock = p.blocks.find((x) => x.task_id === a.id),
          bBlock = p.blocks.find((x) => x.task_id === b.id)
        assert.equal(aBlock.start_at, start + hour / 2)
        assert.equal(bBlock.start_at, aBlock.end_at)
        assert.equal((await state()).history[0].origin, 'automatic')
        await call('calendar', 'changeBlock', {
          id: aBlock.id,
          expected_revision: aBlock.revision,
          action: 'lock'
        })
        const count = (await state()).history.length
        await check()
        await check()
        assert.equal(
          (await state()).history.length,
          count,
          '相同结果不空转写历史'
        )
        await call('tasks', 'update', a.id, { status: 'done' })
        await until(
          async () =>
            (await planning()).blocks.find((x) => x.task_id === b.id)
              ?.start_at ===
            start + hour / 2,
          '任务完成后自动提前后继'
        )
        assert.ok(
          (await planning()).blocks.some((x) => x.id === aBlock.id && x.locked)
        )
        await call('tasks', 'update', b.id, { due_at: start + hour })
        await until(
          async () =>
            (await state()).state === 'idle' &&
            (await state()).outcome.unplaced?.some((x) => x.task_id === b.id),
          '不可行截止列出未安排原因'
        )
        assert.ok(!(await planning()).blocks.some((x) => x.task_id === b.id))
        assert.equal(
          (await call('tasks', 'listAll')).find((t) => t.id === b.id).due_at,
          start + hour
        )
        await call('tasks', 'update', b.id, {
          due_at: start + 86400000 + 3 * hour
        })
        await check()
        assert.ok((await planning()).blocks.some((x) => x.task_id === b.id))
        // A manual preview is owned by the renderer. Automatic planning waits without overwriting it.
        const range = {
          from: new Date(new Date().setHours(0, 0, 0, 0)).getTime(),
          to: start + 2 * 86400000
        }
        await call('calendar', 'plan', range)
        await options(b.id, { remaining_minutes: 90 })
        const beforeManual = (await planning()).blocks
        assert.equal((await check()).state, 'waiting')
        assert.deepEqual((await planning()).blocks, beforeManual)
        await call('calendar', 'discardPlan')
        await check()
        // Hold a real worker reply, mutate data, then ensure the old result never commits.
        hold = true
        held.length = 0
        await js(
          'window.__continuousPending=window.api.calendar.checkContinuous();true'
        )
        await until(
          () => held.some((w) => w.queued.length),
          '工作线程结果已暂停'
        )
        const beforeStale = (await planning()).blocks
        await options(b.id, { remaining_minutes: 120 })
        hold = false
        for (const w of held) w.release()
        assert.equal((await js('window.__continuousPending')).ok, true)
        assert.deepEqual(
          (await planning()).blocks,
          beforeStale,
          '计算中修改不会写入旧结果'
        )
        await check()
        // Disable while a real worker is in flight.
        hold = true
        held.length = 0
        await js(
          'window.__continuousPending=window.api.calendar.checkContinuous();true'
        )
        await until(() => held.some((w) => w.queued.length), '停用前线程已暂停')
        const beforeDisable = (await planning()).blocks
        await enable(false)
        hold = false
        for (const w of held) w.release()
        await js('window.__continuousPending')
        assert.equal((await state()).state, 'paused')
        assert.deepEqual((await planning()).blocks, beforeDisable)
        // A failed insert must roll back deletions, history, and the successful source checkpoint together.
        await options(b.id, { remaining_minutes: 150 })
        const db = new (require('better-sqlite3'))(
          path.join(data, 'learning-assistant.db')
        )
        db.exec(
          "CREATE TRIGGER continuous_failure BEFORE INSERT ON schedule_blocks BEGIN SELECT RAISE(ABORT,'连续排程故障注入'); END"
        )
        const priorHistory = (await state()).history.length
        await enable(true)
        const failed = await check()
        assert.equal(failed.state, 'error')
        assert.match(failed.error, /故障注入/)
        assert.deepEqual((await planning()).blocks, beforeDisable)
        assert.equal(failed.history.length, priorHistory)
        await click('刷新持续排程')
        await capture('continuous-failure.png')
        db.exec('DROP TRIGGER continuous_failure')
        db.close()
        assert.equal((await check()).state, 'idle')
        await click('刷新持续排程')
        await wait(
          'document.querySelector(".continuous-schedule").textContent.includes("新增")'
        )
        assert.equal(
          await js('document.documentElement.scrollWidth<=innerWidth'),
          true
        )
        await js('document.querySelector(".continuous-history").open=true')
        await capture('continuous-history.png')
        await click('撤销本次并暂停')
        await until(
          async () => !(await state()).settings.enabled,
          '撤销事务同时暂停持续管理'
        )
        assert.deepEqual((await planning()).blocks, beforeDisable)
        powerMonitor.emit('resume')
        await pause(3100)
        assert.equal((await state()).settings.enabled, false)
        // The next worker is interrupted by process exit; restart must re-evaluate durable input.
        await options(b.id, { remaining_minutes: 120 })
        await enable(true)
        await check()
        const history = (await state()).history.length
        hold = true
        held.length = 0
        await js(
          'window.__continuousPending=window.api.calendar.checkContinuous();true'
        )
        await until(() => held.some((w) => w.queued.length), '中断前线程已暂停')
        assert.equal((await state()).state, 'running')
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({
            b: b.id,
            lock: aBlock.id,
            fixed: fixed.id,
            fixedStart: start,
            history
          })
        )
        console.log(
          'CONTINUOUS_NATIVE_OK opt-in UI, autonomous task changes, fixed/locked preservation, impossible deadlines, no-op history, manual preview deferral, stale/disable races, transaction rollback/retry, audit/undo pause and 1024 layout'
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
