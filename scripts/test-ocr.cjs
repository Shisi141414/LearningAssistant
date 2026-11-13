// 可选的真实 OCR 验收，模型/真实教材路径放本地配置，不随 npm test 下载模型。
// node scripts/test-ocr.cjs <config.json>
// { modelDirectory: "...", downloadModels?: true, real?: { file: "...pdf", from: 26, to: 27, query?: "..." } }
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const crypto = require('node:crypto')
const configPath = path.resolve(process.argv[2] || 'missing-ocr-config.json')
if (!process.versions.electron) {
  assert.ok(fs.existsSync(configPath), '请提供本地 OCR 测试配置')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, configPath], { env, windowsHide: true, encoding: 'utf8', timeout: 330_000 })
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
  const output = /OCR_TEST_OK (.+)/.exec(result.stdout)
  assert.ok(output, '缺少验收结果')
  const resume = require('node:child_process').spawnSync(require('electron'), [__filename, configPath, '--ocr-resume', JSON.parse(output[1]).isolatedData], { env, windowsHide: true, encoding: 'utf8', timeout: 150_000 })
  process.stdout.write(resume.stdout || ''); process.stderr.write(resume.stderr || '')
  if (resume.error) console.error(resume.error.message)
  process.exit(resume.status ?? 1)
}
const electron = require('electron'), { app } = electron
app.disableHardwareAcceleration()
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const engine = config.engine || 'tesseract'
const resumeIndex = process.argv.indexOf('--ocr-resume')
const root = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-ocr-'))
app.setPath('userData', root); app.setPath('sessionData', root)
const modelDir = path.join(root, 'ocr-models', 'tessdata-fast-87416418')
fs.mkdirSync(modelDir, { recursive: true })
if (resumeIndex < 0 && engine === 'ppocr') {
  fs.cpSync(config.modelDirectory, path.join(root, 'ocr-models', 'ppocr-v6-tiny'), { recursive: true })
} else if (!config.downloadModels && resumeIndex < 0) for (const name of ['eng.traineddata', 'chi_sim.traineddata']) fs.copyFileSync(path.join(config.modelDirectory, name), path.join(modelDir, name))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
// 三页纯图像 PDF，分别为中英正文、另一页正文及空白页；无任何隐藏文字层。
function scannedPdf() {
  const { createCanvas } = require('@napi-rs/canvas')
  const canvas = createCanvas(1200, 1600), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 1600); ctx.fillStyle = 'black'
  ctx.font = '44px SimSun'; ctx.fillText('热力学第一定律', 100, 180)
  ctx.font = '36px Arial'; ctx.fillText('The first law of thermodynamics', 100, 300)
  ctx.fillText('Energy is conserved in this system.', 100, 380)
  const image = canvas.toBuffer('image/jpeg')
  const stream = data => Buffer.concat([Buffer.from(`<< /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')])
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'),
    ...[6, 6, 7].map(content => Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im 8 0 R >> >> /Contents ${content} 0 R >>`)),
    stream(Buffer.from('q 600 0 0 800 0 0 cm /Im Do Q')), stream(Buffer.from('')),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')])
  ]
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  objects.forEach((object, i) => { offsets.push(chunks.reduce((n, b) => n + b.length, 0)); chunks.push(Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')) })
  const xref = chunks.reduce((n, b) => n + b.length, 0)
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`))
  const file = path.join(root, 'scanned-fixture.pdf'); fs.writeFileSync(file, Buffer.concat(chunks)); return file
}
let selectedFile
const problems = []
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }) }
  show() {}
}
const Module = require('node:module'), originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: !selectedFile, filePaths: selectedFile ? [selectedFile] : [] }) } }
  return originalLoad.call(this, request, parent, isMain)
}
const deadline = setTimeout(() => { console.error('OCR_TEST_TIMEOUT', root); app.exit(2) }, 310_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('preload-error', (_e, _file, error) => problems.push(error.message))
  win.webContents.on('render-process-gone', (_e, info) => problems.push(info.reason))
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code)
    const call = async (group, method, ...args) => {
      if (group === 'materials' && method === 'ocrStart') args[0] = { ...args[0], engine }
      const result = await js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(result.ok, true, result.error); return result.data
    }
    const until = async (check, label, ms = 15_000) => {
      const end = Date.now() + ms
      while (!await check()) { if (Date.now() > end) throw Error('等待超时：' + label); await new Promise(r => setTimeout(r, 80)) }
    }
    const ready = async (material, version) => {
      await until(async () => { const v = (await call('materials', 'get', material)).versions.find(v => v.id === version); if (v.status === 'failed') throw Error(v.error); return v.status === 'ready' }, 'OCR 任务', 120_000)
    }
    const click = text => js(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`)
    try {
      if (resumeIndex >= 0) {
        const report = JSON.parse(fs.readFileSync(path.join(root, 'ocr-report.json'), 'utf8'))
        const r = report.resume
        await ready(r.material, r.pending)
        assert.match((await call('materials', 'ocrPage', { version_id: r.pending, page: 1 })).corrected_text, /热力学第一定律/)
        assert.match((await call('materials', 'ocrPage', { version_id: r.pending, page: 2 })).raw_text, /thermodynamics/i)
        assert.equal((await call('notes', 'get', r.note)).segments[0].material_ref.id, r.oldBlock)
        assert.match((await call('learning', 'get', { version_id: r.correction })).sources[0].raw_text, /校正后的中文正文/)
        console.log('OCR_RESTART_OK persisted OCR, manual correction, original references, interrupted job recovery')
        clearTimeout(deadline); app.quit(); return
      }
      const subject = (await call('subjects', 'list'))[0].id
      const importFile = async file => { selectedFile = file; const m = await call('materials', 'import', { subject_id: subject, kind: 'textbook' }); await ready(m.id, m.current_version_id); return m }
      if (config.downloadModels) assert.equal((await call('materials', 'ocrPrepare')).ready, true)
      if (engine === 'ppocr') assert.equal((await call('materials', 'ppocrStatus')).presets.find(p => p.key === 'v6-tiny').ready, true)
      else assert.equal((await call('materials', 'ocrModels')).ready, true)
      // 断网下已就绪的语言包准备直接复用；识别同样只允许本地资源。
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => { throw Error('OCR 验收期间禁止联网') }
      if (engine === 'tesseract') assert.equal((await call('materials', 'ocrPrepare')).ready, true)
      const m = await importFile(scannedPdf()), original = m.current_version_id
      const oldBlocks = (await call('materials', 'blocks', { version_id: original })).blocks
      assert.equal(oldBlocks.length, 3)
      const note = await call('notes', 'create', { title: 'OCR 历史来源', source: 'class' })
      await call('classroom', 'calibrate', { note_id: note.id, block_id: oldBlocks[0].id })
      await call('notes', 'addSegment', { note_id: note.id, raw_text: '使用原始材料的课堂记录' })
      // 实际 UI 发起 OCR。
      await js(`location.hash = '/library?material=${m.id}&version=${original}'`)
      await until(() => js(`!!document.querySelector('.material-ocr summary')`), 'OCR 面板')
      await js(`document.querySelector('.material-ocr').open = true`)
      await until(() => js(`!!document.querySelector('[aria-label="OCR 引擎"]')`), '引擎选择')
      await js(`(() => { const s=document.querySelector('[aria-label="OCR 引擎"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,${JSON.stringify(engine)}); s.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await until(() => js(`Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim()==='识别为新版本' && !b.disabled)`), '语言包就绪')
      await click('识别为新版本')
      let ocr
      await until(async () => { ocr = (await call('materials', 'get', m.id)).versions.find(v => v.derivation === 'ocr'); return !!ocr }, 'OCR 版本创建')
      await ready(m.id, ocr.id)
      const p1 = await call('materials', 'ocrPage', { version_id: ocr.id, page: 1 })
      assert.equal(JSON.parse(p1.model_json).engine, engine === 'ppocr' ? 'ppu-paddle-ocr' : 'tesseract.js')
      if (engine === 'ppocr') assert.equal(typeof JSON.parse(p1.model_json).engineVersion, 'string')
      assert.match(p1.raw_text, /thermodynamics/i); assert.ok(JSON.parse(p1.lines_json).length > 0)
      assert.ok((await call('materials', 'blocks', { version_id: ocr.id, query: 'thermodynamics' })).total > 0)
      assert.equal((await call('materials', 'blocks', { version_id: original, query: 'thermodynamics' })).total, 0)
      // 实际校正界面保存，旧课堂引用仍指向原版块。
      await until(() => js(`document.querySelector('select[aria-label="材料版本"]')?.value === ${JSON.stringify(ocr.id)} && !!document.querySelector('.material-ocr')`), 'OCR 新版本阅读')
      await js(`document.querySelector('.material-ocr').open = true`)
      await until(() => js(`!!document.querySelector('[aria-label="OCR 校正文字"]')`), '校正输入')
      await js(`(() => { const t=document.querySelector('[aria-label="OCR 校正文字"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'热力学第一定律：校正后的中文正文。Energy is conserved.'); t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await js(`document.querySelector('.material-ocr').open = false`)
      await new Promise(r => setTimeout(r, 100))
      await js(`document.querySelector('.material-ocr').open = true`)
      assert.match(await js(`document.querySelector('[aria-label="OCR 校正文字"]').value`), /校正后的中文正文/)
      await click('保存为校正版')
      let correction
      await until(async () => { correction = (await call('materials', 'get', m.id)).versions.find(v => v.derivation === 'correction'); return !!correction }, '校正版本')
      assert.match((await call('materials', 'ocrPage', { version_id: correction.id, page: 1 })).corrected_text, /热力学第一定律/)
      assert.equal((await call('materials', 'ocrPage', { version_id: ocr.id, page: 1 })).corrected_text, null)
      const learningCorrected = await call('learning', 'prepare', correction.id)
      assert.match(learningCorrected.sources[0].raw_text, /校正后的中文正文/)
      assert.equal(learningCorrected.sources[0].extraction, 'manual')
      assert.equal((await call('learning', 'prepare', correction.id)).sources[0].id, learningCorrected.sources[0].id)
      assert.equal((await call('notes', 'get', note.id)).segments[0].material_ref.id, oldBlocks[0].id)
      const second = await call('materials', 'ocrStart', { version_id: correction.id, from_page: 2, to_page: 3 })
      await ready(m.id, second)
      assert.match((await call('materials', 'ocrPage', { version_id: second, page: 1 })).corrected_text, /热力学第一定律/)
      assert.equal((await call('materials', 'ocrPage', { version_id: second, page: 3 })).raw_text.trim(), '')
      const cancelled = await call('materials', 'ocrStart', { version_id: second, from_page: 1, to_page: 2 })
      await call('materials', 'cancel', cancelled)
      await until(async () => (await call('materials', 'get', m.id)).versions.find(v => v.id === cancelled).status === 'cancelled', '取消')
      assert.equal((await call('materials', 'get', m.id)).material.current_version_id, second)
      await call('materials', 'retry', cancelled); await ready(m.id, cancelled)
      const report = { isolatedData: root, synthetic: { pages: 3, recognized: p1.raw_text, confidence: p1.confidence, versionsAndUi: true, immutableReferences: true, cancelRetry: true, noNetwork: true } }
      if (config.real) {
        const originalHash = hash(config.real.file), real = await importFile(config.real.file)
        const started = Date.now(), id = await call('materials', 'ocrStart', { version_id: real.current_version_id, from_page: config.real.from, to_page: config.real.to })
        await ready(real.id, id)
        const ocrSeconds = (Date.now() - started) / 1000
        const pages = []
        for (let page = config.real.from; page <= config.real.to; page++) pages.push(await call('materials', 'ocrPage', { version_id: id, page }))
        assert.ok(pages.every(page => page.raw_text.trim().length > 20))
        if (config.real.query) assert.ok((await call('materials', 'blocks', { version_id: id, query: config.real.query })).total > 0, '真实教材关键词应可检索')
        assert.equal(hash(config.real.file), originalHash, '原件不变')
        const learningReal = await call('learning', 'prepare', id)
        assert.equal(learningReal.sources.length, 353)
        assert.equal(learningReal.sources[config.real.from - 1].extraction, 'ocr')
        assert.match(learningReal.sources[config.real.from - 1].raw_text, /热力学/)
        const concept = await call('concepts', 'save', { subject_id: subject, name: '热力学', summary: 'OCR 概念关联验收', aliases: ['工程热力学'] })
        let offset = 0, linked = false
        while (offset !== null) {
          const refs = await call('concepts', 'references', { id: concept.id, offset })
          linked ||= refs.items.some(item => item.parent_id === id && item.material_id === real.id)
          offset = refs.next_offset
        }
        assert.equal(linked, true, 'OCR 正文应进入确认概念的反向引用')
        report.real = { from: config.real.from, to: config.real.to, seconds: ocrSeconds, includingLearningPreparationSeconds: (Date.now() - started) / 1000, conceptBacklinks: linked, pages: pages.map(p => ({ page: p.page, confidence: p.confidence, text: p.raw_text })) }
        await js(`location.hash='/library?material=${real.id}&version=${id}'`)
      } else await js(`location.hash='/library?material=${m.id}&version=${correction.id}'`)
      await until(() => js(`!!document.querySelector('.material-ocr')`), '最终页面')
      await js(`document.querySelector('.material-ocr').open=true`)
      if (config.real) await js(`(() => { const t=document.querySelector('[aria-label="OCR 核对页"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,${JSON.stringify(String(config.real.from))}); t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await until(() => js(`!!document.querySelector('[aria-label="OCR 校正文字"]') && !!document.querySelector('.pdf-page canvas')`), '最终对照预览')
      win.setSize(1024, 768)
      await new Promise(r => setTimeout(r, 100))
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
      win.setSize(1500, 1000)
      await new Promise(r => setTimeout(r, 200))
      const image = await new Promise((resolve, reject) => { const timer=setTimeout(()=>reject(Error('截图超时')),5000); win.webContents.once('paint', (_e,_r,image)=>{clearTimeout(timer);resolve(image)}); win.webContents.invalidate() })
      fs.writeFileSync(path.join(root, 'ocr-preview.png'), image.toPNG())
      const pending = await call('materials', 'ocrStart', { version_id: correction.id, from_page: 2, to_page: 2 })
      await call('materials', 'cancel', pending)
      await new Promise(r => setTimeout(r, 80))
      const db = new (require('better-sqlite3'))(path.join(root, 'learning-assistant.db'))
      db.prepare("UPDATE material_versions SET status = 'parsing' WHERE id = ?").run(pending)
      db.close()
      report.resume = { material: m.id, pending, correction: correction.id, note: note.id, oldBlock: oldBlocks[0].id }
      fs.writeFileSync(path.join(root, 'ocr-report.json'), JSON.stringify(report, null, 2))
      globalThis.fetch = originalFetch
      assert.deepEqual(problems, [])
      console.log('OCR_TEST_OK ' + JSON.stringify({ isolatedData: root, realPages: report.real?.pages.map(p=>p.page), confidence: report.real?.pages.map(p=>p.confidence), seconds: report.real?.seconds }))
      clearTimeout(deadline); app.quit()
    } catch (error) { console.error(error.stack, root); clearTimeout(deadline); app.exit(1) }
  })
})
require(path.resolve(__dirname, '../out/main/index.js'))
