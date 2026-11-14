const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-memo-auto-')
    ),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume', 'final']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 135000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '自动备忘验收失败 ' + phase)
  }
  console.log('MEMO_AUTO_NATIVE_ROOT ' + root)
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
  let mode = 'valid',
    requests = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://memo-auto-fixture.invalid'))
      return original(url, options)
    requests++
    if (mode === 'offline') throw new TypeError('offline fixture')
    if (mode === 'hold')
      return new Response(
        new ReadableStream({
          start(c) {
            options.signal.addEventListener(
              'abort',
              () => c.error(new Error('cancelled')),
              { once: true }
            )
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    const body = JSON.parse(options.body),
      text = JSON.parse(body.messages[0].content).text
    const p = {
      kind: 'task',
      knowledge: null,
      task: {
        title: text,
        detail: '',
        time_text: text.includes('周五') ? '周五' : '',
        start: null,
        end: null,
        due: null,
        location: '',
        excerpt: text
      },
      uncertainties: []
    }
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          delta: { text: JSON.stringify(p) }
        }) +
        '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  const deadline = setTimeout(() => {
    console.error('MEMO_AUTO_TIMEOUT')
    app.exit(2)
  }, 125000)
  app.once('browser-window-created', (_e, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) => win.webContents.executeJavaScript(code),
        pause = (ms) => new Promise((r) => setTimeout(r, ms))
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const wait = async (fn) => {
        const end = Date.now() + 85000
        while (!(await fn())) {
          if (Date.now() > end) throw Error('等待超时')
          await pause(50)
        }
      }
      const click = (text) =>
        js(
          `(()=>{const e=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('按钮不可用 '+${JSON.stringify(text)});e.click();})()`
        )
      const toggle = (label) =>
        js(
          `document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']').click();void 0`
        )
      const set = async (label, value) => {
        await js(
          `(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`
        )
        await pause(50)
      }
      const open = async (id = '') => {
        await js(`location.hash='/memos${id ? '?memo=' + id : ''}';void 0`)
        await wait(() => js(`!!document.querySelector('.memo-automation')`))
        await js(`document.querySelector('.memo-automation').open=true;void 0`)
      }
      const status = async (id) => {
        const d = await call('memos', 'get', id)
        return d.automation.find((j) => j.revision === d.memo.revision)
      }
      try {
        await js('window.confirm=()=>true;void 0')
        if (phase !== 'first') {
          const checkpoint = JSON.parse(
            fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
          )
          const id =
            phase === 'resume' ? checkpoint.offline : checkpoint.interrupted
          await wait(async () => (await status(id))?.status === 'routed')
          const d = await call('memos', 'get', id)
          assert.equal(d.routes.length, 1)
          assert.equal(
            (await call('tasks', 'listAll')).filter(
              (t) => t.title === d.memo.content
            ).length,
            1
          )
          assert.equal((await status(id)).attempts, 2)
          assert.equal(requests, 1)
          await open(id)
          await wait(() => js(`document.body.innerText.includes('已自动归档')`))
          if (phase === 'final') {
            await click('撤销此归档')
            await wait(
              async () => !!(await call('memos', 'get', id)).routes[0].undone_at
            )
            await wait(() =>
              js(
                `document.querySelector('[aria-label="本条自动整理"]')?.innerText.includes('此条归档已撤销')`
              )
            )
            await pause(3500)
            assert.equal(
              (await call('tasks', 'listAll')).filter(
                (t) => t.title === d.memo.content
              ).length,
              0
            )
            assert.equal((await call('memos', 'get', id)).routes.length, 1)
            fs.writeFileSync(
              path.join(root, 'auto-recovered.png'),
              (await win.webContents.capturePage()).toPNG()
            )
            console.log(
              'MEMO_AUTO_FINAL_OK actual crash recovery, one target, undo tombstone prevents recreation'
            )
          } else {
            mode = 'hold'
            const pending = await call('memos', 'save', {
              content: '重启补处理的备忘',
              subject_id: checkpoint.subject
            })
            await wait(
              async () => (await status(pending.memo.id))?.status === 'running'
            )
            await wait(() => requests === 2)
            fs.writeFileSync(
              path.join(root, 'checkpoint.json'),
              JSON.stringify({ ...checkpoint, interrupted: pending.memo.id })
            )
            console.log(
              'MEMO_AUTO_RESUME_OK offline retry survives process exit and routes once; held request checkpoint saved'
            )
          }
          clearTimeout(deadline)
          app.exit(0)
          return
        }
        const subjects = await call('subjects', 'list'),
          subject = subjects[0]
        const provider = await call('providers', 'save', {
          name: '自动整理验收',
          base_url: 'https://memo-auto-fixture.invalid',
          api_format: 'anthropic',
          api_key: 'auto-native-secret',
          enabled: true
        })
        const model = await call('models', 'save', {
          provider_id: provider.id,
          model_id: 'auto-native-model'
        })
        const old = await call('memos', 'save', {
          content: '启用之前的备忘',
          subject_id: subject.id
        })
        await open()
        assert.equal(requests, 0)
        await set('自动整理模型', model.id)
        await toggle('自动整理学科 ' + subject.name)
        await toggle('启用备忘自动整理')
        await pause(100)
        // Settings draft participates in the existing unsaved-navigation guard.
        await js(
          `window.confirm=()=>false;document.querySelector('a[href="#/knowledge"]').click();void 0`
        )
        assert.ok(await js(`location.hash.startsWith('#/memos')`))
        await js('window.confirm=()=>true;void 0')
        await click('保存自动整理规则')
        await wait(
          async () => (await call('memos', 'autoState')).settings.enabled
        )
        const d = await call('memos', 'save', {
          content: '整理弹簧实验器材',
          subject_id: subject.id
        })
        await wait(async () => (await status(d.memo.id))?.status === 'routed')
        assert.equal(
          (await call('memos', 'get', old.memo.id)).automation.length,
          0
        )
        await open(d.memo.id)
        await wait(() =>
          js(
            `document.querySelector('[aria-label="编辑备忘原文"]')?.textContent==='整理弹簧实验器材'`
          )
        )
        const ambiguous = await call('memos', 'save', {
          content: '周五交报告',
          subject_id: subject.id
        })
        await wait(
          async () => (await status(ambiguous.memo.id))?.status === 'review'
        )
        assert.match((await status(ambiguous.memo.id)).reason, /日期不明确/)
        assert.equal(
          (await call('memos', 'get', ambiguous.memo.id)).routes.length,
          0
        )
        await js(
          `document.querySelector('.memo-automation details').open=true;void 0`
        )
        await wait(() =>
          js(
            `document.querySelector('.memo-auto-jobs')?.innerText.includes('日期不明确')`
          )
        )
        assert.ok(await js('document.documentElement.scrollWidth<=innerWidth'))
        fs.writeFileSync(
          path.join(root, 'auto-review.png'),
          (await win.webContents.capturePage()).toPNG()
        )
        mode = 'hold'
        const held = await call('memos', 'save', {
          content: '停用规则保护原文',
          subject_id: subject.id
        })
        await wait(
          async () => (await status(held.memo.id))?.status === 'running'
        )
        await toggle('启用备忘自动整理')
        await pause(100)
        await click('保存自动整理规则')
        await wait(
          async () => (await status(held.memo.id))?.status === 'cancelled'
        )
        assert.equal(
          (await call('memos', 'get', held.memo.id)).routes.length,
          0
        )
        mode = 'offline'
        await toggle('启用备忘自动整理')
        await pause(100)
        await click('保存自动整理规则')
        await wait(
          async () => (await call('memos', 'autoState')).settings.enabled
        )
        const offline = await call('memos', 'save', {
          content: '离线后恢复的备忘',
          subject_id: subject.id
        })
        await wait(
          async () =>
            (await status(offline.memo.id))?.status === 'pending' &&
            (await status(offline.memo.id))?.attempts === 1
        )
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({ offline: offline.memo.id, subject: subject.id })
        )
        console.log(
          'MEMO_AUTO_NATIVE_OK actual settings controls, consent scope, unsaved guard, automatic task, uncertain review, disable cancellation, durable offline retry and 1024 layout'
        )
        clearTimeout(deadline)
        app.exit(0)
      } catch (e) {
        console.error(e.stack || e)
        console.error(await js('document.body.innerText').catch(() => ''))
        clearTimeout(deadline)
        app.exit(1)
      }
    })
  )
  require('../out/main/index.js')
}
