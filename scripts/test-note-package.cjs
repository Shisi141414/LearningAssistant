// 隐藏真实窗口：固定笔记包导出、工作线程读回、安全保存、取消及重启。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const run = args => {
    const r = require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, windowsHide: true, encoding: 'utf8', timeout: 60_000 })
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); if (r.error) throw r.error
    assert.equal(r.status, 0, '笔记文档包验收失败'); return r.stdout
  }
  const first = run([]), info = JSON.parse(/NOTE_PACKAGE_OK (.+)/.exec(first)[1]); run(['--resume', info.root]); process.exit(0)
}
const electron = require('electron'), { app } = electron
app.disableHardwareAcceleration()
const resume = process.argv.indexOf('--resume'), root = resume >= 0 ? process.argv[resume + 1] : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-note-export-'))
app.setPath('userData', root); app.setPath('sessionData', root)
let savePath, holdExport = false, held = false
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1024, height: 768, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) }
  show() {}
}
const RealWorker = require('node:worker_threads').Worker
class ControlledWorker extends RealWorker {
  constructor(file, options) {
    if (holdExport && String(file).endsWith('learning-package-worker.js') && options?.workerData?.action === 'note-write') { held = true; super('setInterval(()=>{},1000)', { eval: true }) }
    else super(file, options)
  }
}
const Module = require('node:module'), load = Module._load
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showSaveDialog: async () => savePath ? { canceled: false, filePath: savePath } : { canceled: true } } }
  if (request === 'node:worker_threads') return { ...load.call(this, request, parent, isMain), Worker: ControlledWorker }
  return load.call(this, request, parent, isMain)
}
function decode(file) {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-note-read-'))
  return new Promise((resolve, reject) => {
    const worker = new RealWorker(path.join(__dirname, '../out/main/learning-package-worker.js'), { workerData: { action: 'note-read', file, directory } })
    worker.once('message', msg => { void worker.terminate(); msg.type === 'done' ? resolve(msg.result) : reject(Error(msg.error)) }); worker.once('error', reject)
  })
}
const deadline = setTimeout(() => { console.error('NOTE_PACKAGE_TIMEOUT'); app.exit(2) }, 55_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code).catch(e => { throw Error(`${e.message}\n表达式：${code.slice(0, 600)}`) })
    const call = async (group, method, ...args) => { const r = await js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`); assert.equal(r.ok, true, r.error); return r.data }
    const pause = ms => new Promise(r => setTimeout(r, ms))
    const wait = async expr => { const end = Date.now() + 8000; while (!await js(expr)) { if (Date.now() > end) throw Error(`等待失败：${expr}\n${await js('document.body.innerText')}`); await pause(30) } }
    const click = label => js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled||!b.getClientRects().length)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return new Promise(r=>requestAnimationFrame(()=>r(true)))})()`)
    const openNote = async note => { await js(`location.hash='/notes/${note}'`); await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='统一文档')"); await click('统一文档'); await wait("!!document.querySelector('.learning-note-package')") }
    try {
      await wait('!!window.api')
      if (resume >= 0) {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'note-package-checkpoint.json'), 'utf8'))
        const decoded = await decode(saved.output)
        assert.deepEqual(decoded.manifest.state, saved.state); assert.deepEqual(decoded.manifest.origins, saved.origins); assert.equal(decoded.files.length, 0)
        assert.equal((await call('notes', 'learningGet', saved.input)).revision_id, saved.input.revision_id)
        savePath = path.join(saved.outputRoot, '重启后.ladoc'); const result = await call('notes', 'packageExport', saved.input)
        assert.equal(result.revision_id, saved.input.revision_id)
        assert.deepEqual((await decode(savePath)).manifest.state, saved.state)
        console.log('NOTE_PACKAGE_RESTART_OK fixed state, original transcript, references and worker decode after real restart'); clearTimeout(deadline); app.exit(0); return
      }
      const outputRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-note-export-files-'))
      await call('providers', 'save', { name: '不应进入文档包的配置', base_url: 'https://private.invalid', api_format: 'openai', api_key: 'dummy-sensitive-key' })
      const note = await call('notes', 'create', { title: '动量定理导出', source: 'manual' })
      const first = await call('notes', 'addSegment', { note_id: note.id, raw_text: '老师的原始口述😀：冲量。', organized_text: '动量公式：p=mv。\n证明：由第二定律积分。' })
      await call('notes', 'addSegment', { note_id: note.id, raw_text: '第二段必须完整导出。' })
      let doc = await call('notes', 'learningGet', { note_id: note.id })
      doc = await call('notes', 'learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[0].id, action: 'edit', type: 'theorem', title: '动量关系' })
      doc = await call('notes', 'learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[0].id, action: 'formula', formula: { range: [5, 9], latex: 'p = mv', display: true } })
      await call('annotations', 'add', { segment_id: first.id, kind: 'keypoint', comment: '导出重点' })
      await call('evidence', 'createConcept', { concept: { subject_id: null, name: '动量', summary: '定义', aliases: ['冲量'] }, source: { kind: 'note', note_id: note.id, segment_id: first.id, field: 'organized_text' }, expected_note_text: first.organized_text, role: 'source', memo: '证据' })
      await call('concepts', 'save', { subject_id: null, name: '不相关概念', summary: '', aliases: [] })
      const input = { note_id: note.id, revision_id: doc.revision_id }
      await call('notes', 'updateSegment', first.id, { organized_text: '最新整理稿不应混入旧修订。' })
      await call('notes', 'addSegment', { note_id: note.id, raw_text: '随后课堂追加。' })
      await openNote(note.id)
      await js(`(()=>{const s=document.querySelector('[aria-label="笔记修订"]');s.value=${JSON.stringify(doc.revision_id)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await wait("document.querySelector('.learning-reader').innerText.includes('第二段必须完整导出')")
      await click('导出笔记文档包'); await wait("document.querySelector('.learning-note-package').innerText.includes('已取消保存')")
      savePath = path.join(root, '受保护.ladoc'); await click('导出笔记文档包'); await wait("document.querySelector('.learning-note-package').innerText.includes('应用数据目录以外')")
      assert.equal(fs.existsSync(savePath), false)
      savePath = path.join(outputRoot, '课堂笔记.ladoc'); fs.writeFileSync(savePath, '旧目标')
      await js("(()=>{const e=document.querySelector('[aria-label=" + JSON.stringify('检索整理稿') + "]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'不存在的筛选');e.dispatchEvent(new Event('input',{bubbles:true}))})()")
      await wait("!document.querySelector('.learning-reader > .learning-entry')")
      await click('导出笔记文档包'); await wait("document.querySelector('.learning-note-package').innerText.includes('已保存')")
      const decoded = await decode(savePath), manifest = decoded.manifest
      assert.deepEqual(manifest.state, doc.state); assert.deepEqual(manifest.sources, doc.sources); assert.deepEqual(manifest.origins, doc.origins)
      assert.equal(manifest.annotations[0].matches_revision, false); assert.equal(manifest.evidence[0].matches_revision, true)
      assert.equal(manifest.concepts.length, 1); assert.equal(JSON.stringify(manifest).includes('dummy-sensitive-key'), false); assert.equal(JSON.stringify(manifest).includes('private.invalid'), false)
      assert.equal(JSON.stringify(manifest).includes('随后课堂追加'), false)
      assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false)
      await js("document.querySelector('.learning-note-package').scrollIntoView({block:'center'})"); await pause(120)
      const frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(Error('截图未生成')) }, 4000)
        const painted = (_event, _rect, image) => { clearTimeout(timer); win.webContents.removeListener('paint', painted); resolve(image) }
        win.webContents.on('paint', painted); win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, 'note-package-export.png'), frame.toPNG())
      const output = savePath, bytes = fs.readFileSync(output)
      holdExport = true; held = false; await click('导出笔记文档包')
      for (let i = 0; i < 100 && !held; i++) await pause(20)
      assert.equal(held, true)
      assert.equal(await js("document.querySelector('[aria-label=" + JSON.stringify('笔记修订') + "]').disabled"), true)
      const concurrent = await js(`window.api.notes.packageExport(${JSON.stringify(input)})`); assert.equal(concurrent.ok, false); assert.match(concurrent.error, /已有文档/)
      await click('取消笔记导出'); await wait("document.querySelector('.learning-note-package').innerText.includes('已取消')"); holdExport = false
      assert.deepEqual(fs.readFileSync(output), bytes)
      assert.equal(fs.readdirSync(outputRoot).some(name => name.startsWith('.ladoc-export-')), false)
      fs.writeFileSync(path.join(root, 'note-package-checkpoint.json'), JSON.stringify({ input, outputRoot, output, state: doc.state, origins: doc.origins }))
      console.log('NOTE_PACKAGE_OK', JSON.stringify({ root, entries: manifest.state.entries.length, checks: 'historical UI save, all filtered entries, original/source/formula/annotation/evidence, private config exclusion, protected target, concurrency/cancel cleanup, worker ZIP decode' })); clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error.stack || error); clearTimeout(deadline); app.exit(1) }
  })
})
require('../out/main/index.js')
