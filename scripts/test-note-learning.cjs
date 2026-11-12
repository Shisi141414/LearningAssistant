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
    const js = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(`${error.message}\n表达式：${code.slice(0, 1000)}`) })
    const call = async (method, ...args) => {
      const result = await js(`window.api.notes[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, true, result.error); return result.data
    }
    const wait = async expression => {
      const limit = Date.now() + 8000
      while (!await js(expression)) { if (Date.now() > limit) throw Error(await js('document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 40)) }
    }
    const click = async (label, scope = 'document') => js(`(()=>{const button=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('按钮不可操作：'+${JSON.stringify(label)});button.click();return new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))})()`)
    const input = async (selector, value) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const select = async (selector, value) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const article = index => `document.querySelectorAll('.learning-entry')[${index}]`
    const capture = async name => {
      await new Promise(resolve => setTimeout(resolve, 120))
      const image = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(Error('截图未生成')) }, 4000)
        const painted = (_event, _rect, frame) => { clearTimeout(timer); win.webContents.removeListener('paint', painted); resolve(frame) }
        win.webContents.on('paint', painted); win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, name), image.toPNG())
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
        const semantic = await call('learningGet', { note_id: saved.editor_note, revision_id: saved.editor_revision })
        assert.equal(semantic.state.entries[1].title, '动量定理一')
        assert.equal(semantic.state.relations.length, 1)
        assert.equal(semantic.state.entries[3].formulas[0].latex, 'F = ma')
        assert.equal(semantic.state.entries[1].formulas[0].latex, 'p = mv')
        const semanticCurrent = await call('learningGet', { note_id: saved.editor_note })
        assert.equal(semanticCurrent.pending_sync, undefined)
        assert.equal(semanticCurrent.state.entries.some(entry => entry.title === '动量定理一'), false)
        assert.equal(semanticCurrent.state.entries.find(entry => entry.id === semantic.state.entries[3].id).formulas[0].latex, 'F = ma')
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
      await js("document.querySelector('.learning-entry details').open=true")
      await wait("document.querySelector('.learning-entry details').innerText.includes('老师说')")
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
      await js("document.querySelector('.learning-entry details').open=true;Array.from(document.querySelectorAll('.learning-reader a')).find(link=>link.textContent.startsWith('打开当前原文')).click()")
      await wait("!document.querySelector('.learning-reader')&&document.querySelectorAll('.segment').length===2&&document.querySelector('.segment textarea').value.includes('老师说')")
      const editorNote = await call('create', { title: '课堂结构编辑验收', source: 'manual' })
      const editorSegments = []
      for (const value of ['第一章', 'p=mv😀\n证明开始\n证明结束', '补充说明：F=ma']) editorSegments.push(await call('addSegment', { note_id: editorNote.id, raw_text: value }))
      await js(`location.hash=${JSON.stringify('/notes/' + editorNote.id)}`)
      await wait("document.querySelector('input').value==='课堂结构编辑验收'")
      await click('统一文档'); await wait("document.querySelectorAll('.learning-entry').length===3")
      await click('整理条目', article(1)); await select('[aria-label="条目语义类型"]', 'theorem'); await input('[aria-label="学习条目标题"]', '动量定理一'); await click('保存类型与标题')
      await wait("document.querySelector('.learning-theorem h3')?.textContent==='动量定理一'&&!document.querySelector('.learning-editor')")
      await click('整理条目', article(1))
      await js("(()=>{const text=document.querySelector('[aria-label=\"选择学习条目拆分位置\"]');text.setSelectionRange(6,6);text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))})()")
      await click('在光标处拆分'); await wait("document.querySelectorAll('.learning-entry').length===4&&!document.querySelector('.learning-editor')")
      await click('整理条目', article(2)); await select('[aria-label="条目语义类型"]', 'proof'); await input('[aria-label="学习条目标题"]', '课堂证明'); await click('保存类型与标题')
      await wait("!!document.querySelector('.learning-proof')&&!document.querySelector('.learning-editor')")
      let semantic = await call('learningGet', { note_id: editorNote.id })
      await click('整理条目', article(2)); await select('[aria-label="学习条目关联目标"]', semantic.state.entries[1].id); await click('保存关联')
      await wait("!!document.querySelector('.learning-relation')&&!document.querySelector('.learning-editor')")
      await click('整理条目', article(0)); await select('[aria-label="条目语义类型"]', 'section'); await input('[aria-label="学习条目标题"]', '第一章 动量'); await click('保存类型与标题')
      await wait("!!document.querySelector('.learning-section')&&!document.querySelector('.learning-editor')")
      semantic = await call('learningGet', { note_id: editorNote.id })
      await click('整理条目', article(1)); await select('[aria-label="学习条目父章节"]', semantic.state.entries[0].id); await select('[aria-label="章节归属结束条目"]', semantic.state.entries[3].id); await click('保存章节归属')
      await wait("document.querySelectorAll('.learning-breadcrumb').length===3&&!document.querySelector('.learning-editor')")
      await click('整理条目', article(3))
      await js("(()=>{const text=document.querySelector('[aria-label=\"选择学习条目拆分位置\"]'),start=text.value.indexOf('F=ma');text.setSelectionRange(start,start+4);text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));const latex=document.querySelector('[aria-label=\"公式 LaTeX\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(latex,'F = ma');latex.dispatchEvent(new Event('input',{bubbles:true}))})()")
      await click('保存公式校正'); await wait("!!document.querySelector('.learning-formula')&&!document.querySelector('.learning-editor')")
      await click('整理条目', article(1))
      await js("(()=>{const text=document.querySelector('[aria-label=\"选择学习条目拆分位置\"]');text.setSelectionRange(0,4);text.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));const latex=document.querySelector('[aria-label=\"公式 LaTeX\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(latex,'p = mv');latex.dispatchEvent(new Event('input',{bubbles:true}))})()")
      await click('保存公式校正'); await wait("document.querySelectorAll('.learning-formula').length===2&&!document.querySelector('.learning-editor')")
      semantic = await call('learningGet', { note_id: editorNote.id })
      assert.equal(semantic.state.relations.length, 1); assert.equal(semantic.state.entries[3].formulas[0].latex, 'F = ma')
      await js("document.querySelector('.learning-theorem').scrollIntoView({block:'start'})"); await capture('note-learning-structures.png')
      await call('addSegment', { note_id: editorNote.id, raw_text: '课堂继续追加一段' })
      await click('读取最新笔记'); await wait("document.querySelectorAll('.learning-entry').length===5")
      assert.equal(await js("!!document.querySelector('.learning-theorem')&&!!document.querySelector('.learning-formula')&&!!document.querySelector('.learning-relation')"), true)
      const beforeChange = await call('learningGet', { note_id: editorNote.id })
      await call('updateSegment', editorSegments[1].id, { organized_text: '模型或人工重新整理后的新内容' })
      await click('读取最新笔记'); await wait("!!document.querySelector('.learning-sync-notice')")
      assert.equal(await js("!!document.querySelector('.learning-theorem')"), true)
      await click('预览来源变化'); await wait("!!document.querySelector('.learning-sync-preview')")
      assert.equal(await js("document.querySelector('.learning-sync-preview').innerText.includes('移除 1 个公式校正')&&document.querySelector('.learning-sync-preview code').textContent==='p = mv'"), true)
      await js("document.querySelector('.learning-sync-preview details').open=true;document.querySelector('.learning-sync-preview').scrollIntoView({block:'start'})")
      await capture('note-learning-sync-preview.png')
      assert.equal(await js("Array.from(document.querySelectorAll('.learning-sync-preview button')).every(element=>element.getBoundingClientRect().right<=innerWidth)"), true)
      await call('addSegment', { note_id: editorNote.id, raw_text: '预览之后又来一段' })
      await click('确认同步并保存新修订'); await wait("document.querySelector('[role=alert]')?.textContent.includes('重新预览')")
      assert.equal(await js("!!document.querySelector('.learning-theorem')"), true)
      await click('预览来源变化'); await wait("document.querySelector('.learning-sync-preview').innerText.includes('新增 1 段')")
      await click('关闭同步预览'); await wait("!document.querySelector('.learning-sync-preview')")
      assert.equal((await call('learningGet', { note_id: editorNote.id })).revision_id, beforeChange.revision_id)
      await click('预览来源变化'); await wait("!!document.querySelector('.learning-sync-preview')"); await click('确认同步并保存新修订')
      await wait("!document.querySelector('.learning-sync-preview')&&!document.querySelector('.learning-sync-notice')&&!document.querySelector('.learning-theorem')&&!!document.querySelector('.learning-formula')")
      await select('[aria-label="笔记修订"]', beforeChange.revision_id)
      await wait("!!document.querySelector('.learning-theorem')&&!Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='整理条目')")
      fs.writeFileSync(path.join(root, 'note-learning-fixture.json'), JSON.stringify({ note: note.id, revision: initial.revision_id, editor_note: editorNote.id, editor_revision: beforeChange.revision_id }))
      console.log('NOTE_EDITOR_OK shared editor, split, theorem/proof relation, chapter, formula, append, protected sync preview/cancel/stale confirmation/history')
      console.log('NOTE_LEARNING_OK ' + JSON.stringify({ root })); clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1) }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
