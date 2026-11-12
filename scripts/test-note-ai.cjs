// 真实 Electron + preload + 主进程 + 数据库：笔记/课堂 AI 审核与重启。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const run = args => {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, windowsHide: true, encoding: 'utf8', timeout: 70_000 })
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, '笔记 AI 界面验收失败'); return result.stdout
  }
  const first = run([]), info = JSON.parse(/NOTE_AI_OK (.+)/.exec(first)[1])
  run(['--resume', info.root]); process.exit(0)
}
const electron = require('electron'), { app } = electron
app.disableHardwareAcceleration()
const resume = process.argv.indexOf('--resume'), root = resume >= 0 ? process.argv[resume + 1] : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-note-ai-'))
app.setPath('userData', root); app.setPath('sessionData', root)
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1024, height: 768, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) }
  show() {}
}
const Module = require('node:module'), load = Module._load
Module._load = function(request, parent, isMain) { return request === 'electron' ? { ...electron, BrowserWindow: HiddenWindow } : load.call(this, request, parent, isMain) }
let requests = 0, mode = 'valid', lastBody
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://note-ai-fixture.invalid')) return originalFetch(url, options)
  requests++; lastBody = JSON.parse(options.body)
  const fragments = JSON.parse(lastBody.messages.find(m => m.role === 'user').content)
  const value = { entries: [{ start: fragments[0].id, end: fragments[0].id, type: 'theorem', title: '动量定理候选' }, { start: fragments[1].id, end: fragments.at(-1).id, type: 'proof', title: '积分证明候选' }], relations: [{ from: 1, to: 0, type: 'proves' }] }
  if (mode === 'missing') { value.entries.pop(); value.relations = [] }
  return new Response('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: JSON.stringify(value) } }) + '\n\n')
}
const deadline = setTimeout(() => { console.error('NOTE_AI_TIMEOUT'); app.exit(2) }, 65_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(`${error.message}\n表达式：${code.slice(0, 900)}`) })
    const call = async (group, method, ...args) => { const result = await js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`); assert.equal(result.ok, true, result.error); return result.data }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const wait = async expression => { const end = Date.now() + 8000; while (!await js(expression)) { if (Date.now() > end) throw Error(`等待失败：${expression}\n${await js('document.body.innerText')}`); await pause(35) } }
    const click = (label, scope = 'document') => js(`(()=>{const b=Array.from(${scope}.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled||!b.getClientRects().length)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return new Promise(r=>requestAnimationFrame(()=>r(true)))})()`)
    const open = async () => { await js("document.querySelector('.learning-suggestions').open=true"); await wait("!!document.querySelector('[aria-label=\"语义整理模型\"]')?.value") }
    const close = async () => { await js("document.querySelector('.learning-suggestions').open=false"); await wait("!document.querySelector('.learning-suggestion-editor')") }
    const count = n => wait(`document.querySelectorAll('.learning-reader > .learning-entry').length===${n}`)
    const capture = async name => {
      await pause(120)
      const frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(Error('截图未生成')) }, 4000)
        const painted = (_e, _rect, frame) => { clearTimeout(timer); win.webContents.removeListener('paint', painted); resolve(frame) }
        win.webContents.on('paint', painted); win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, name), frame.toPNG())
    }
    try {
      await wait('!!window.api')
      if (resume >= 0) {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'note-ai-checkpoint.json'), 'utf8'))
        const doc = await call('notes', 'learningGet', { note_id: saved.note })
        assert.equal(doc.state.entries[0].title, '动量定理候选'); assert.equal(doc.state.relations[0].type, 'proves')
        assert.equal((await call('notes', 'learningSuggestGet', saved.applied)).status, 'applied')
        assert.equal((await call('notes', 'learningSuggestGet', saved.ready)).status, 'ready')
        const interrupted = await call('notes', 'learningSuggestGet', saved.interrupted)
        assert.equal(interrupted.status, 'cancelled'); assert.match(interrupted.error, /未自动发送/)
        assert.equal(requests, 0)
        assert.deepEqual((await call('notes', 'learningGet', { note_id: saved.note, revision_id: saved.initial })).state, saved.initialState)
        await js(`location.hash='/notes/${saved.classroom}'`); await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='统一文档')"); await click('统一文档'); await count(3); await open()
        await wait("document.querySelector('.learning-suggestion-result')?.innerText.includes('上次生成已中断')")
        console.log('NOTE_AI_RESTART_OK persisted candidates, source/history, interrupted recovery without model request'); clearTimeout(deadline); app.exit(0); return
      }
      await call('config', 'set', 'classroom.autoOrganize', '0'); await call('config', 'set', 'asr.model_dir', '')
      const provider = await call('providers', 'save', { name: '笔记审核模拟', base_url: 'https://note-ai-fixture.invalid', api_format: 'anthropic', api_key: 'note-ui-dummy' })
      const model = await call('models', 'save', { provider_id: provider.id, model_id: 'note-ui-model' })
      const create = async source => {
        const note = await call('notes', 'create', { title: '动量定理课堂审核', source })
        await call('notes', 'addSegment', { note_id: note.id, raw_text: '老师的口述原文😀。', organized_text: '定理：冲量等于动量变化。\n证明：由牛顿第二定律积分。' })
        await call('notes', 'addSegment', { note_id: note.id, raw_text: '禁止发送的人工条目。' })
        let doc = await call('notes', 'learningGet', { note_id: note.id })
        doc = await call('notes', 'learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[1].id, action: 'edit', type: 'definition', title: '人工保留标题' })
        return { note, doc }
      }
      const { note, doc } = await create('manual')
      await js(`location.hash='/notes/${note.id}'`); await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='统一文档')"); await click('统一文档'); await count(2); await open()
      await click('生成本批建议（发送文字）'); await wait("document.querySelector('.learning-suggestion-result')?.innerText.includes('等待审核')")
      assert.equal((await call('notes', 'learningGet', { note_id: note.id })).revision_id, doc.revision_id)
      assert.equal(JSON.stringify(lastBody).includes('禁止发送'), false); assert.equal(JSON.stringify(lastBody).includes('老师的口述'), false)
      await js("document.querySelector('.learning-suggestion-result').scrollIntoView({block:'start'})"); await capture('note-ai-review.png')
      assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false)
      await click('采纳为新修订'); await count(3)
      const applied = (await call('notes', 'learningSuggestList', note.id))[0]
      assert.equal(applied.status, 'applied'); assert.equal((await call('notes', 'get', note.id)).segments[0].raw_text, '老师的口述原文😀。')
      await close()
      await js(`(()=>{const s=document.querySelector('[aria-label="笔记修订"]');s.value=${JSON.stringify(doc.revision_id)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await count(2); assert.equal(await js("!!document.querySelector('.learning-suggestions')"), false)
      await click('读取最新笔记'); await count(3)

      const classroom = await create('class')
      await js(`location.hash='/classroom?note=${classroom.note.id}'`); await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='继续课堂'&&!b.disabled)"); await click('继续课堂'); await count(2); await open()
      await click('生成本批建议（发送文字）'); await wait("document.querySelector('.learning-suggestion-result')?.innerText.includes('等待审核')")
      const ready = (await call('notes', 'learningSuggestList', classroom.note.id))[0]
      await js("document.querySelector('.learning-suggestion-result').scrollIntoView({block:'start'})"); await capture('classroom-ai-review.png')
      assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false)
      assert.equal(await js("Array.from(document.querySelectorAll('.learning-suggestion-editor select,.learning-suggestion-editor input,.learning-suggestion-editor button')).every(e=>e.getBoundingClientRect().right<=innerWidth)"), true)
      await call('notes', 'addSegment', { note_id: classroom.note.id, raw_text: '随后继续保存的新讲授。' })
      // 广播模拟识别完成：持久化先于通知，仍走课堂实际事件订阅。
      const latest = await call('notes', 'get', classroom.note.id), added = latest.segments.at(-1)
      win.webContents.send('classroom:final', { note_id: classroom.note.id, segment: added })
      await pause(450); await count(2)
      await click('采纳为新修订'); await wait("document.querySelector('.learning-suggestion-editor')?.innerText.includes('笔记或来源已有变化')")
      await close(); await count(3)
      await open(); await wait("document.querySelector('.learning-suggestion-result')?.innerText.includes('等待审核')")
      assert.equal(await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='采纳为新修订').disabled"), true)
      await click('放弃建议'); await close()
      mode = 'missing'; await open(); await click('生成本批建议（发送文字）'); await wait("document.querySelector('.learning-suggestion-result')?.innerText.includes('生成失败')"); await close(); mode = 'valid'
      await click('结束课堂')
      const db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      assert.equal(db.prepare('SELECT count(*) n FROM classroom_sessions WHERE ended_at IS NULL').get().n, 0)
      // 建立真实已验证候选，再将其标为崩溃前运行中，验证下次启动恢复。
      const current = await call('notes', 'learningGet', { note_id: classroom.note.id })
      const generateReady = async () => {
        const job = await call('notes', 'learningSuggestStart', { note_id: classroom.note.id, expected_revision_id: current.revision_id, entry_ids: [current.state.entries[0].id], model_db_id: model.id })
        let detail
        for (let i = 0; i < 100; i++) { detail = await call('notes', 'learningSuggestGet', job.id); if (detail.status !== 'running') break; await pause(20) }
        assert.equal(detail.status, 'ready'); return job
      }
      const pending = await generateReady(), interrupted = await generateReady()
      db.prepare("UPDATE note_learning_suggestions SET status='running' WHERE id=?").run(interrupted.id); db.close()
      fs.writeFileSync(path.join(root, 'note-ai-checkpoint.json'), JSON.stringify({ note: note.id, classroom: classroom.note.id, initial: doc.revision_id, initialState: doc.state, applied: applied.id, ready: pending.id, interrupted: interrupted.id }))
      console.log('NOTE_AI_OK', JSON.stringify({ root, checks: 'real review/adopt, selected sources, protected entry, history, classroom pause and stale refusal, invalid model, restart recovery' })); clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error.stack || error); clearTimeout(deadline); app.exit(1) }
  })
})
require('../out/main/index.js')
