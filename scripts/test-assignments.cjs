const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'learning-assistant-assignments-')
  )
  const env = { ...process.env }
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
    assert.equal(r.status, 0, '作业桌面验收失败：' + phase)
  }
  console.log('ASSIGNMENTS_NATIVE_ROOT ' + root)
} else {
  const electron = require('electron'),
    { app } = electron,
    root = process.argv[2],
    phase = process.argv[3]
  app.disableHardwareAcceleration()
  app.setPath('userData', root)
  app.setPath('sessionData', root)
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({
        ...options,
        width: 1024,
        height: 768,
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
      ? { ...electron, BrowserWindow: HiddenWindow }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('ASSIGNMENTS_TIMEOUT')
    app.exit(2)
  }, 90000)
  app.once('browser-window-created', (_event, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code)
      const call = async (group, method, ...args) => {
        const result = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(result.ok, true, result.error)
        return result.data
      }
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const wait = async (code) => {
        const until = Date.now() + 15000
        while (!(await js(code))) {
          if (Date.now() > until) throw Error('等待失败：' + code)
          await pause(40)
        }
      }
      const click = (text, scope = '.page') =>
        js(
          `(()=>{const e=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('missing '+${JSON.stringify(text)});e.click()})()`
        )
      const set = (selector, value) =>
        js(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing field');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`
        )
      const open = async (url) => {
        await js(`location.hash=${JSON.stringify(url)}`)
        await wait("document.querySelector('h1')?.textContent==='作业'")
      }
      const capture = async (name) => {
        await js('document.fonts.ready')
        await pause(120)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      try {
        const subjects = await call('subjects', 'list')
        if (phase === 'resume') {
          const checkpoint = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'))
          )
          const a = await call('assignments', 'get', checkpoint.id)
          assert.equal(a.task.id, checkpoint.task_id)
          assert.equal(a.revision, checkpoint.revision)
          assert.equal(a.history_total, checkpoint.history_total)
          assert.equal(a.task.status, 'doing')
          assert.equal(a.subject_id, subjects[0].id)
          assert.equal(a.task.due_at, checkpoint.due)
          assert.equal(
            JSON.parse(a.task.knowledge_refs_json)[0].concept_id,
            checkpoint.concept
          )
          assert.equal(
            (await call('calendar', 'planning')).blocks.some(
              (b) => b.task_id === a.task.id
            ),
            false
          )
          await open('/assignments?assignment=' + a.id)
          await wait(
            "document.querySelector('[aria-label=\"作业名称\"]')?.value==='热力学作业·课堂修订'"
          )
          assert.equal(
            await js(
              "document.querySelector('[aria-label=\"作业要求\"]').textContent.includes('能量守恒')"
            ),
            true
          )
          assert.ok(
            await js(
              'document.querySelector(\'[aria-label="作业要求"] math-field\')!==null'
            )
          )
          await capture('assignments-resume.png')
          console.log(
            'ASSIGNMENTS_RESTART_OK task/subject/formula/history/revision/references retained'
          )
        } else {
          await open('/assignments')
          await click('新建作业')
          await wait('!!document.querySelector(\'[aria-label="作业名称"]\')')
          await set('[aria-label="作业名称"]', '热力学作业')
          await set('[aria-label="作业学科"]', subjects[0].id)
          const today = new Date(),
            tomorrow = new Date(
              today.getFullYear(),
              today.getMonth(),
              today.getDate() + 1
            )
          const due = tomorrow.getTime() + 20 * 3600000 + 12345
          await set(
            '[aria-label="作业截止时间"]',
            `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T20:00`
          )
          await js(
            `(()=>{const e=document.querySelector('[aria-label="作业要求"]');e.focus();document.execCommand('insertText',false,'求解热力过程并说明能量守恒。')})()`
          )
          await click('保存作业')
          await wait(
            "document.querySelector('.assignment-editor-heading h2')?.textContent==='作业详情'"
          )
          let a = (
            await call('assignments', 'list', {
              scope: 'all',
              query: '热力学作业',
              offset: 0
            })
          ).items[0]
          assert.ok(a)
          assert.equal(a.subject_id, subjects[0].id)
          assert.match(a.task.detail, /能量守恒/)
          assert.equal(
            (await call('tasks', 'listAll')).filter(
              (t) => t.assignment_id === a.id
            ).length,
            1
          )
          assert.equal(
            (await call('tasks', 'listManual')).some((t) => t.id === a.task.id),
            false
          )
          const concept = await call('concepts', 'save', {
            name: '能量守恒验收',
            summary: '孤立系统总能量保持不变。',
            subject_id: subjects[0].id,
            aliases: []
          })
          await call('tasks', 'update', a.task.id, {
            due_at: due,
            detail: '求解并说明能量守恒：$E=\\frac{mv^2}{2}$。',
            knowledge_refs: [
              { concept_id: concept.id, why: '用于校验热力过程' }
            ]
          })
          // A stale draft from the open assignment form must not overwrite calendar edits.
          await set('[aria-label="作业名称"]', '旧窗口的草稿')
          await click('保存作业')
          await wait(
            "document.querySelector('[role=alert]')?.textContent.includes('已变化')"
          )
          assert.equal(
            await js(
              'document.querySelector(\'[aria-label="作业名称"]\').value'
            ),
            '旧窗口的草稿'
          )
          await js('void(window.confirm=()=>false)')
          await click('重新载入作业')
          assert.equal(
            await js(
              'document.querySelector(\'[aria-label="作业名称"]\').value'
            ),
            '旧窗口的草稿'
          )
          await js('void(window.confirm=()=>true)')
          await click('重新载入作业')
          await wait(
            "document.querySelector('[aria-label=\"作业名称\"]')?.value==='热力学作业'"
          )
          assert.ok(
            await js(
              'document.querySelector(\'[aria-label="作业要求"] math-field\')!==null'
            )
          )
          await set('[aria-label="作业名称"]', '热力学作业·课堂修订')
          await set('[aria-label="作业状态"]', 'doing')
          await click('保存作业')
          await wait(
            "document.querySelector('.assignment-row h2')?.textContent==='热力学作业·课堂修订'"
          )
          a = await call('assignments', 'get', a.id)
          assert.equal(
            a.task.due_at,
            due,
            '未改动的分钟显示不能损失原始时间戳秒/毫秒'
          )
          assert.equal(
            JSON.parse(a.task.knowledge_refs_json)[0].concept_id,
            concept.id
          )
          await capture('assignments-details.png')
          // Real planner worker: a deleted prerequisite must never count as completed.
          const settings = (await call('calendar', 'planning')).settings
          await call('calendar', 'saveSettings', {
            expected_revision: settings.revision,
            value: {
              ...settings.value,
              availability: Array.from({ length: 7 }, (_, i) => ({
                weekday: i + 1,
                start: '08:00',
                end: '22:00'
              })),
              daily_minutes: 480
            }
          })
          const options = {
            enabled: true,
            remaining_minutes: 30,
            priority: 1,
            not_before: null,
            splittable: false,
            min_minutes: 30,
            max_minutes: 60,
            dependencies: []
          }
          await call('calendar', 'savePlanning', {
            ...options,
            task_id: a.task.id,
            expected_revision: null
          })
          const dependent = await call('tasks', 'create', {
            title: '完成作业后写总结',
            due_at: due + 3600000
          })
          await call('calendar', 'savePlanning', {
            ...options,
            task_id: dependent.id,
            expected_revision: null,
            dependencies: [a.task.id]
          })
          const range = {
            from: tomorrow.getTime(),
            to: tomorrow.getTime() + 86400000
          }
          const preview = await call('calendar', 'plan', range)
          assert.ok(preview.added.some((b) => b.task_id === a.task.id))
          await call('calendar', 'applyPlan', preview.token)
          const block = (await call('calendar', 'planning')).blocks.find(
            (b) => b.task_id === a.task.id
          )
          await call('calendar', 'changeBlock', {
            id: block.id,
            expected_revision: block.revision,
            action: 'lock'
          })
          await js(`location.hash='/review?task=${a.task.id}'`)
          await wait(
            "document.querySelector('[aria-label=\"日程名称\"]')?.value==='热力学作业·课堂修订'"
          )
          assert.match(
            await js(
              'document.querySelector(\'[aria-label="日程编辑"]\').innerText'
            ),
            /查看作业与修改历史/
          )
          assert.ok(
            await js(
              'document.querySelector(\'[aria-label="日程说明"] math-field\')!==null'
            )
          )
          await set('[aria-label="日程地点"]', '力学自习室')
          await click('保存日程')
          await wait('!document.querySelector(\'[aria-label="日程编辑"]\')')
          const calendarEdited = await call('assignments', 'get', a.id)
          assert.equal(calendarEdited.task.location, '力学自习室')
          assert.equal(calendarEdited.task.due_at, due)
          await open('/assignments?assignment=' + a.id)
          await wait('!!document.querySelector(\'[aria-label="作业名称"]\')')
          await click('打开日程与学习安排')
          await wait('!!document.querySelector(\'[aria-label="日程名称"]\')')
          await capture('assignment-calendar.png')
          await click('删除日程')
          await wait('!document.querySelector(\'[aria-label="日程编辑"]\')')
          const trashed = await call('assignments', 'get', a.id)
          assert.ok(trashed.deleted_at !== null)
          assert.equal(
            (await call('calendar', 'planning')).blocks.some(
              (b) => b.task_id === a.task.id
            ),
            false
          )
          const blocked = await call('calendar', 'plan', range)
          assert.equal(
            blocked.added.some((b) => b.task_id === dependent.id),
            false
          )
          assert.ok(
            blocked.unplaced.some(
              (b) => b.task_id === dependent.id && b.reason.includes('前置')
            )
          )
          await call('calendar', 'discardPlan')
          await open('/assignments?assignment=' + a.id)
          await wait("!!document.querySelector('.assignment-trash-note')")
          await set('[aria-label="作业状态筛选"]', 'trash')
          await wait(
            "document.querySelector('.assignment-row h2')?.textContent==='热力学作业·课堂修订'"
          )
          assert.equal(
            await js(
              'document.querySelector(\'[aria-label="作业状态"]\').value'
            ),
            'doing'
          )
          await capture('assignments-trash.png')
          await click('恢复作业')
          await wait("!document.querySelector('.assignment-trash-note')")
          a = await call('assignments', 'get', a.id)
          assert.equal(a.task.id, trashed.task.id)
          assert.equal(a.task.status, 'doing')
          assert.equal(
            (await call('calendar', 'planning')).blocks.some(
              (b) => b.task_id === a.task.id
            ),
            false
          )
          // Blank, untouched creation closes without asking to discard.
          await click('新建作业')
          await wait(
            "document.querySelector('.assignment-editor-heading h2')?.textContent==='新建作业'"
          )
          await js(
            'window.__confirmCalls=0;window.confirm=()=>{window.__confirmCalls++;return false};undefined'
          )
          await js(
            'document.querySelector(\'[aria-label="关闭作业编辑"]\').click()'
          )
          await wait('!document.querySelector(\'[aria-label="作业编辑"]\')')
          assert.equal(await js('window.__confirmCalls'), 0)
          fs.writeFileSync(
            path.join(root, 'checkpoint.json'),
            JSON.stringify({
              id: a.id,
              task_id: a.task.id,
              revision: a.revision,
              history_total: a.history_total,
              due,
              concept: concept.id
            })
          )
          console.log(
            'ASSIGNMENTS_NATIVE_OK actual CRUD/math/stale-form/dirty guard/planner/dependencies/calendar trash/restore'
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
