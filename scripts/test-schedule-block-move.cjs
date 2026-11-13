// Hidden, isolated Electron: worker, typed IPC, real calendar UI, atomic apply/undo and restart.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-block-move-')
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
    assert.equal(r.status, 0, '时间块调整验收失败：' + phase)
  }
  console.log('BLOCK_MOVE_NATIVE_ROOT ' + root)
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
    console.error('BLOCK_MOVE_TIMEOUT')
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
      const pause = (ms) => new Promise((r) => setTimeout(r, ms))
      const inputTime = (n) => {
        const d = new Date(n)
        return new Date(n - d.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      }
      const blocks = async () => (await call('calendar', 'planning')).blocks
      const closeDialog = async () => {
        await js(
          'document.querySelector("[aria-label=关闭时间块调整]").click()'
        )
        await wait('!document.querySelector(".schedule-block-dialog")')
      }
      const drag = async (resize, hours) => {
        await js(
          'document.querySelector(".schedule-calendar").scrollIntoView({block:"start"})'
        )
        await js(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))'
        )
        await pause(120)
        await js(
          "document.querySelector('[id^=\"calendar-event-block:\"]').closest('.fc-event').setAttribute('data-block-fixture','1')"
        )
        await js(
          'document.querySelector("[data-block-fixture]").scrollIntoView({block:"center"})'
        )
        await js(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))'
        )
        await pause(120)
        if (resize) {
          const hover = await js(
            '(()=>{const r=document.querySelector("[data-block-fixture]").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()'
          )
          win.webContents.sendInputEvent({ type: 'mouseMove', ...hover })
          await pause(100)
        }
        const points = await js(`(()=>{
          const el=document.querySelector('[data-block-fixture]')||[...document.querySelectorAll('.fc-event')].find(e=>e.querySelector('[id^="calendar-event-block:"]'));
          if(!el)throw Error('没有学习时间块');
          const handle=${resize} ? el.querySelector('.fc-event-resizer-end') : el;
          if(!handle)throw Error('没有拉伸柄');
          const r=handle.getBoundingClientRect(),a=document.querySelector('[data-time="10:00:00"]').getBoundingClientRect(),b=document.querySelector('[data-time="11:00:00"]').getBoundingClientRect();
          return {x:Math.round(r.x+r.width/2),y:Math.round(${resize}?r.y+r.height/2:r.y+12),dy:(b.y-a.y)*${hours}};
        })()`)
        assert.equal(
          await js(
            `!!document.elementFromPoint(${points.x},${points.y})?.closest('[data-block-fixture]')`
          ),
          true,
          '拖动起点必须命中屏幕内的学习块'
        )
        win.webContents.sendInputEvent({
          type: 'mouseMove',
          x: points.x,
          y: points.y
        })
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          button: 'left',
          clickCount: 1,
          x: points.x,
          y: points.y
        })
        for (let i = 1; i <= 15; i++) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: points.x,
            y: Math.round(points.y + (points.dy * i) / 15),
            movementX: 0,
            movementY: Math.round(points.dy / 15)
          })
          await pause(25)
        }
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          button: 'left',
          clickCount: 1,
          x: points.x,
          y: Math.round(points.y + points.dy)
        })
        await wait('!!document.querySelector(".schedule-block-dialog[open]")')
      }
      try {
        await wait('!!window.api')
        await js('window.confirm=()=>true;true')
        if (phase === 'resume') {
          const saved = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          await pause(4200)
          const retained = (await blocks()).find((b) => b.id === saved.id)
          assert.equal(retained.locked, true)
          assert.equal(retained.start_at, saved.start)
          const history = await call('calendar', 'continuous')
          assert.equal(history.history[0].added[0].id, saved.id)
          assert.equal(history.history[0].removed[0].id, saved.id)
          const undone = await call(
            'calendar',
            'undoPlan',
            history.history[0].id
          )
          assert.equal(
            undone.blocks.find((b) => b.id === saved.id).start_at,
            saved.before
          )
          assert.equal(
            (await call('calendar', 'continuous')).settings.enabled,
            false
          )
          console.log(
            'BLOCK_MOVE_RESTART_OK moved identity/lock/history retained, autonomous replan preserves manual position, undo restores and pauses'
          )
        } else {
          const date = new Date()
          date.setDate(date.getDate() + 2)
          date.setHours(0, 0, 0, 0)
          const base = +date,
            hour = (n) => base + n * 3600000,
            datestr = date.toLocaleDateString('sv-SE')
          const task = await call('tasks', 'create', {
            title: '手动安排的学习任务',
            due_at: hour(20)
          })
          let state = await call('calendar', 'planning')
          await call('calendar', 'saveSettings', {
            expected_revision: state.settings.revision,
            value: {
              timezone: 'Asia/Shanghai',
              daily_minutes: 120,
              buffer_minutes: 0,
              availability: Array.from({ length: 7 }, (_, i) => ({
                weekday: i + 1,
                start: '08:00',
                end: '18:00'
              }))
            }
          })
          await call('calendar', 'savePlanning', {
            task_id: task.id,
            expected_revision: null,
            enabled: true,
            remaining_minutes: 60,
            priority: 1,
            not_before: null,
            splittable: false,
            min_minutes: 25,
            max_minutes: 60,
            dependencies: []
          })
          state = await call(
            'calendar',
            'applyPlan',
            (await call('calendar', 'plan', { from: base, to: hour(24) })).token
          )
          const original = state.blocks[0]
          assert.equal(original.start_at, hour(8))
          await call('tasks', 'create', {
            title: '不能忽略检查的固定课程',
            planned_at: hour(10),
            planned_end_at: hour(11)
          })
          await js(`location.hash=${JSON.stringify('/review?task=' + task.id)}`)
          await wait('!!document.querySelector(".task-planning")')
          await js(
            'document.querySelector(".fc-timeGridDay-button").click();document.querySelector(".fc-jumpDate-button").click()'
          )
          await set('[aria-label="跳转起始日期"]', datestr)
          await click('跳转')
          await wait('!!document.querySelector(".fc-event-draggable")')
          await drag(false, 3)
          assert.equal(
            await js('document.querySelector("[aria-label=时间块开始]").value'),
            inputTime(hour(11))
          )
          await closeDialog()
          assert.deepEqual(await blocks(), [original], '取消拖动不写入')
          await js(
            "document.querySelector('[id^=\"calendar-event-block:\"]').closest('.fc-event').click()"
          )
          await wait('!!document.querySelector(".task-planning")')
          await js('document.querySelector(".task-planning").open=true')
          await js(
            "document.querySelector('[id^=\"calendar-event-block:\"]').closest('.fc-event').click()"
          )
          await wait('!!document.querySelector(".task-planning")')
          await js('document.querySelector(".task-planning").open=true')
          await click('调整时间', '.task-planning')
          await set('[aria-label="时间块开始"]', inputTime(hour(10)))
          await set('[aria-label="时间块结束"]', inputTime(hour(11)))
          await click('检查时间调整', '.schedule-block-dialog')
          await wait(
            'document.querySelector(".block-move-report")?.textContent.includes("固定课程")'
          )
          assert.equal(
            await js(
              '[...document.querySelector(".schedule-block-dialog").querySelectorAll("button")].find(b=>b.textContent.includes("确认调整")).disabled'
            ),
            true
          )
          await js(
            'document.querySelector("[aria-label=忽略时间块冲突]").click()'
          )
          await capture('block-move-conflict.png')
          await click('确认调整并锁定', '.schedule-block-dialog')
          await wait('!document.querySelector(".schedule-block-dialog")')
          let moved = (await blocks())[0]
          assert.equal(moved.id, original.id)
          assert.equal(moved.locked, true)
          assert.equal(moved.start_at, hour(10))
          assert.equal(
            (await call('tasks', 'listAll')).find((t) => t.id === task.id)
              .due_at,
            hour(20)
          )
          await js(
            "document.querySelector('[id^=\"calendar-event-block:\"]').closest('.fc-event').click()"
          )
          await wait('!!document.querySelector(".task-planning")')
          await js('document.querySelector(".task-planning").open=true')
          await click('调整时间', '.task-planning')
          await set('[aria-label="时间块开始"]', inputTime(hour(12)))
          await set('[aria-label="时间块结束"]', inputTime(hour(13)))
          await click('检查时间调整', '.schedule-block-dialog')
          await wait('!!document.querySelector(".block-move-report")')
          await call('tasks', 'update', task.id, { due_at: hour(21) })
          await click('确认调整并锁定', '.schedule-block-dialog')
          await wait(
            'document.querySelector(".schedule-block-dialog [role=alert]")?.textContent.includes("已改变")'
          )
          assert.equal(
            await js('document.querySelector("[aria-label=时间块开始]").value'),
            inputTime(hour(12))
          )
          assert.equal((await blocks())[0].start_at, hour(10))
          await closeDialog()
          await call('calendar', 'changeBlock', {
            id: moved.id,
            expected_revision: moved.revision,
            action: 'unlock'
          })
          await js('location.hash="/notes"')
          await wait('!document.querySelector(".fc")')
          await js(`location.hash=${JSON.stringify('/review?task=' + task.id)}`)
          await wait('!!document.querySelector(".fc")')
          await js(
            'document.querySelector(".fc-timeGridDay-button").click();document.querySelector(".fc-jumpDate-button").click()'
          )
          await set('[aria-label="跳转起始日期"]', datestr)
          await click('跳转')
          await wait('!!document.querySelector(".fc-event-resizer-end")')
          await drag(true, 0.5)
          assert.equal(
            await js('document.querySelector("[aria-label=时间块结束]").value'),
            inputTime(hour(11.5))
          )
          await closeDialog()
          assert.equal((await blocks())[0].end_at, hour(11))
          await drag(false, 2)
          await click('检查时间调整', '.schedule-block-dialog')
          await wait('!!document.querySelector(".block-move-report")')
          await click('确认调整并锁定', '.schedule-block-dialog')
          await wait('!document.querySelector(".schedule-block-dialog")')
          moved = (await blocks())[0]
          assert.equal(moved.start_at, hour(12))
          assert.equal(moved.locked, true)
          const control = await call('calendar', 'continuous')
          await call('calendar', 'saveContinuous', {
            ...control.settings,
            enabled: true,
            horizon_days: 4
          })
          await call('calendar', 'checkContinuous')
          assert.equal(
            (await blocks()).find((b) => b.id === original.id).start_at,
            hour(12)
          )
          // Freeze renderer time to 21:00 today, then verify visible geometry rather than only a scroll argument.
          await js(
            `window.__RealDate=Date;window.__clock=Date.now();window.__clock=new __RealDate(new __RealDate().setHours(21,0,0,0)).getTime();window.Date=class extends __RealDate{constructor(...args){super(...(args.length?args:[window.__clock]))}static now(){return window.__clock}};location.hash='/notes';true`
          )
          await wait('!document.querySelector(".fc")')
          await js('location.hash="/review"')
          await wait('!!document.querySelector(".fc-timeGridWeek-view")')
          const geometry = `(()=>{const line=document.querySelector('.fc-timegrid-now-indicator-line');if(!line)return null;const r=line.getBoundingClientRect(),s=line.closest('.fc-scroller'),v=s.getBoundingClientRect();return {visible:r.top>=Math.max(0,v.top)&&r.top<Math.min(v.bottom,document.querySelector(".quickbar").getBoundingClientRect().top)&&v.bottom<=document.querySelector(".quickbar").getBoundingClientRect().top,remaining:s.scrollHeight-s.scrollTop-s.clientHeight,top:r.top-v.top,height:v.height,scroll:s.scrollTop}})()`
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          await capture('calendar-week-2100.png')
          await js('document.querySelector(".fc-timeGridDay-button").click()')
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          win.setMinimumSize(800, 680)
          win.setContentSize(1023, 899)
          await wait('innerWidth===1024')
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          await capture('calendar-day-2100.png')
          assert.equal(
            await js('document.documentElement.scrollWidth<=innerWidth'),
            true
          )
          win.setContentSize(1023, 679)
          await wait('innerHeight>=640&&innerHeight<=700')
          console.log(
            'SHORT_CALENDAR_VIEWPORT',
            await js('({width:innerWidth,height:innerHeight})')
          )
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          await capture('calendar-day-2100-short.png')
          await js('document.querySelector(".fc-timeGridWeek-button").click()')
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          await capture('calendar-week-2100-short.png')
          await js('document.querySelector(".fc-timeGridDay-button").click()')
          await wait(`(${geometry})?.visible===true`)
          // Brief manual browsing wins; the real periodic clock check resumes follow afterwards.
          await js(
            `(()=>{const line=document.querySelector('.fc-timegrid-now-indicator-line');line.closest('.fc-scroller').scrollTop=0;document.querySelector('.schedule-calendar').dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:-100}));window.__clock+=1000;window.dispatchEvent(new Event('focus'));return true})()`
          )
          await pause(100)
          assert.equal(
            await js(`(${geometry}).scroll`),
            0,
            '短暂手动浏览不会立即被焦点检查抢回'
          )
          await js(
            'window.__clock=new __RealDate(window.__clock).setHours(21,45,0,0);true'
          )
          // FullCalendar redraws its marker once per minute; exercise that real timer as well as our 30s follow.
          await pause(65000)
          await wait(
            `(${geometry})?.visible===true && (${geometry})?.remaining<3`
          )
          assert.equal(
            await js(
              `(()=>{const y=document.querySelector('.fc-timegrid-now-indicator-line').getBoundingClientRect().top;const a=document.querySelector('[data-time="21:30:00"]').getBoundingClientRect().top,b=document.querySelector('[data-time="22:00:00"]').getBoundingClientRect().top;return Math.abs(y-(a+b)/2)<3})()`
            ),
            true,
            '红线自身也已推进到21:45，而非仅滚动旧红线'
          )
          await capture('calendar-day-2145-follow.png')
          await js('document.querySelector(".fc-next-button").click()')
          await wait(
            '!document.querySelector(".fc-timegrid-now-indicator-line")'
          )
          assert.ok(
            await js(
              "[...document.querySelectorAll('.fc-scroller')].filter(e=>e.scrollHeight>e.clientHeight+10).every(e=>e.scrollTop<10)"
            ),
            '其他日期从设定起点展示'
          )
          await js(
            'window.__clock=new __RealDate(window.__clock).setHours(5,20,0,0);location.hash="/notes";true'
          )
          await wait('!document.querySelector(".fc")')
          await js('location.hash="/review"')
          await wait('!!document.querySelector(".fc-timeGridWeek-view")')
          await wait(`(${geometry})?.visible===true`)
          assert.equal(
            await js(
              'document.querySelector(".fc-timegrid-slot[data-time]").dataset.time'
            ),
            '05:00:00'
          )
          await capture('calendar-before-0600.png')
          await js('window.Date=window.__RealDate;true')
          fs.writeFileSync(
            path.join(root, 'checkpoint.json'),
            JSON.stringify({
              id: original.id,
              start: hour(12),
              before: hour(10)
            })
          )
          console.log(
            'BLOCK_MOVE_NATIVE_OK actual pointer drag/resize cancellation, form conflict override, stale confirmation input retention, locked manual move, autonomous preservation, day/week 21:00 through midnight and pre-06:00 geometry'
          )
        }
        clearTimeout(deadline)
        app.exit(0)
      } catch (e) {
        console.error(e.stack || e)
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
