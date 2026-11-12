// 真正启动应用和 preload；使用隔离目录与隐藏窗口，验证笔记统一阅读及跨进程修订。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const run = args => {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...args], { env, windowsHide: true, encoding: 'utf8', timeout: 45_000 })
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'Electron 验收失败'); return result.stdout
  }
  const first = run([]), info = JSON.parse(/NOTE_LEARNING_OK (.+)/.exec(first)[1])
  run(['--resume', info.root]); process.exit(0)
}
const electron = require('electron'), { app } = electron
app.disableHardwareAcceleration()
const resume = process.argv.indexOf('--resume'), root = resume >= 0 ? process.argv[resume + 1] : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-notes-'))
app.setPath('userData', root); app.setPath('sessionData', root)
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1024, height: 768, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) }
  show() {}
}
const Module = require('node:module'), load = Module._load
Module._load = function(request, parent, isMain) { return request === 'electron' ? { ...electron, BrowserWindow: HiddenWindow } : load.call(this, request, parent, isMain) }
const deadline = setTimeout(() => { console.error('NOTE_LEARNING_TIMEOUT'); app.exit(2) }, 40_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code)
    const call = async (method, ...args) => {
      const result = await js(`window.api.notes[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, true, result.error); return result.data
    }
    const wait = async expression => {
      const limit = Date.now() + 8000
      while (!await js(expression)) { if (Date.now() > limit) throw Error(await js('document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 40)) }
    }
    try {
      await wait('!!window.api')
      if (resume >= 0) {
        const saved = JSON.parse(fs.readFileSync(path.join(root, 'note-learning-fixture.json'), 'utf8'))
        const old = await call('learningGet', { note_id: saved.note, revision_id: saved.revision })
        assert.equal(old.sources[0].raw_text, '系统：动量与冲量的定义。')
        assert.equal(old.origins[old.sources[0].id].raw_text, '老师说：动量那个定义。')
        const current = await call('learningGet', { note_id: saved.note })
        assert.equal(current.sources[0].raw_text, '人工校正后的动量定义。')
        assert.equal(current.history.length, 2)
        console.log('NOTE_LEARNING_RESTART_OK'); clearTimeout(deadline); app.exit(0); return
      }
      const note = await call('create', { title: '理论力学 · 动量定理', source: 'manual' })
      const first = await call('addSegment', { note_id: note.id, seg_type: 'definition', raw_text: '老师说：动量那个定义。', organized_text: '系统：动量与冲量的定义。' })
      await call('addSegment', { note_id: note.id, seg_type: 'proof', raw_text: '先从牛顿第二定律来推。', organized_text: '由 $F=ma$ 积分，得到冲量与动量增量的关系。' })
      const initial = await call('learningGet', { note_id: note.id })
      await js(`location.hash=${JSON.stringify('/notes/' + note.id)}`)
      await wait("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='统一文档')")
      await js("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='统一文档').click()")
      await wait("document.querySelectorAll('.learning-entry').length===2")
      assert.equal(await js("document.querySelectorAll('.learning-proof .katex').length"), 1)
      await js("document.querySelector('.learning-reader details').open=true")
      await wait("document.querySelector('.learning-reader details').innerText.includes('老师说')")
      win.setSize(1024, 768)
      // Windows 隐藏离屏窗口的原生边框可能多计 1 DIP；核对实际视口而非只相信 setSize。
      await wait('window.innerWidth<=1025')
      assert.equal(await js("Array.from(document.querySelectorAll('.toolbar button,.learning-toolbar input')).every(element=>element.getBoundingClientRect().right<=innerWidth)"), true, '工具栏不得被窗口裁切')
      await new Promise(resolve => setTimeout(resolve, 120))
      const screenshot = await new Promise((resolve, reject) => {
        const painted = (_event, _rect, image) => { if (image.getSize().width > 1025) return; clearTimeout(timer); win.webContents.removeListener('paint', painted); resolve(image) }
        const timer = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(Error('截图未生成')) }, 4000)
        win.webContents.on('paint', painted); win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, 'note-learning-reader.png'), screenshot.toPNG())
      assert.equal(await js('document.documentElement.scrollWidth>window.innerWidth'), false)
      await js("(()=>{const s=document.querySelector('[aria-label=\"笔记条目类型\"]');s.value='proof';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
      await wait("document.querySelectorAll('.learning-entry').length===1&&!!document.querySelector('.learning-proof')")
      await call('updateSegment', first.id, { organized_text: '人工校正后的动量定义。' })
      const updated = await call('learningGet', { note_id: note.id })
      assert.notEqual(initial.revision_id, updated.revision_id)
      await js("(()=>{const s=document.querySelector('[aria-label=\"笔记条目类型\"]');s.value='';s.dispatchEvent(new Event('change',{bubbles:true}))})()")
      await js("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='读取最新笔记').click()")
      await wait("document.querySelector('.learning-reader').innerText.includes('人工校正后的动量定义。')")
      await js(`(()=>{const s=document.querySelector('[aria-label="笔记修订"]');s.value=${JSON.stringify(initial.revision_id)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await wait("document.querySelector('.learning-reader').innerText.includes('系统：动量与冲量的定义。')&&!document.querySelector('.learning-reader').innerText.includes('人工校正后的动量定义。')")
      await js("document.querySelector('.learning-reader details').open=true;Array.from(document.querySelectorAll('.learning-reader a')).find(link=>link.textContent.startsWith('打开当前原文')).click()")
      await wait("!document.querySelector('.learning-reader')&&document.querySelectorAll('.segment').length===2&&document.querySelector('.segment textarea').value.includes('老师说')")
      fs.writeFileSync(path.join(root, 'note-learning-fixture.json'), JSON.stringify({ note: note.id, revision: initial.revision_id }))
      console.log('NOTE_LEARNING_OK ' + JSON.stringify({ root })); clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1) }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
