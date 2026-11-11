// 实际 Electron 主进程、preload、renderer 与工作线程集成测试；仅使用隔离数据目录。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, windowsHide: true, encoding: 'utf8', timeout: 100_000 })
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  const first = /MATERIAL_TEST_OK (.+)/.exec(result.stdout)
  assert.ok(first, '首轮结果缺失')
  const info = JSON.parse(first[1])
  const resume = require('node:child_process').spawnSync(require('electron'), [__filename, '--material-resume', info.isolatedData, info.resumeId], { env, windowsHide: true, encoding: 'utf8', timeout: 30_000 })
  process.stdout.write(resume.stdout || ''); process.stderr.write(resume.stderr || '')
  if (resume.error) console.error(resume.error.message)
  process.exit(resume.status ?? 1)
}
const electron = require('electron')
const { app } = electron
const resumeIndex = process.argv.indexOf('--material-resume')
const root = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-materials-'))
app.setPath('userData', root); app.setPath('sessionData', root)
const { zipSync, strToU8 } = require('fflate')
const source = path.join(root, 'fixtures'); fs.mkdirSync(source, { recursive: true })
function zip(name, entries) {
  const file = path.join(source, name)
  fs.writeFileSync(file, zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)]))))
  return file
}
const relHeader = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
function docx(name, text) {
  return zip(name, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': relHeader + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>质量</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>加速度</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`
  })
}
const doc1 = docx('力学讲义.docx', '牛顿第二定律：力等于质量乘以加速度。')
const doc2 = docx('力学讲义修订.docx', '修订内容：动量随时间的变化率等于力。')
const slide = text => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
const ppt = zip('课件.pptx', {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  '_rels/.rels': relHeader + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': relHeader + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': slide('Second slide'), 'ppt/slides/slide2.xml': slide('First slide')
})
function pdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Mechanics page one) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let data = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(data)
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  const file = path.join(source, '教材.pdf'); fs.writeFileSync(file, data); return file
}
const pdfFile = pdf()
const broken = path.join(source, '损坏.docx'); fs.writeFileSync(broken, 'not a document')
let selectedFile
const opened = []
const problems = []
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }) }
  show() {}
}
const Module = require('node:module'), originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: !selectedFile, filePaths: selectedFile ? [selectedFile] : [] }) }, shell: { ...electron.shell, openPath: async file => { opened.push(file); return '' } } }
  return originalLoad.call(this, request, parent, isMain)
}
const deadline = setTimeout(() => { console.error('MATERIAL_TEST_TIMEOUT'); app.exit(2) }, 90_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('preload-error', (_e, _file, error) => problems.push(error.message))
  win.webContents.on('render-process-gone', (_e, info) => problems.push(info.reason))
  win.webContents.once('did-finish-load', async () => {
    const call = async (group, method, ...args) => {
      const result = await win.webContents.executeJavaScript(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, true, result.error); return result.data
    }
    const fail = async (method, ...args) => {
      const result = await win.webContents.executeJavaScript(`window.api.materials[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, false); return result.error
    }
    const importFile = async (file, input) => { selectedFile = file; return call('materials', 'import', input) }
    const waitUi = async (expression, label) => {
      const timeout = Date.now() + 12_000
      while (!await win.webContents.executeJavaScript(expression)) {
        if (Date.now() > timeout) throw Error(label + ': ' + await win.webContents.executeJavaScript('document.body.innerText.slice(-2500)'))
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    }
    const click = async (text, scope = 'document') => win.webContents.executeJavaScript(`Array.from(${scope}.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    const enterManual = async text => {
      await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.classroom-transcript textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
      await click('添加段落', "document.querySelector('.classroom-transcript')")
    }
    const wait = async (id, expected = 'ready') => {
      const timeout = Date.now() + 15_000
      while (true) {
        const detail = await call('materials', 'get', id), v = detail.versions[0]
        if (!['queued', 'parsing'].includes(v.status)) { assert.equal(v.status, expected, v.error); return v }
        if (Date.now() > timeout) throw Error('材料解析超时')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    try {
      if (resumeIndex >= 0) {
        const resumed = await wait(process.argv[resumeIndex + 2])
        assert.match((await call('materials', 'blocks', { version_id: resumed.id })).blocks[0].text, /恢复任务/)
        const savedClass = JSON.parse(fs.readFileSync(path.join(root, 'classroom-test.json'), 'utf8'))
        assert.equal((await call('classroom', 'position', savedClass.noteId)).block.id, savedClass.blockId)
        assert.equal((await call('notes', 'get', savedClass.noteId)).segments[0].material_ref.id, savedClass.firstBlockId)
        const recoveredDb = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
        assert.equal(recoveredDb.prepare('SELECT end_reason FROM classroom_sessions WHERE id = ?').get('interrupted-classroom-fixture').end_reason, 'interrupted')
        recoveredDb.close()
        await win.webContents.executeJavaScript(`location.hash = '/classroom?note=${savedClass.noteId}'`)
        await waitUi(`document.querySelector('.classroom-current')?.textContent.includes('第 2 页') && Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='继续课堂' && !b.disabled)`, '重启后恢复课堂位置')
        await click('继续课堂')
        await waitUi(`!!document.querySelector('.classroom-split')`, '恢复已有课堂')
        await enterManual('重启后继续记录')
        await waitUi(`document.querySelectorAll('.classroom-transcript .segment').length === 3`, '重启后追加记录')
        assert.equal((await call('notes', 'get', savedClass.noteId)).segments[2].material_ref.id, savedClass.blockId)
        await click('结束课堂')
        console.log('MATERIAL_RESTART_OK import recovery and classroom position, historical references, continued recording survived a real app restart')
        clearTimeout(deadline); app.quit(); return
      }
      const subjects = await call('subjects', 'list'), input = { subject_id: subjects[0].id, kind: 'handout' }
      await fail('import', { ...input, arbitrary_path: doc1 })
      const cancelledDialog = await call('materials', 'import', input); assert.equal(cancelledDialog, null)
      const first = await importFile(doc1, input), v1 = await wait(first.id)
      const b1 = await call('materials', 'blocks', { version_id: v1.id })
      assert.match(b1.blocks.map(b => b.text).join(''), /牛顿第二定律/)
      assert.match(b1.blocks.map(b => b.text).join(''), /质量/)
      assert.ok(!JSON.stringify(await call('materials', 'get', first.id)).includes('file_path'))
      await call('materials', 'open', v1.id)
      assert.deepEqual(fs.readFileSync(opened[0]), fs.readFileSync(doc1))
      await fail('open', '../not-a-version')
      const duplicate = await importFile(doc1, input); assert.equal(duplicate.id, first.id)
      assert.equal((await call('materials', 'get', first.id)).versions.length, 1)
      await importFile(doc2, { ...input, material_id: first.id }); const v2 = await wait(first.id)
      assert.notEqual(v1.id, v2.id)
      assert.deepEqual((await call('materials', 'blocks', { version_id: v1.id })).blocks, b1.blocks)
      assert.match((await call('materials', 'blocks', { version_id: v2.id, query: '动量' })).blocks[0].text, /动量/)
      assert.equal((await call('materials', 'blocks', { version_id: v2.id, query: 'no-match' })).total, 0)
      await fail('retry', v1.id)
      const p = await importFile(ppt, { ...input, kind: 'slides' }), pv = await wait(p.id)
      const pb = (await call('materials', 'blocks', { version_id: pv.id })).blocks
      assert.match(pb[0].text, /First slide/); assert.equal(JSON.parse(pb[0].locator_json).slide, 1)
      assert.match(pb[1].text, /Second slide/); assert.equal(JSON.parse(pb[1].locator_json).slide, 2)
      const pdfMaterial = await importFile(pdfFile, { ...input, kind: 'textbook' }), pdfVersion = await wait(pdfMaterial.id)
      const pdfBlocks = (await call('materials', 'blocks', { version_id: pdfVersion.id })).blocks
      assert.match(pdfBlocks[0].text, /Mechanics page one/); assert.equal(JSON.parse(pdfBlocks[1].locator_json).page, 2)
      assert.match(pdfVersion.warnings_json, /OCR/)
      const bad = await importFile(broken, input), badVersion = await wait(bad.id, 'failed')
      await call('materials', 'retry', badVersion.id); await wait(bad.id, 'failed')
      const cancellation = await importFile(docx('取消.docx', '取消后重试'), input)
      await call('materials', 'cancel', cancellation.current_version_id); await wait(cancellation.id, 'cancelled')
      await call('materials', 'retry', cancellation.current_version_id); await wait(cancellation.id)
      await call('materials', 'archive', first.id)
      assert.ok(!(await call('materials', 'list')).some(m => m.id === first.id))
      assert.deepEqual((await call('materials', 'blocks', { version_id: v1.id })).blocks, b1.blocks)
      await win.webContents.executeJavaScript(`location.hash = '/library?material=${p.id}&version=${pv.id}'`)
      await new Promise(resolve => setTimeout(resolve, 500))
      const ui = await win.webContents.executeJavaScript(`({heading:document.querySelector('h1')?.textContent,blocks:document.querySelectorAll('.material-block').length, text:document.body.innerText})`)
      assert.equal(ui.heading, '材料库'); assert.equal(ui.blocks, 2); assert.match(ui.text, /First slide/)
      await win.webContents.executeJavaScript(`document.querySelector('.material-anchor').click()`)
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.material-block.anchored').length`), 1)
      const preview = path.join(root, 'materials-preview.png')
      await win.webContents.capturePage()
      await new Promise(resolve => setTimeout(resolve, 150))
      fs.writeFileSync(preview, (await win.webContents.capturePage()).toPNG())
      assert.deepEqual(problems, [])
      await call('config', 'set', 'classroom.autoOrganize', '0')
      await win.webContents.executeJavaScript(`location.hash = '/classroom'`)
      await waitUi(`!!document.querySelector('[aria-label="课堂材料"] option[value="${pdfMaterial.id}"]')`, '课堂材料选择器')
      await win.webContents.executeJavaScript(`(() => {const select = document.querySelector('[aria-label="课堂材料"]'); select.value = '${pdfMaterial.id}'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
      await waitUi(`document.querySelector('.pdf-page canvas')?.width > 0 && document.querySelector('.pdf-page [role="status"]')?.textContent === ''`, 'PDF 原页渲染')
      await click('设为本讲起点')
      await waitUi(`document.querySelector('.classroom-current')?.textContent.includes('第 1 页')`, '课前起点')
      await click('开始课堂（手动转写模式）')
      await waitUi(`!!document.querySelector('.classroom-split')`, '课堂分屏')
      const classNote = (await call('notes', 'list')).find(n => n.source === 'class')
      assert.ok(classNote)
      await enterManual('第一段：力等于质量乘加速度。')
      await waitUi(`document.querySelectorAll('.classroom-transcript .segment').length === 1`, '课堂第一段')
      const firstClassSegment = (await call('notes', 'get', classNote.id)).segments[0]
      assert.equal(firstClassSegment.material_ref.id, pdfBlocks[0].id)
      await click('下一条', "document.querySelector('.classroom-material')")
      await waitUi(`document.querySelector('.classroom-material h3')?.textContent.includes('第 2 页')`, '翻阅下一页')
      assert.equal((await call('classroom', 'position', classNote.id)).block.id, pdfBlocks[0].id, '翻阅不应校准')
      await click('校准到这里')
      await waitUi(`document.querySelector('.classroom-current')?.textContent.includes('第 2 页')`, '实时校准')
      await enterManual('第二段：继续讲授。')
      await waitUi(`document.querySelectorAll('.classroom-transcript .segment').length === 2`, '课堂第二段')
      const classSegments = (await call('notes', 'get', classNote.id)).segments
      assert.equal(classSegments[0].material_ref.id, pdfBlocks[0].id)
      assert.equal(classSegments[1].material_ref.id, pdfBlocks[1].id)
      await win.webContents.executeJavaScript(`document.querySelector('.classroom-transcript .classroom-source').click()`)
      await waitUi(`document.querySelector('.classroom-material h3')?.textContent.includes('第 1 页')`, '回看历史来源')
      assert.equal((await call('classroom', 'position', classNote.id)).block.id, pdfBlocks[1].id, '回看来源不应改变讲授位置')
      await waitUi(`document.querySelector('.pdf-page canvas')?.width > 0 && document.querySelector('.pdf-page [role="status"]')?.textContent === ''`, '课堂 PDF 渲染')
      win.setSize(1024, 768)
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth <= window.innerWidth`), true, '最小窗口不应出现横向溢出')
      win.setSize(1360, 860)
      await win.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 100))
      fs.writeFileSync(path.join(root, 'classroom-preview.png'), (await win.webContents.capturePage()).toPNG())
      await click('结束课堂')
      await waitUi(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='继续课堂')`, '结束后可恢复')
      await win.webContents.executeJavaScript(`location.hash = '/notes/${classNote.id}?segment=${classSegments[0].id}'`)
      await waitUi(`!!document.querySelector('.classroom-source')`, '笔记来源链接')
      await win.webContents.executeJavaScript(`document.querySelector('.classroom-source').click()`)
      await waitUi(`document.querySelector('.classroom-backlinks')?.textContent.includes('第一段')`, '教材回链笔记')
      assert.equal(await win.webContents.executeJavaScript(`fetch('study-material://assets/cmaps/UniGB-UCS2-H.bcmap').then(r=>r.status)`), 200)
      assert.equal(await win.webContents.executeJavaScript(`fetch('study-material://assets/../../package.json').then(r=>r.status)`), 404)
      assert.equal((await electron.net.fetch(`study-material://file/${pdfVersion.id}`, { headers: { Origin: 'https://example.invalid' } })).status, 403)
      fs.writeFileSync(path.join(root, 'classroom-test.json'), JSON.stringify({ noteId: classNote.id, blockId: pdfBlocks[1].id, firstBlockId: pdfBlocks[0].id }))
      const missingNote = await call('notes', 'create', { title: '保存失败回归', source: 'class' })
      await win.webContents.executeJavaScript(`location.hash = '/classroom?note=${missingNote.id}'`)
      await waitUi(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='继续课堂' && !b.disabled)`, '保存失败场景准备')
      await click('继续课堂'); await waitUi(`!!document.querySelector('.classroom-split')`, '保存失败场景课堂')
      await call('notes', 'remove', missingNote.id)
      await enterManual('这段未保存成功，必须留在输入框。')
      await waitUi(`document.querySelector('.toast')?.textContent.includes('段落保存失败')`, '失败保存提示')
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.classroom-transcript textarea').value`), '这段未保存成功，必须留在输入框。')
      await click('结束课堂')
      assert.deepEqual(problems, [])
      console.log('CLASSROOM_TEST_OK setup, PDF render, calibration, immutable references, bidirectional navigation and safe asset access')
      const recovery = await importFile(docx('待恢复.docx', '恢复任务：中断导入应在重启后继续。'), input)
      await call('materials', 'cancel', recovery.current_version_id)
      // 模拟应用异常退出后留下的 processing 状态；随后真正关闭、重新启动应用。
      const db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      db.prepare("UPDATE material_versions SET status = 'parsing' WHERE id = ?").run(recovery.current_version_id)
      db.prepare('INSERT INTO classroom_sessions (id, note_id, started_at) VALUES (?, ?, ?)').run('interrupted-classroom-fixture', classNote.id, Date.now())
      db.close()
      console.log('MATERIAL_TEST_OK ' + JSON.stringify({ formats: ['docx', 'pptx', 'pdf'], versions: true, duplicate: true, cancelRetry: true, failedRetry: true, sourceLocators: true, archivePreservesReferences: true, renderer: true, node: process.versions.node, isolatedData: root, resumeId: recovery.id }))
      clearTimeout(deadline); app.quit()
    } catch (error) { console.error('MATERIAL_TEST_FAILED ' + error.stack); clearTimeout(deadline); app.exit(1) }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
