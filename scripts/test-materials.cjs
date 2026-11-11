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
        console.log('MATERIAL_RESTART_OK interrupted import resumed after a real app restart')
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
      const recovery = await importFile(docx('待恢复.docx', '恢复任务：中断导入应在重启后继续。'), input)
      await call('materials', 'cancel', recovery.current_version_id)
      // 模拟应用异常退出后留下的 processing 状态；随后真正关闭、重新启动应用。
      const db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      db.prepare("UPDATE material_versions SET status = 'parsing' WHERE id = ?").run(recovery.current_version_id)
      db.close()
      console.log('MATERIAL_TEST_OK ' + JSON.stringify({ formats: ['docx', 'pptx', 'pdf'], versions: true, duplicate: true, cancelRetry: true, failedRetry: true, sourceLocators: true, archivePreservesReferences: true, renderer: true, node: process.versions.node, isolatedData: root, resumeId: recovery.id }))
      clearTimeout(deadline); app.quit()
    } catch (error) { console.error('MATERIAL_TEST_FAILED ' + error.stack); clearTimeout(deadline); app.exit(1) }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
