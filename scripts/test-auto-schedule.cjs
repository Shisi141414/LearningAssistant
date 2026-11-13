// Hidden, isolated Electron: worker, typed IPC, real calendar UI, atomic apply/undo and restart.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(
        require('node:os').tmpdir(),
        'learning-assistant-auto-schedule-'
      )
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
    assert.equal(r.status, 0, '自动排程验收失败：' + phase)
  }
  console.log('AUTO_SCHEDULE_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  const data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  app.disableHardwareAcceleration()
  app.setPath('userData', data)
  app.setPath('sessionData', data)
  let saveFile, pickFile
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1200,
        height: 1000,
        show: false,
        webPreferences: {
          ...options.webPreferences,
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
    return request === 'electron'
      ? {
          ...electron,
          BrowserWindow: HiddenWindow,
          dialog: {
            ...electron.dialog,
            showSaveDialog: async () => ({
              canceled: !saveFile,
              filePath: saveFile
            }),
            showOpenDialog: async () => ({
              canceled: !pickFile,
              filePaths: pickFile ? [pickFile] : []
            })
          }
        }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('AUTO_SCHEDULE_TIMEOUT')
    app.exit(2)
  }, 110000)
  app.once('browser-window-created', (_e, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) =>
        win.webContents.executeJavaScript(code).catch((e) => {
          throw Error(e.message + '\n表达式：' + code.slice(0, 400))
        })
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const raw = (method, ...args) =>
        js(
          `window.api.calendar[${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
      const wait = async (code) => {
        const end = Date.now() + 12000
        while (!(await js(code))) {
          if (Date.now() > end)
            throw Error(
              '等待失败：' + code + '\n' + (await js('document.body.innerText'))
            )
          await new Promise((r) => setTimeout(r, 30))
        }
      }
      const click = (label, scope = '.page') =>
        js(
          `(()=>{const b=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('按钮不可用：'+${JSON.stringify(label)});b.click()})()`
        )
      const set = (selector, value) =>
        js(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('没有输入框');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
      const capture = async (name) => {
        await js(
          'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true)))))'
        )
        await new Promise((r) => {
          win.webContents.once('paint', r)
          win.webContents.invalidate()
        })
        await new Promise((r) => setTimeout(r, 80))
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      try {
        await wait('!!window.api')
        await js('window.confirm=()=>true;true')
        if (phase === 'resume') {
          const saved = JSON.parse(
              fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
            ),
            state = await call('calendar', 'planning')
          assert.ok(state.blocks.some((b) => b.id === saved.locked && b.locked))
          assert.ok(state.planning.find((p) => p.task_id === saved.a).enabled)
          assert.deepEqual(
            state.planning.find((p) => p.task_id === saved.b).dependencies,
            [saved.a]
          )
          await js(`location.hash=${JSON.stringify('/review?task=' + saved.a)}`)
          await wait("!!document.querySelector('.task-planning')")
          assert.equal(
            await js(
              "document.querySelector('.task-planning').textContent.includes('已锁定')"
            ),
            true
          )
          console.log(
            'AUTO_SCHEDULE_RESTART_OK settings, dependency, blocks, locks and export tombstones retained'
          )
        } else {
          const start = new Date()
          start.setDate(start.getDate() + 2)
          start.setHours(0, 0, 0, 0)
          const from = start.getTime(),
            to = from + 2 * 86400000,
            hour = (n) => from + n * 3600000,
            datestr = new Date(from).toLocaleDateString('sv-SE')
          let state = await call('calendar', 'planning')
          state = await call('calendar', 'saveSettings', {
            expected_revision: state.settings.revision,
            value: {
              timezone: 'Asia/Shanghai',
              daily_minutes: 120,
              buffer_minutes: 10,
              availability: Array.from({ length: 7 }, (_, i) => ({
                weekday: i + 1,
                start: '08:00',
                end: '12:00'
              }))
            }
          })
          const course = await call('tasks', 'create', {
              title: '固定课程',
              planned_at: hour(9),
              planned_end_at: hour(10),
              location: '六教 6A315'
            }),
            a = await call('tasks', 'create', {
              title: '力学预习',
              due_at: to,
              location: '图书馆'
            }),
            b = await call('tasks', 'create', {
              title: '完成应用题',
              due_at: to
            })
          const options = (id) => ({
            task_id: id,
            expected_revision: null,
            enabled: true,
            remaining_minutes: 120,
            priority: 1,
            not_before: null,
            splittable: true,
            min_minutes: 25,
            max_minutes: 60,
            dependencies: []
          })
          await call('calendar', 'savePlanning', options(a.id))
          await call('calendar', 'savePlanning', {
            ...options(b.id),
            remaining_minutes: 60,
            dependencies: [a.id]
          })
          const cancelled = await js(
            `Promise.all([window.api.calendar.plan(${JSON.stringify({ from, to })}),window.api.calendar.discardPlan()])`
          )
          assert.equal(
            cancelled[0].ok,
            false,
            '取消应终止正在运行的排程工作线程'
          )
          const preview = await call('calendar', 'plan', { from, to })
          assert.equal(preview.unplaced.length, 0)
          assert.ok(preview.added.length >= 3)
          assert.equal(
            (await call('calendar', 'planning')).blocks.length,
            0,
            '预览不写入日历'
          )
          // A preview belongs to its renderer owner, not just its token.
          const other = new electron.BrowserWindow({
            show: false,
            webPreferences: {
              preload: path.resolve('out/preload/index.js'),
              contextIsolation: true,
              nodeIntegration: false
            }
          })
          await other.loadFile(path.resolve('out/renderer/index.html'))
          const foreign = await other.webContents.executeJavaScript(
            `window.api.calendar.applyPlan(${JSON.stringify(preview.token)})`
          )
          assert.equal(foreign.ok, false)
          other.destroy()
          // Fail after an INSERT: transaction must restore all blocks and leave no run.
          const Database = require('better-sqlite3'),
            db = new Database(path.join(data, 'learning-assistant.db'))
          db.exec(
            "CREATE TRIGGER fail_auto_insert BEFORE INSERT ON schedule_blocks BEGIN SELECT RAISE(ABORT,'fixture apply failure'); END;"
          )
          assert.equal((await raw('applyPlan', preview.token)).ok, false)
          assert.equal((await call('calendar', 'planning')).blocks.length, 0)
          db.exec('DROP TRIGGER fail_auto_insert')
          state = await call('calendar', 'applyPlan', preview.token)
          assert.ok(state.latest_run)
          assert.equal(
            state.blocks.reduce(
              (s, b) => s + (b.end_at - b.start_at) / 60000,
              0
            ),
            180
          )
          assert.equal(
            (await call('tasks', 'listAll')).find((t) => t.id === course.id)
              .planned_at,
            hour(9)
          )
          state = await call('calendar', 'undoPlan', state.latest_run.id)
          assert.equal(state.blocks.length, 0)
          state = await call(
            'calendar',
            'applyPlan',
            (await call('calendar', 'plan', { from, to })).token
          )
          const locked = state.blocks.find((b) => b.task_id === a.id)
          state = await call('calendar', 'changeBlock', {
            id: locked.id,
            expected_revision: locked.revision,
            action: 'lock'
          })
          assert.equal(
            (await raw('undoPlan', state.latest_run.id)).ok,
            false,
            '手动锁定后不覆盖修改'
          )
          const lockRevision = state.blocks.find(
            (b) => b.id === locked.id
          ).revision
          let replanned = await call('calendar', 'plan', { from, to })
          assert.ok(!replanned.removed.some((b) => b.id === locked.id))
          state = await call('calendar', 'applyPlan', replanned.token)
          assert.equal(
            state.blocks.find((b) => b.id === locked.id).revision,
            lockRevision
          )
          const stale = await call('calendar', 'plan', { from, to })
          await call('tasks', 'update', a.id, { detail: '手动补充任务要求' })
          assert.equal(
            (await raw('applyPlan', stale.token)).ok,
            false,
            '修改后旧预览失效'
          )
          const overlapping = state.blocks.find((b) => b.task_id === a.id)
          assert.equal(
            (
              await call('calendar', 'save', {
                task: {
                  title: '冲突课程',
                  planned_at: overlapping.start_at,
                  planned_end_at: overlapping.end_at
                }
              })
            ).task,
            null
          )
          saveFile = path.join(root, 'auto-schedule.ics')
          await call('calendar', 'export')
          assert.ok(fs.readFileSync(saveFile, 'utf8').includes('block:'))
          assert.equal(
            (
              fs
                .readFileSync(saveFile, 'utf8')
                .match(/x-learning-assistant-due:/gi) || []
            ).length,
            2,
            '每个任务只导出一次截止，不为每段复制截止'
          )
          pickFile = saveFile
          let imported = await call('calendar', 'preview', { from, to })
          assert.equal(
            imported.duplicates,
            imported.entries.length,
            '导回本机导出的时间块不重复'
          )
          assert.equal(
            (await call('calendar', 'import', imported.token)).added,
            0
          )
          const removed = state.blocks.find((part) => !part.locked)
          state = await call('calendar', 'changeBlock', {
            id: removed.id,
            expected_revision: removed.revision,
            action: 'remove'
          })
          imported = await call('calendar', 'preview', { from, to })
          assert.equal(
            imported.duplicates,
            imported.entries.length,
            '移除后的导出时间块不会复活'
          )
          assert.equal(
            (await call('calendar', 'import', imported.token)).added,
            0
          )
          // Real UI: date navigation, settings and task controls, calendar color/location.
          await js(`location.hash=${JSON.stringify('/review?task=' + a.id)}`)
          await wait(
            "!!document.querySelector('.task-planning')&&!!document.querySelector('.auto-schedule')"
          )
          await js(
            "document.querySelector('.auto-schedule').open=true;document.querySelector('.task-planning').open=true;document.querySelector('.fc-jumpDate-button').click()"
          )
          await wait(
            '!!document.querySelector(\'[aria-label="跳转起始日期"]\')'
          )
          await set('[aria-label="跳转起始日期"]', datestr)
          await click('跳转')
          await wait(
            "document.querySelector('.fc-view-harness').textContent.includes('力学预习')"
          )
          assert.equal(
            await js(
              'document.querySelector(\'[aria-label="日程开始"]\').disabled'
            ),
            true
          )
          assert.ok(
            await js(
              "document.querySelector('.fc-view-harness').textContent.includes('图书馆')"
            )
          )
          const remaining = '.task-planning input[type="number"]'
          await set(remaining, '155')
          await js(
            'window.confirm=()=>false;document.querySelector(\'[aria-label="关闭日程编辑"]\').click()'
          )
          assert.equal(
            await js("!!document.querySelector('.task-planning')"),
            true,
            '未保存的学习安排受到关闭确认保护'
          )
          assert.equal(
            await js(
              "document.querySelector('.task-planning input[type=number]').value"
            ),
            '155'
          )
          await js('window.confirm=()=>true;true')
          await click('保存学习安排', '.task-planning')
          await wait(
            "document.querySelector('.task-planning [role=status]')?.textContent.includes('已保存')"
          )
          await set('[aria-label="自动排程开始日期"]', datestr)
          const last = new Date(to - 1).toLocaleDateString('sv-SE')
          await set('[aria-label="自动排程结束日期"]', last)
          await click('生成排程预览', '.auto-schedule')
          await wait(
            '!!document.querySelector(\'[aria-label="自动排程预览"]\')'
          )
          await js(
            "document.querySelector('[aria-label=\"自动排程预览\"]').scrollIntoView({block:'start'})"
          )
          await capture('auto-schedule-preview.png')
          await click('取消预览', '.auto-schedule')
          await click('生成排程预览', '.auto-schedule')
          await wait(
            '!!document.querySelector(\'[aria-label="自动排程预览"]\')'
          )
          await click('确认应用排程', '.auto-schedule')
          await wait(
            "document.querySelector('.auto-schedule [role=status]')?.textContent.includes('已安排')"
          )
          assert.equal(
            (await call('calendar', 'planning')).blocks
              .filter((part) => part.task_id === a.id)
              .reduce(
                (sum, part) => sum + (part.end_at - part.start_at) / 60000,
                0
              ),
            155
          )
          const beforeUndo = (await call('calendar', 'planning')).blocks.length
          await click('撤销最近排程', '.auto-schedule')
          await wait(
            "document.querySelector('.auto-schedule [role=status]')?.textContent.includes('已撤销')"
          )
          assert.notEqual(
            (await call('calendar', 'planning')).blocks.length,
            beforeUndo
          )
          win.setMinimumSize(800, 680)
          win.setContentSize(1023, 899)
          await wait('window.innerWidth===1024')
          assert.equal(
            await js('document.documentElement.scrollWidth<=window.innerWidth'),
            true,
            '1024 宽度无横向溢出'
          )
          await js(
            "document.querySelector('.auto-schedule').scrollIntoView({block:'start'})"
          )
          await capture('auto-schedule-1024.png')
          state = await call('calendar', 'planning')
          fs.writeFileSync(
            path.join(root, 'checkpoint.json'),
            JSON.stringify({ a: a.id, b: b.id, locked: locked.id })
          )
          assert.ok(state.blocks.some((b) => b.id === locked.id && b.locked))
          db.close()
          console.log(
            'AUTO_SCHEDULE_NATIVE_OK worker, preview owner, rollback/retry, apply/undo, stale rejection, locks, fixed courses, conflicts, ICS tombstones, task UI and 1024 layout'
          )
        }
        clearTimeout(deadline)
        app.exit(0)
      } catch (e) {
        console.error(e.stack || e)
        try {
          await capture('failure.png')
        } catch {}
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  )
  require(path.resolve('out/main/index.js'))
}
