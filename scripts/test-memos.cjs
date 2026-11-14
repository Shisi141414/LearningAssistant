const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(
      path.join(require('node:os').tmpdir(), 'learning-assistant-memos-')
    ),
    env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  for (const phase of ['first', 'resume']) {
    const r = require('node:child_process').spawnSync(
      require('electron'),
      [__filename, root, phase],
      { env, windowsHide: true, encoding: 'utf8', timeout: 90000 }
    )
    process.stdout.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    if (r.error) throw r.error
    assert.equal(r.status, 0, '备忘验收失败：' + phase)
  }
  console.log('MEMOS_NATIVE_ROOT ' + root)
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
  let requests = 0,
    lastBody,
    mode = 'valid',
    candidate
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://memo-fixture.invalid'))
      return originalFetch(url, options)
    requests++
    lastBody = JSON.parse(options.body)
    if (mode === 'hold')
      return new Response(
        new ReadableStream({
          start(controller) {
            options.signal.addEventListener(
              'abort',
              () => controller.error(new Error('cancelled')),
              { once: true }
            )
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'content_block_delta',
          delta: { text: JSON.stringify(candidate) }
        }) +
        '\n\n'
    )
  }
  const deadline = setTimeout(() => {
    console.error('MEMOS_TIMEOUT')
    app.exit(2)
  }, 80000)
  app.once('browser-window-created', (_e, win) =>
    win.webContents.once('did-finish-load', async () => {
      const js = (code) =>
        win.webContents.executeJavaScript(code).catch((e) => {
          throw Error(e.message + '\n表达式：' + code.slice(0, 500))
        })
      const call = async (group, method, ...args) => {
        const r = await js(
          `window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`
        )
        assert.equal(r.ok, true, r.error)
        return r.data
      }
      const pause = (ms) => new Promise((r) => setTimeout(r, ms))
      const wait = async (code) => {
        const end = Date.now() + 10000
        while (!(await js(code))) {
          if (Date.now() > end)
            throw Error(
              '等待失败：' + code + '\n' + (await js('document.body.innerText'))
            )
          await pause(30)
        }
      }
      const click = (text, scope = '.page') =>
        js(
          `(()=>{const e=[...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('按钮不可用：'+${JSON.stringify(text)});e.click()})()`
        )
      const set = (label, value) =>
        js(
          `(()=>{const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');if(!e)throw Error('没有输入框：'+${JSON.stringify(label)});Object.getOwnPropertyDescriptor((e.tagName==='SELECT'?HTMLSelectElement:e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement).prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`
        )
      const paste = async (label, text) => {
        await js(
          `document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]').focus()`
        )
        win.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'A',
          modifiers: ['control']
        })
        win.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'A',
          modifiers: ['control']
        })
        await pause(50)
        await js(
          `(()=>{const e=document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]');const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}))})()`
        )
      }
      const capture = async (name) => {
        await js(
          'document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))'
        )
        await pause(120)
        fs.writeFileSync(
          path.join(root, name),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      const open = async (id, revision = '') => {
        await js(
          `location.hash=${JSON.stringify('/memos?memo=' + id + (revision ? '&revision=' + revision : ''))}`
        )
        await wait(`!!document.querySelector('[aria-label="编辑备忘原文"]')`)
      }
      try {
        await wait('!!window.api')
        await js('window.confirm=()=>true;void 0')
        if (phase === 'resume') {
          const saved = JSON.parse(
              fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8')
            ),
            d = await call('memos', 'get', saved.id)
          assert.equal(d.memo.content, saved.edited)
          assert.equal(d.versions.length, 2)
          assert.equal(d.routes[0].revision, saved.original)
          assert.equal(
            d.routes[0].targets.find((t) => t.kind === 'task').target_id,
            saved.task
          )
          const job = d.recognitions.find((j) => j.id === saved.interrupted)
          assert.equal(job.status, 'cancelled')
          assert.match(job.error, /中断/)
          assert.equal(requests, 0)
          await open(saved.id, saved.original)
          await wait(
            `document.querySelector('#memo-version-${saved.original}')?.textContent.includes('傅氏变换')`
          )
          const receipt = await call('memos', 'undo', d.routes[0].id)
          assert.ok(receipt.routes[0].undone_at)
          assert.equal(
            (await call('tasks', 'listAll')).some((t) => t.id === saved.task),
            false
          )
          assert.ok(
            (await call('concepts', 'list')).some((c) => c.id === saved.concept)
          )
          console.log(
            'MEMOS_RESTART_OK saved source versions, mixed targets, interrupted recognition without request, undo removes unchanged task and retains knowledge'
          )
          clearTimeout(deadline)
          app.exit(0)
          return
        }
        const subjects = await call('subjects', 'list'),
          subject = subjects[0].id
        const provider = await call('providers', 'save', {
          name: '备忘验收模型',
          base_url: 'https://memo-fixture.invalid',
          api_format: 'anthropic',
          api_key: 'memo-ui-secret',
          enabled: true
        })
        const model = await call('models', 'save', {
          provider_id: provider.id,
          model_id: 'memo-model'
        })
        const concept = await call('concepts', 'save', {
          name: '傅里叶变换',
          summary: '人工保留的条件',
          aliases: ['傅氏变换'],
          subject_id: subject
        })
        const day = new Date()
        day.setDate(day.getDate() + 3)
        day.setHours(10, 0, 0, 0)
        const start = +day,
          end = start + 3600000,
          stamp = (n) =>
            new Date(n - new Date(n).getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 19) + '+08:00'
        const timeText = stamp(start).slice(0, 10) + ' 10:00至11:00',
          content = '傅氏变换用于分析频谱。' + timeText + '在实验室讨论报告。'
        candidate = {
          kind: 'mixed',
          knowledge: {
            name: '傅氏变换',
            summary: '分析频谱',
            excerpt: '傅氏变换用于分析频谱。'
          },
          task: {
            title: '讨论实验报告',
            detail: '分析频谱',
            time_text: timeText,
            start: stamp(start),
            end: stamp(end),
            due: null,
            location: '实验室',
            excerpt: timeText + '在实验室讨论报告。'
          },
          uncertainties: []
        }
        await call('tasks', 'create', {
          title: '已有固定课程',
          planned_at: start,
          planned_end_at: end
        })
        // Real global capture and rendered math editor paste; no database/API shortcut for the new memo.
        await click('随手记', '.quickbar')
        await wait('!!document.querySelector("dialog.memo-capture[open]")')
        await paste('随手记原文', content)
        await set('随手记学科', subject)
        await click('保存并整理', 'dialog.memo-capture')
        await wait(
          `!!document.querySelector('.memos-page [aria-label="编辑备忘原文"]')`
        )
        const id = await js(
            "new URLSearchParams(location.hash.split('?')[1]).get('memo')"
          ),
          initial = await call('memos', 'get', id)
        assert.equal(initial.memo.content, content)
        await wait(
          `document.querySelector('[aria-label="备忘识别模型"]')?.value===${JSON.stringify(model.id)}`
        )
        await click('识别这条备忘')
        await wait(
          '!!document.querySelector(".memo-job")?.innerText.includes("待核对")'
        )
        assert.equal(requests, 1)
        assert.equal(
          JSON.parse(lastBody.messages.find((m) => m.role === 'user').content)
            .text,
          content
        )
        assert.equal(JSON.stringify(lastBody).includes('人工保留的条件'), false)
        assert.equal((await call('memos', 'get', id)).routes.length, 0)
        await click('填入整理草稿')
        await wait(
          `document.querySelector('[aria-label="备忘待办名称"]')?.value==='讨论实验报告'`
        )
        await click('检查归档')
        await wait(
          '!!document.querySelector(".memo-preview")?.innerText.includes("时间冲突")'
        )
        assert.equal(
          await js(
            "[...document.querySelectorAll('.memo-preview button')].find(b=>b.textContent==='确认归档').disabled"
          ),
          true
        )
        await js(
          'document.querySelector(\'[aria-label="忽略备忘时间冲突"]\').click()'
        )
        await js(
          "document.querySelector('.memo-preview').scrollIntoView({block:'end'})"
        )
        await capture('memo-conflict-1024.png')
        await click('确认归档')
        await wait(
          `document.querySelector('[aria-label="备忘归档记录"]')?.innerText.includes('讨论实验报告')`
        )
        const routed = await call('memos', 'get', id),
          route = routed.routes[0],
          task = route.targets.find((t) => t.kind === 'task').target_id
        assert.equal(routed.memo.routed, true)
        assert.equal(
          route.targets.find((t) => t.kind === 'concept').target_id,
          concept.id
        )
        assert.equal(
          (await call('concepts', 'list')).find((c) => c.id === concept.id)
            .summary,
          '人工保留的条件'
        )
        await js(`location.hash='/knowledge?concept=${concept.id}'`)
        await wait('!!document.querySelector(".memo-references a")')
        await js('document.querySelector(".memo-references a").click()')
        await wait(
          `document.querySelector('#memo-version-${initial.memo.revision}')?.textContent.includes('傅氏变换')`
        )
        const edited = content + ' 手工补充：保留原文。'
        await paste('编辑备忘原文', edited)
        await click('保存原文')
        await wait(
          `!!document.querySelector('.memo-receipt')?.innerText.includes('旧修订')`
        )
        assert.equal((await call('memos', 'get', id)).versions.length, 2)
        assert.equal((await call('memos', 'get', id)).memo.content, edited)
        await paste('编辑备忘原文', '未保存的草稿')
        await js(
          'window.confirm=()=>false;document.querySelector(\'a[href="#/knowledge"]\').click()'
        )
        assert.equal(await js('location.hash.startsWith("#/memos")'), true)
        assert.equal(
          await js(
            'document.querySelector(\'[aria-label="编辑备忘原文"]\').textContent'
          ),
          '未保存的草稿'
        )
        const questionLabel = await js(
          "document.querySelector('.quickbar [role=textbox]').getAttribute('aria-label')"
        )
        await paste(questionLabel, '暂时不要离开备忘')
        const callsBeforeQuestion = requests
        await click('询问智能体', '.quickbar')
        await pause(80)
        assert.equal(await js('location.hash.startsWith("#/memos")'), true)
        assert.equal(requests, callsBeforeQuestion)
        await js(
          'window.confirm=()=>true;document.querySelector(\'a[href="#/knowledge"]\').click()'
        )
        await wait('!!document.querySelector(".knowledge-page")')
        await open(id)
        await click('移入回收站')
        await wait(
          'document.querySelector(".memo-detail h2")?.textContent.includes("回收站")'
        )
        await click('恢复备忘')
        await wait(
          'document.querySelector(".memo-detail h2")?.textContent==="备忘原文"'
        )
        await js(
          "document.querySelector('.memo-detail details').open=true;document.querySelector('.memo-detail details').scrollIntoView({block:'end'})"
        )
        await capture('memo-source-and-history-1024.png')
        assert.ok(
          await js(
            "document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.memo-detail input,.memo-detail select,.quickbar button')].every(e=>e.getBoundingClientRect().right<=innerWidth+1)"
          ),
          '1024 宽布局越界'
        )
        const inspiration = await call('inspirations', 'add', {
          content: '灵感独立保留',
          context_text: '选区不变'
        })
        const imported = await call('memos', 'fromInspiration', inspiration.id),
          again = await call('memos', 'fromInspiration', inspiration.id)
        assert.equal(imported.memo.id, again.memo.id)
        assert.ok(
          (await call('inspirations', 'list')).some(
            (i) => i.id === inspiration.id && i.context_text === '选区不变'
          )
        )
        mode = 'hold'
        const concurrent = await call('memos', 'save', {
          content: '异步草稿保护原文',
          subject_id: subject
        })
        const held = await call('memos', 'recognize', {
          id: concurrent.memo.id,
          expected_revision: concurrent.memo.revision,
          model_db_id: model.id
        })
        await open(concurrent.memo.id)
        await wait(
          `document.querySelector('[aria-label="编辑备忘原文"]')?.textContent==='异步草稿保护原文'`
        )
        await paste('编辑备忘原文', '用户尚未保存的内容')
        await call('memos', 'save', {
          id: concurrent.memo.id,
          expected_revision: concurrent.memo.revision,
          content: '其他窗口保存的内容',
          subject_id: subject
        })
        await wait(
          `document.querySelector('.memos-page [role=alert]')?.textContent.includes('其他窗口')`
        )
        assert.equal(
          await js(
            `document.querySelector('[aria-label="编辑备忘原文"]').textContent`
          ),
          '用户尚未保存的内容'
        )
        await call(
          'memos',
          'cancelRecognition',
          held.recognitions.find((j) => j.status === 'running').id
        )
        await click('重新载入')
        await wait(
          `document.querySelector('[aria-label="编辑备忘原文"]')?.textContent==='其他窗口保存的内容'`
        )
        await pause(100)
        const beforeHold = requests
        const pending = await call('memos', 'recognize', {
          id,
          expected_revision: (await call('memos', 'get', id)).memo.revision,
          model_db_id: model.id
        })
        const interrupted = pending.recognitions.find(
          (j) => j.status === 'running'
        ).id
        const until = Date.now() + 8000
        while (requests <= beforeHold) {
          if (Date.now() > until) throw Error('held recognition not started')
          await pause(20)
        }
        fs.writeFileSync(
          path.join(root, 'checkpoint.json'),
          JSON.stringify({
            id,
            edited,
            original: initial.memo.revision,
            task,
            concept: concept.id,
            interrupted
          })
        )
        console.log(
          'MEMOS_NATIVE_OK global math capture, model-only selected source, review draft, alias reuse, conflict override, original history/backlink, navigation and concurrent polling draft guards, trash/restore, inspiration preservation and 1024 layout'
        )
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
