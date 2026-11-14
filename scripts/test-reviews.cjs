const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-reviews-')
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
    assert.equal(r.status, 0, '复习桌面验收失败：' + phase)
  }
  console.log('REVIEWS_NATIVE_ROOT ' + root)
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
  let holdGet = '',
    releaseGet,
    readHeld = false
  const nativeHandle = electron.ipcMain.handle.bind(electron.ipcMain)
  const ipcMain = new Proxy(electron.ipcMain, {
    get(target, key) {
      if (key === 'handle')
        return (channel, listener) =>
          nativeHandle(channel, async (...args) => {
            const result = await listener(...args)
            if (channel === 'reviews:get' && args[1] === holdGet) {
              holdGet = ''
              readHeld = true
              await new Promise((resolve) => {
                releaseGet = resolve
              })
            }
            return result
          })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const Module = require('node:module'),
    load = Module._load
  Module._load = function (request, parent, main) {
    return request === 'electron'
      ? { ...electron, BrowserWindow: HiddenWindow, ipcMain }
      : load.call(this, request, parent, main)
  }
  const deadline = setTimeout(() => {
    console.error('REVIEWS_TIMEOUT')
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
      try {
        if (phase === 'resume') {
          const state = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          const r = await call('reviews', 'get', state.id)
          assert.equal(r.reps, 1)
          assert.equal(r.due_at, state.due)
          assert.equal(r.snapshot.exercise.status, 'wrong')
          assert.equal(r.history[0].grade, 1)
          const tasks = await call('tasks', 'listAll')
          assert.equal(tasks.filter((t) => t.review_id === r.id).length, 1)
          assert.equal(tasks.find((t) => t.id === r.task_id).due_at, r.due_at)
          const e = await call('exercises', 'get', { id: state.exercise })
          assert.equal(e.snapshot.status, 'wrong')
          await open('/practice?card=' + r.id)
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('下次建议复习')`
          )
          await click('撤销最近评分')
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('已复习 0 次')`
          )
          await click('暂停复习')
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('此条目已暂停')`
          )
          assert.equal(
            (await call('tasks', 'listAll')).find((t) => t.id === r.task_id)
              .status,
            'done'
          )
          await click('恢复复习')
          await wait(
            `[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='显示答案')`
          )
          assert.equal((await call('reviews', 'get', r.id)).reps, 0)
          console.log(
            'REVIEWS_NATIVE_RESUME_OK persisted FSRS/source/history/task; undo and pause/resume'
          )
        } else {
          const concept = await call('concepts', 'save', {
            name: '动量定理',
            summary: '合外力的冲量等于动量的变化。$I=\\Delta p$',
            subject_id: null,
            aliases: ['动量原理']
          })
          await open('/knowledge?concept=' + concept.id)
          await wait(
            `document.querySelector('input[maxlength="120"]')?.value==='动量定理'`
          )
          await click('加入复习')
          await wait(
            `document.querySelector('.review-session h2')?.textContent==='动量定理'`
          )
          assert.equal(
            await js(`!!document.querySelector('[aria-label="复习答案"]')`),
            false
          )
          assert.equal(
            await js(
              `document.querySelector('.review-session').innerText.includes('合外力的冲量')`
            ),
            false
          )
          await click('显示答案')
          await wait(
            `document.querySelectorAll('.review-ratings button').length===4`
          )
          assert.equal(
            await js(
              `document.querySelector('[aria-label="复习答案"]').innerText.includes('合外力的冲量')`
            ),
            true
          )
          assert.equal(
            await js(
              `!!document.querySelector('[aria-label="复习答案"] .katex')`
            ),
            true
          )
          let id = await js(
            `new URLSearchParams(location.hash.split('?')[1]).get('card')`
          )
          // The refresh read captures the old revision and returns after a successful rating.
          holdGet = id
          readHeld = false
          await click('刷新')
          const readDeadline = Date.now() + 5000
          while (!readHeld) {
            if (Date.now() > readDeadline) throw Error('read not held')
            await pause(20)
          }
          await js(`document.querySelector('.grade-3').click()`)
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('已复习 1 次')`
          )
          releaseGet()
          await pause(150)
          assert.equal(
            await js(
              `document.querySelector('.review-session').innerText.includes('已复习 1 次')`
            ),
            true,
            '迟到刷新不得覆盖刚提交的评分'
          )
          const graded = await call('reviews', 'get', id)
          assert.ok(graded.due_at > Date.now())
          await click('撤销最近评分')
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('已复习 0 次')`
          )
          await click('查看复习日程')
          await wait(`!!document.querySelector('[aria-label="复习日程详情"]')`)
          assert.equal(
            await js(`!!document.querySelector('[aria-label="日程名称"]')`),
            false
          )
          await click('前往复习')
          await wait(
            `document.querySelector('.review-session h2')?.textContent==='动量定理'`
          )
          const ex = await call('exercises', 'save', {
            title: '冲量计算',
            subject_id: null,
            status: 'wrong',
            question_type: '计算',
            source_label: '力学教材例题',
            no_idea: false,
            review_concept_ids: [concept.id],
            fields: {
              statement: '质量 $m$ 的物体由静止加速到 $v$，求冲量。',
              approach: '使用动量定理。',
              standard_answer: '$I=mv$',
              user_answer: '$m+v$',
              error_reason: '量纲不一致。'
            }
          })
          await open('/exercises/' + ex.id)
          await wait(
            `[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='加入复习')`
          )
          await click('加入复习')
          await wait(
            `document.querySelector('.review-session h2')?.textContent==='冲量计算'`
          )
          assert.equal(
            await js(
              `document.querySelector('.review-session').innerText.includes('量纲不一致')`
            ),
            false
          )
          assert.equal(
            await js(`!!document.querySelector('.review-prompt .katex')`),
            true
          )
          id = await js(
            `new URLSearchParams(location.hash.split('?')[1]).get('card')`
          )
          await click('显示答案')
          await wait(
            `!!document.querySelector('[aria-label="复习答案"] .katex')`
          )
          assert.equal(
            await js(
              `document.querySelectorAll('.review-answer .review-field').length`
            ),
            4
          )
          holdGet = id
          readHeld = false
          await click('刷新')
          const secondDeadline = Date.now() + 5000
          while (!readHeld) {
            if (Date.now() > secondDeadline) throw Error('second read not held')
            await pause(20)
          }
          await js(`document.querySelector('.review-queue-item').click()`)
          await wait(
            `document.querySelector('.review-session h2')?.textContent==='动量定理'`
          )
          releaseGet()
          await pause(150)
          assert.equal(
            await js(
              `document.querySelector('.review-session h2').textContent`
            ),
            '动量定理',
            '迟到刷新不得替换另一条目'
          )
          await open('/practice?card=' + id)
          await wait(
            `document.querySelector('.review-session h2')?.textContent==='冲量计算'`
          )
          await click('显示答案')
          await wait(
            `!!document.querySelector('[aria-label="复习答案"] .katex')`
          )
          await capture('review-answer.png')
          const layout = await js(
            `(()=>{const e=document.querySelector('.review-session').getBoundingClientRect();return {right:e.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()`
          )
          assert.equal(layout.overflow, false)
          assert.ok(layout.right <= layout.width)
          await js(`document.querySelector('.grade-1').click()`)
          await wait(
            `document.querySelector('.review-session')?.textContent.includes('已复习 1 次')`
          )
          await js(
            `document.querySelector('.review-management').scrollIntoView({block:'end'})`
          )
          await capture('review-ratings-result.png')
          const final = await call('reviews', 'get', id)
          assert.ok(
            final.due_at > Date.now() && final.due_at < Date.now() + 65000
          )
          const original = await call('exercises', 'get', { id: ex.id })
          assert.equal(original.revision_id, ex.revision_id)
          assert.equal(original.snapshot.status, 'wrong')
          fs.writeFileSync(
            path.join(root, 'checkpoint.json'),
            JSON.stringify({ id, exercise: ex.id, due: final.due_at })
          )
          console.log(
            'REVIEWS_NATIVE_OK source buttons, hidden answer, math rendering, four ratings, undo, readonly calendar, original exercise protection, 1024 layout and delayed refresh guards'
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
