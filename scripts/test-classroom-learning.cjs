// 课堂真实 renderer/preload/数据库集成：统一阅读、串行更新、草稿保护和内联回看。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, windowsHide: true, encoding: 'utf8', timeout: 130_000 })
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  assert.equal(result.status, 0, '课堂统一文档验收失败'); process.exit(0)
}
const electron = require('electron'), { app } = electron
app.disableHardwareAcceleration()
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-classroom-format-'))
app.setPath('userData', root); app.setPath('sessionData', root)
let reads = 0, activeReads = 0, maxReads = 0, delayNext = false, delayed, releaseRead, failNext = false, holdSave = false, releaseSave
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1024, height: 768, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) }
  show() {}
}
const Module = require('node:module'), load = Module._load
Module._load = function(request, parent, isMain) {
  if (request !== 'electron') return load.call(this, request, parent, isMain)
  return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showSaveDialog: () => holdSave ? new Promise(resolve => { releaseSave = resolve }) : Promise.resolve({ canceled: true }) },
    ipcMain: { on: electron.ipcMain.on.bind(electron.ipcMain), handle: (channel, handler) => electron.ipcMain.handle(channel, async (...args) => {
      if (channel !== 'notes:learningGet') return handler(...args)
      reads++; activeReads++; maxReads = Math.max(maxReads, activeReads)
      try {
        const result = await handler(...args)
        if (failNext) { failNext = false; return { ok: false, error: '模拟课堂读取失败，可重试' } }
        if (delayNext && !args[1].revision_id) { delayNext = false; delayed = true; await new Promise(resolve => { releaseRead = resolve }) }
        return result
      } finally { activeReads-- }
    }) }
  }
}
let modelText = '模型整理后的新定义。'
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => String(url).startsWith('https://classroom-fixture.invalid') ? new Response('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: JSON.stringify({ seg_type: 'definition', organized_text: modelText }) } }) + '\n\n') : originalFetch(url, options)
const deadline = setTimeout(() => { console.error('CLASSROOM_FORMAT_TIMEOUT'); app.exit(2) }, 120_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(`${error.message}\n表达式：${code.slice(0, 900)}`) })
    const call = async (group, method, ...args) => { const result = await js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`); assert.equal(result.ok, true, result.error); return result.data }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const wait = async expression => { const limit = Date.now() + 9000; while (!await js(expression)) { if (Date.now() > limit) throw Error(`等待失败：${expression}\n${await js('document.body.innerText')}`); await pause(35) } }
    const click = async (label, scope = 'document') => js(`(()=>{const button=Array.from(${scope}.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled||!button.getClientRects().length)throw Error('按钮不可操作：'+${JSON.stringify(label)});button.click();return new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))})()`)
    const input = (selector, value) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),type=element.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    const select = (selector, value) => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    const manual = async text => { await input('[aria-label="课堂手动记录"]', text); await click('添加段落'); await wait("document.querySelector('[aria-label=\"课堂手动记录\"]').value===''") }
    const count = expected => wait(`document.querySelectorAll('.learning-entry').length===${expected}`)
    const capture = async name => {
      await pause(120)
      const image = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { win.webContents.removeListener('paint', painted); reject(Error('截图未生成')) }, 4000)
        const painted = (_event, _rect, frame) => { clearTimeout(timer); win.webContents.removeListener('paint', painted); resolve(frame) }
        win.webContents.on('paint', painted); win.webContents.invalidate()
      })
      fs.writeFileSync(path.join(root, name), image.toPNG())
    }
    let db
    try {
      await wait('!!window.api')
      await call('config', 'set', 'classroom.autoOrganize', '0'); await call('config', 'set', 'asr.model_dir', '')
      const provider = await call('providers', 'save', { name: '课堂模拟模型', base_url: 'https://classroom-fixture.invalid', api_format: 'anthropic', api_key: 'dummy-fixture' })
      await call('models', 'save', { provider_id: provider.id, model_id: 'classroom-fixture' })
      db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      const subject = db.prepare('SELECT id FROM subjects LIMIT 1').get().id
      db.prepare("INSERT INTO materials(id,subject_id,title,kind,created_at) VALUES('class-m',?,'动量讲义','handout',1)").run(subject)
      db.exec("INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('class-v','class-m','动量讲义.docx','docx','unused.docx','hash','ready',1)")
      db.exec("UPDATE materials SET current_version_id='class-v' WHERE id='class-m'")
      for (let index = 0; index < 2; index++) db.prepare('INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES(?,?,?,?,?)').run('class-b' + index, 'class-v', index, index === 0 ? '动量定理与原始定义' : '冲量与应用', JSON.stringify({ kind: 'docx', paragraph: index }))
      const note = await call('notes', 'create', { title: '课堂统一格式验收', subject_id: subject, source: 'class' })
      await call('classroom', 'calibrate', { note_id: note.id, block_id: 'class-b0' })
      const first = await call('notes', 'addSegment', { note_id: note.id, seg_type: 'definition', raw_text: '教师原始转写，动量。', organized_text: '动量初始定义：$p=mv$。' })
      await call('notes', 'addSegment', { note_id: note.id, seg_type: 'proof', raw_text: '教师原始证明。', organized_text: '由 $F=ma$ 积分得到冲量。' })
      const initial = await call('notes', 'learningGet', { note_id: note.id })
      await js(`location.hash=${JSON.stringify('/classroom?note=' + note.id)}`)
      await wait("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='继续课堂'&&!button.disabled)"); await click('继续课堂')
      await wait("!!document.querySelector('.classroom-split')"); await count(2)
      assert.equal(await js("document.querySelector('.classroom-view-tabs button[aria-pressed=true]').textContent"), '统一文档')
      assert.ok(await js("!!document.querySelector('.learning-definition .katex')"))
      const activeSession = () => db.prepare('SELECT count(*) AS n FROM classroom_sessions WHERE note_id=? AND ended_at IS NULL').get(note.id).n
      assert.equal(activeSession(), 1)
      await manual('手动补充完整保存。'); await count(3)
      const final = await call('notes', 'addSegment', { note_id: note.id, raw_text: '语音落段事件已保存。' })
      win.webContents.send('classroom:final', { text: final.raw_text, segment: final }); await count(4)
      await click('下一条', "document.querySelector('.classroom-material')")
      await wait("document.querySelector('.classroom-material h3').textContent.includes('条目 2')"); await click('校准到这里')
      await wait("document.querySelector('.classroom-current').textContent.includes('条目 2')")
      await js("document.querySelector('.learning-entry details').open=true")
      await click('动量讲义 · 条目 1 · 查看来源')
      await wait("document.querySelector('.classroom-material h3').textContent.includes('条目 1')")
      assert.equal((await call('classroom', 'position', note.id)).block.id, 'class-b1')
      assert.ok((await js('location.hash')).startsWith('#/classroom')); assert.equal(activeSession(), 1)
      await click('打开当前原文段落（可能已修改或删除）')
      await wait(`document.querySelector('.classroom-segment-focused')?.dataset.segmentId===${JSON.stringify(first.id)}`)
      assert.ok((await js("document.querySelector('.classroom-segment-focused').innerText")).includes('教师原始转写'))
      assert.equal(activeSession(), 1); await click('统一文档')
      // 跟随关闭时记录继续保存，恢复后一次更新；界面不替代保存层。
      await js("document.querySelector('[aria-label=\"跟随课堂新来源\"]').click()")
      await manual('暂停跟随后保存。'); await pause(400)
      assert.equal(await js("document.querySelectorAll('.learning-entry').length"), 4)
      assert.ok((await js('document.body.innerText')).includes('恢复跟随后更新'))
      await js("document.querySelector('[aria-label=\"跟随课堂新来源\"]').click()"); await count(5)
      // 新来源不卸载未保存表单，切回原文再回来也保留草稿。
      await click('整理条目', "document.querySelector('.learning-entry')"); await input('[aria-label="学习条目标题"]', '尚未保存的标题草稿')
      await manual('编辑期间新增记录。'); await pause(400)
      assert.equal(await js("document.querySelector('[aria-label=\"学习条目标题\"]').value"), '尚未保存的标题草稿')
      assert.equal(await js("document.querySelector('[aria-label=\"笔记修订\"]').disabled"), true)
      await click('原文视图'); await click('统一文档')
      assert.equal(await js("document.querySelector('[aria-label=\"学习条目标题\"]').value"), '尚未保存的标题草稿')
      await js("document.querySelector('[aria-label=\"学习条目标题\"]').scrollIntoView({block:'center'})"); await capture('classroom-live-draft.png')
      await click('收起整理'); await count(6)
      assert.ok(!(await js('document.body.innerText')).includes('尚未保存的标题草稿'))
      // 人工结构保护沿用主进程：自动整理改变原文范围时需要审核同步。
      await click('整理条目', "document.querySelector('.learning-entry')"); await input('[aria-label="学习条目标题"]', '人工保留的定义标题'); await click('保存类型与标题')
      await wait("!document.querySelector('.learning-editor')")
      await call('classroom', 'organizeSegment', first.id)
      await wait("!!document.querySelector('.learning-sync-notice')")
      assert.ok((await js('document.body.innerText')).includes('人工保留的定义标题'))
      await click('预览来源变化'); await wait("!!document.querySelector('.learning-sync-preview')")
      await manual('预览之后新增，旧确认必须拒绝。'); await pause(350)
      await click('确认同步并保存新修订'); await wait("document.querySelector('[role=alert]')?.textContent.includes('重新预览')")
      await click('预览来源变化'); await wait("document.querySelector('.learning-sync-preview').innerText.includes('新增 1 段')")
      await click('确认同步并保存新修订'); await wait("!document.querySelector('.learning-sync-preview')&&!document.querySelector('.learning-sync-notice')")
      await count(7); assert.ok((await js('document.body.innerText')).includes(modelText))
      // 连续新来源只排队一次；被延迟的自动读取不能覆盖后来选定的历史。
      delayed = false; delayNext = true; await manual('慢读取开始。')
      while (!delayed) await pause(15)
      const beforeBurst = reads; maxReads = activeReads
      for (const text of ['连续记录甲。', '连续记录乙。', '连续记录丙。']) await manual(text)
      await pause(350); assert.equal(reads, beforeBurst); assert.equal(maxReads, 1)
      releaseRead(); await count(11)
      assert.ok(reads > beforeBurst, '读取完成后必须处理期间累计的新来源')
      delayed = false; delayNext = true; await manual('历史选择之前再延迟一次读取。')
      while (!delayed) await pause(15)
      await click('阅读与导出选项'); await select('[aria-label="笔记修订"]', initial.revision_id); await count(2)
      releaseRead(); await pause(350)
      assert.equal(await js("document.querySelector('[aria-label=\"笔记修订\"]').value"), initial.revision_id)
      assert.ok((await js('document.body.innerText')).includes('动量初始定义'))
      assert.ok(!await js("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='整理条目')"))
      await manual('历史阅读时继续保存。'); await pause(350); await count(2)
      await click('读取最新笔记'); await count(13)
      // 中间结果与其他笔记的事件不触发全文读取；失败保留当前文档，下次事件可恢复。
      const beforePartial = reads
      for (let index = 0; index < 5; index++) win.webContents.send('classroom:partial', { text: '正在听讲 ' + index })
      win.webContents.send('segment:organized', { segment_id: 'unrelated', seg_type: 'note', organized_text: '其他笔记内容', fallback: false })
      await pause(400); assert.equal(reads, beforePartial)
      failNext = true; await manual('失败后仍已保存的来源。'); await wait("document.querySelector('[role=alert]')?.textContent.includes('模拟课堂读取失败')")
      assert.equal(await js("document.querySelectorAll('.learning-entry').length"), 13)
      await manual('下一次更新恢复。'); await count(15)
      // PDF 保存对话期间也固定阅读版本；取消不阻碍课堂继续记录。
      await click('导出 PDF'); holdSave = true
      await click('选择位置并保存 PDF')
      while (!releaseSave) await pause(10)
      await manual('PDF 保存选择期间的来源。'); await pause(350)
      assert.equal(await js("document.querySelectorAll('.learning-entry').length"), 15)
      releaseSave({ canceled: true }); holdSave = false; await count(16)
      assert.equal(activeSession(), 1)
      await click('阅读与导出选项'); await js("document.querySelector('.classroom-transcript-scroll').scrollTop=0")
      assert.equal(await js('document.documentElement.scrollWidth>innerWidth'), false)
      assert.equal(await js("Array.from(document.querySelectorAll('.classroom-transcript button,.classroom-transcript select')).filter(element=>element.getClientRects().length).every(element=>element.getBoundingClientRect().right<=innerWidth+1)"), true)
      await capture('classroom-uniform-reader.png')
      await click('结束课堂'); await wait("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='继续课堂')")
      assert.equal(activeSession(), 0)
      const finalDocument = await call('notes', 'learningGet', { note_id: note.id })
      assert.equal(finalDocument.state.entries.length, 16)
      assert.equal((await call('notes', 'learningGet', { note_id: note.id, revision_id: initial.revision_id })).state.entries.length, 2)
      db.close(); db = undefined
      console.log('CLASSROOM_FORMAT_OK', JSON.stringify({ root, entries: 16, reads, checks: 'manual/final/organized, follow/pause, draft, history, queued reads, late responses, source preview, inline links, retry, export pause, active session, 1024 layout' })); clearTimeout(deadline); app.exit(0)
    } catch (error) { console.error(error.stack || error); if (db) db.close(); clearTimeout(deadline); app.exit(1) }
  })
})
require('../out/main/index.js')
