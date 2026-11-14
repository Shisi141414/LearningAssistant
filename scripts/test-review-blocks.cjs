const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(
        require('node:os').tmpdir(),
        'learning-assistant-review-blocks-'
      )
    ),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 100000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '复习排程桌面验收失败：' + phase)
  }
  console.log('REVIEW_BLOCKS_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  app.disableHardwareAcceleration()
  app.setPath('userData', root)
  app.setPath('sessionData', root)
  class HiddenWindow extends electron.BrowserWindow {
    constructor(o) {
      super({
        ...o,
        width: 1024,
        height: 768,
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
    return request === 'electron'
      ? { ...electron, BrowserWindow: HiddenWindow }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('REVIEW_BLOCKS_TIMEOUT')
    app.exit(2)
  }, 90000)
  app.once('browser-window-created', (_e, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code)
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const pause = (ms) => new Promise((r) => setTimeout(r, ms))
      const wait = async (code) => {
        const until = Date.now() + 12000
        while (!(await js(code))) {
          if (Date.now() > until) throw Error('等待失败：' + code)
          await pause(40)
        }
      }
      const click = (text, scope = '.page') =>
        js(
          `(()=>{const e=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('missing '+${JSON.stringify(text)});e.click()})()`
        )
      const open = async (hash) => {
        await js(`location.hash=${JSON.stringify(hash)}`)
        await pause(150)
      }
      const capture = async (name) => {
        await js('document.fonts.ready')
        await pause(120)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      const raw = (group, method, ...args) =>
        js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
      const set = (selector, value) =>
        js(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('输入框不存在');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
      const planning = () => call('calendar', 'planning')
      const policy = (id) => call('reviews', 'planning', id)
      const enable = async (id, patch = {}) => {
        const p = await policy(id)
        return call('reviews', 'savePlanning', {
          id,
          expected_revision: p.revision,
          expected_card_revision: p.card_revision,
          enabled: true,
          duration_minutes: p.duration_minutes,
          priority: p.priority,
          ...patch
        })
      }
      const grade = async (id) => {
        const r = await call('reviews', 'get', id),
          shown = await call('reviews', 'reveal', {
            id,
            expected_revision: r.revision
          })
        return call('reviews', 'grade', { token: shown.token, grade: 3 })
      }
      const action = async (id, action) => {
        const r = await call('reviews', 'get', id)
        return call('reviews', 'action', {
          id,
          expected_revision: r.revision,
          action
        })
      }
      try {
        await js('window.confirm=()=>true;void 0')
        if (phase === 'resume') {
          const saved = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          const r = await call('reviews', 'get', saved.a),
            p = await policy(saved.a)
          assert.equal(r.reps, 0)
          assert.equal(r.due_at, saved.due)
          assert.equal(p.duration_minutes, 15)
          assert.equal(p.enabled, true)
          assert.equal(p.cycle, saved.cycle)
          assert.deepEqual(p.history, saved.history)
          assert.equal(p.blocks.length, 1)
          assert.equal(p.blocks[0].id, saved.block)
          assert.equal(p.blocks[0].review_cycle, p.cycle)
          const before = (await planning()).blocks
          await call('calendar', 'checkContinuous')
          assert.deepEqual(
            (await planning()).blocks,
            before,
            '重启与重复检查不额外安排同一轮次'
          )
          await open('/review?task=' + r.task_id)
          await wait(
            `!!document.querySelector('[aria-label="复习日程详情"] .review-planning')`
          )
          assert.equal(
            await js(`!!document.querySelector('[aria-label="日程标题"]')`),
            false
          )
          await js(
            `document.querySelector('.review-planning').open=true;document.querySelector('.review-planning').scrollIntoView()`
          )
          await capture('review-calendar-planning.png')
          console.log(
            'REVIEW_BLOCKS_RESTART_OK policy/current cycle/locked history retained; readonly calendar controls and no duplicate automatic scheduling'
          )
        } else {
          const fixture = async (name) => {
            const c = await call('concepts', 'save', {
              name,
              summary: '固定复习来源：合外力等于动量变化率。$F=dp/dt$',
              subject_id: null,
              aliases: []
            })
            return call('reviews', 'add', {
              kind: 'concept',
              source_id: c.id,
              expected_source_revision: String(c.revision)
            })
          }
          const a = await fixture('动量定理排程'),
            b = await fixture('功与能排程')
          const learnedB = await grade(b.id)
          assert.ok(learnedB.due_at > Date.now())
          await open('/practice?card=' + a.id)
          await wait(`!!document.querySelector('.review-planning fieldset')`)
          await js(
            `document.querySelector('.review-planning').open=true;document.querySelector('[aria-label="允许自动安排复习"]').click()`
          )
          await set('[aria-label="每轮复习用时"]', 15)
          // An unsaved policy must survive a rejected switch or page action.
          await js('window.confirm=()=>false;void 0')
          await click('刷新')
          assert.equal(
            await js(
              `document.querySelector('[aria-label="每轮复习用时"]').value`
            ),
            '15'
          )
          await click('查看日程')
          assert.ok((await js('location.hash')).startsWith('#/practice'))
          await js('window.confirm=()=>true;void 0')
          await click('保存复习安排')
          await wait(
            `document.querySelector('.toast')?.textContent.includes('复习学习安排已保存') || !document.querySelector('.review-planning fieldset').disabled`
          )
          assert.equal((await policy(a.id)).duration_minutes, 15)
          await enable(b.id)
          const start = new Date()
          start.setDate(start.getDate() + 1)
          start.setHours(0, 0, 0, 0)
          const from = start.getTime(),
            to = from + 14 * 86400000,
            h = (n) => from + n * 3600000
          let s = await planning()
          await call('calendar', 'saveSettings', {
            expected_revision: s.settings.revision,
            value: {
              timezone: 'Asia/Shanghai',
              daily_minutes: 120,
              buffer_minutes: 0,
              availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                weekday,
                start: '09:00',
                end: '22:00'
              }))
            }
          })
          const course = await call('tasks', 'create', {
              title: '固定热力学课程',
              planned_at: h(9),
              planned_end_at: h(10),
              location: '六教'
            }),
            normal = await call('tasks', 'create', {
              title: '有截止的作业',
              due_at: h(10.5)
            })
          await call('calendar', 'savePlanning', {
            task_id: normal.id,
            expected_revision: null,
            enabled: true,
            remaining_minutes: 30,
            priority: 1,
            not_before: null,
            splittable: false,
            min_minutes: 30,
            max_minutes: 30,
            dependencies: []
          })
          let preview = await call('calendar', 'plan', { from, to })
          assert.equal(
            preview.unplaced.length,
            0,
            JSON.stringify({ preview, a, b, learnedB })
          )
          assert.equal(
            preview.added.filter((x) => x.task_id === a.task_id).length,
            1
          )
          assert.equal(
            preview.added.find((x) => x.task_id === a.task_id).review_cycle,
            (await policy(a.id)).cycle
          )
          assert.ok(
            preview.added.find((x) => x.task_id === b.task_id).start_at >=
              learnedB.due_at
          )
          const n = preview.added.find((x) => x.task_id === normal.id)
          assert.ok(n.start_at >= h(10) && n.end_at <= h(10.5))
          for (const block of preview.added)
            assert.ok(block.end_at <= h(9) || block.start_at >= h(10))
          s = await call('calendar', 'applyPlan', preview.token)
          const firstRun = s.latest_run.id
          assert.equal((await policy(a.id)).blocks.length, 1)
          assert.equal((await policy(b.id)).blocks.length, 1)
          // Generic undo restores both block and per-round ownership.
          s = await call('calendar', 'undoPlan', firstRun)
          assert.equal((await policy(a.id)).blocks.length, 0)
          s = await call(
            'calendar',
            'applyPlan',
            (await call('calendar', 'plan', { from, to })).token
          )
          await open('/review')
          await open('/practice?card=' + a.id)
          await wait(`!!document.querySelector('.review-planning fieldset')`)
          await js(`document.querySelector('.review-planning').open=true`)
          await click('锁定', '.review-planning')
          await wait(
            `document.querySelector('.review-planning').textContent.includes('已锁定')`
          )
          const old = (await policy(a.id)).blocks[0],
            oldCycle = old.review_cycle,
            other = (await policy(b.id)).blocks
          await js(
            `document.querySelector('.review-planning').scrollIntoView({block:'start'})`
          )
          await capture('review-current-block.png')
          // Make a preview stale through the real review UI and memory transaction.
          preview = await call('calendar', 'plan', { from, to })
          await click('显示答案')
          await wait(`!!document.querySelector('.grade-3')`)
          await js(`document.querySelector('.grade-3').click()`)
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('已复习 1 次')`
          )
          const rated = await call('reviews', 'get', a.id),
            closed = await policy(a.id)
          assert.ok(rated.due_at > Date.now())
          assert.equal(closed.blocks.length, 0)
          assert.notEqual(closed.cycle, oldCycle)
          assert.equal(closed.history[0].blocks[0].id, old.id)
          assert.equal(closed.history[0].blocks[0].locked, true)
          assert.deepEqual((await policy(b.id)).blocks, other)
          assert.equal(
            (await raw('calendar', 'applyPlan', preview.token)).ok,
            false,
            '评分后拒绝陈旧预览'
          )
          assert.equal(
            (await raw('calendar', 'undoPlan', s.latest_run.id)).ok,
            false,
            '旧的排程撤销不能复活上轮块'
          )
          await call('calendar', 'discardPlan')
          const undone = await action(a.id, 'undo')
          assert.equal(undone.reps, 0)
          assert.equal((await policy(a.id)).blocks.length, 0)
          assert.notEqual((await policy(a.id)).cycle, oldCycle)
          s = await call(
            'calendar',
            'applyPlan',
            (await call('calendar', 'plan', { from, to })).token
          )
          const newBlock = (await policy(a.id)).blocks[0],
            future = (await policy(b.id)).blocks[0]
          assert.notEqual(newBlock.id, old.id)
          assert.equal(newBlock.review_cycle, (await policy(a.id)).cycle)
          assert.equal(
            (
              await raw('calendar', 'moveBlock', {
                id: future.id,
                expected_revision: future.revision,
                start_at: Date.now() + 3600000,
                end_at: Date.now() + 4200000,
                ignore_conflicts: true
              })
            ).ok,
            false
          )
          await call('calendar', 'changeBlock', {
            id: future.id,
            expected_revision: future.revision,
            action: 'lock'
          })
          await action(a.id, 'pause')
          assert.equal((await policy(a.id)).blocks.length, 0)
          await action(a.id, 'resume')
          const continuous = await call('calendar', 'continuous')
          await call('calendar', 'saveContinuous', {
            ...continuous.settings,
            enabled: true,
            horizon_days: 3
          })
          await call('calendar', 'checkContinuous')
          assert.ok(
            (await policy(b.id)).blocks.some(
              (x) => x.id === future.id && x.locked
            ),
            '范围外的下一轮锁定复习块仍保留'
          )
          assert.ok(
            !(await call('calendar', 'continuous')).outcome.unplaced?.some(
              (x) => x.task_id === b.task_id
            ),
            '范围外的锁定复习不能被误报为未安排'
          )
          let p = await policy(a.id)
          assert.equal(p.blocks.length, 1)
          assert.equal(p.blocks[0].review_cycle, p.cycle)
          await enable(a.id, { enabled: false })
          assert.equal((await policy(a.id)).blocks.length, 0)
          await enable(a.id)
          await call('calendar', 'checkContinuous')
          p = await policy(a.id)
          assert.equal(p.blocks.length, 1)
          const last = (await call('calendar', 'continuous')).history.length
          await call('calendar', 'checkContinuous')
          assert.equal(
            (await call('calendar', 'continuous')).history.length,
            last
          )
          assert.equal(
            (await call('reviews', 'get', a.id)).reps,
            0,
            '经过日程操作不会产生评分'
          )
          fs.writeFileSync(
            path.join(root, 'checkpoint.json'),
            JSON.stringify({
              a: a.id,
              due: undone.due_at,
              cycle: p.cycle,
              block: p.blocks[0].id,
              history: p.history
            })
          )
          console.log(
            'REVIEW_BLOCKS_NATIVE_OK actual worker/apply/undo; fixed courses/deadlines; UI opt-in/lock/grade; stale preview and pre-due move rejection; cycle archive; pause/resume/disable and continuous scheduling'
          )
        }
        clearTimeout(deadline)
        app.exit(0)
      } catch (error) {
        console.error(error.stack || error)
        console.error(await js('document.body.innerText').catch(() => ''))
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  )
  require('../out/main/index.js')
}
