// 实际 Electron/Chromium PDF 验收；隔离用户数据，保存框由测试指定临时目标。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const result = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, encoding: 'utf8', timeout: 120_000 })
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  assert.equal(result.status, 0, '原生 PDF 导出验收失败')
  const info = JSON.parse(/LEARNING_PDF_OK (.+)/.exec(result.stdout)[1])
  ;(async () => {
    const canvas = require('@napi-rs/canvas'); global.DOMMatrix = canvas.DOMMatrix; global.ImageData = canvas.ImageData; global.Path2D = canvas.Path2D
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    for (const name of info.files ?? ['课堂笔记.pdf', '教材讲义.pdf', '横向讲义.pdf']) {
      const bytes = fs.readFileSync(path.join(info.root, name)), raw = bytes.toString('latin1')
      assert.ok(raw.includes('SimSun') && raw.includes('/FontFile2'), '中文正文须使用宋体并嵌入字体')
      const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }), pdf = await loading.promise
      const mark = await pdf.getMarkInfo()
      assert.equal(mark instanceof Map ? mark.get('Marked') : mark?.Marked, true)
      assert.ok((await pdf.getOutline()).length > 0)
      const pages = [], annotations = []
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent()
        pages.push(content.items.map(item => item.str).join('')); annotations.push(...await page.getAnnotations())
        assert.ok(pages.at(-1).includes(`${number} / ${pdf.numPages}`), `第 ${number} 页缺少页码`)
        // 检查文字确实处于纸张范围；不能仅凭提取出文字认定没有被裁切。
        const box = page.view
        for (const item of content.items) if (item.str.trim()) {
          assert.ok(item.transform[4] >= -1 && item.transform[4] + item.width <= box[2] + 2, `文字横向越界：${item.str}`)
          assert.ok(item.transform[5] >= 0 && item.transform[5] <= box[3] + 2, `文字纵向越界：${item.str}`)
        }
      }
      const text = pages.join('\n')
      assert.ok(text.includes('来源与原文对照'))
      assert.ok(annotations.some(item => item.dest), '目录或证明对象须保留 PDF 内部跳转')
      if (info.files) { assert.ok(text.includes('修订')); assert.ok(text.length > 300) }
      else if (name === '课堂笔记.pdf') {
        for (let index = 0; index < 120; index++) assert.ok(text.includes(`条目标记${String(index).padStart(3, '0')}`), `漏导出第 ${index} 条`)
        assert.ok(text.includes('原始转写')); assert.ok(text.includes('教师口述保留'))
        assert.ok(text.includes('跨页证明结束')); assert.ok(!text.includes('后加内容不得出现'))
        assert.ok(pdf.numPages >= 6); assert.ok(text.includes('动量原理旧修订'))
      } else { assert.ok(text.includes('受力示意图')); assert.equal(text.split('来源文字隐藏标记').length - 1, 1, '未勾选原文，不应在附录重复正文') }
      const renderPages = name === '课堂笔记.pdf' ? [1, Math.ceil(pdf.numPages / 2), pdf.numPages] : [...new Set([1, Math.min(2, pdf.numPages), pdf.numPages])]
      for (const number of renderPages) {
        const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1.3 }), image = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvasContext: image.getContext('2d'), viewport }).promise
        fs.writeFileSync(path.join(info.root, `${name}-${number}.png`), image.toBuffer('image/png'))
      }
      fs.writeFileSync(path.join(info.root, `${name}.text.txt`), text)
      console.log('PDF_INSPECT_OK', name, pdf.numPages, 'pages', annotations.length, 'links')
      await loading.destroy()
    }
    console.log('PDF_ARTIFACTS', info.root)
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const electron = require('electron'), { app } = electron
  app.disableHardwareAcceleration()
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-pdf-')), data = path.join(root, 'data')
  fs.mkdirSync(data); app.setPath('userData', data); app.setPath('sessionData', data)
  const realIndex = process.argv.indexOf('--real-profile')
  if (realIndex >= 0) {
    const source = process.argv[realIndex + 1]
    fs.copyFileSync(path.join(source, 'learning-assistant.db'), path.join(data, 'learning-assistant.db'))
    fs.cpSync(path.join(source, 'materials'), path.join(data, 'materials'), { recursive: true })
  }
  let save = { canceled: true }, hold = false, printWindow, defaultPermissionWrites = 0
  class HiddenWindow extends electron.BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true } })
      if (!options.webPreferences.preload) {
        printWindow = this
        assert.ok(options.webPreferences.partition?.startsWith('learning-pdf-'))
        const print = this.webContents.printToPDF.bind(this.webContents)
        this.webContents.printToPDF = options => hold ? new Promise((_resolve, reject) => this.once('closed', () => reject(Error('测试取消')))) : print(options)
      }
    }
    show() {}
  }
  const Module = require('node:module'), load = Module._load
  Module._load = function(request, parent, isMain) { return request === 'electron' ? { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showSaveDialog: async () => save } } : load.call(this, request, parent, isMain) }
  app.whenReady().then(() => {
    const session = electron.session.defaultSession, original = session.setPermissionRequestHandler.bind(session)
    session.setPermissionRequestHandler = handler => { defaultPermissionWrites++; return original(handler) }
  })
  const deadline = setTimeout(() => { console.error('LEARNING_PDF_TIMEOUT'); app.exit(2) }, 110_000)
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', async () => {
      if (new URL(win.webContents.getURL()).pathname.endsWith('/print.html')) return
      const js = code => win.webContents.executeJavaScript(code)
      const request = (group, method, ...args) => js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      const call = async (group, method, ...args) => { const result = await request(group, method, ...args); assert.equal(result.ok, true, result.error); return result.data }
      const wait = async expression => { const limit = Date.now() + 10_000; while (!await js(expression)) { if (Date.now() > limit) throw Error(await js('document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 35)) } }
      const options = source => ({ source, landscape: false, include_original_text: false })
      const target = name => { save = { canceled: false, filePath: path.join(root, name) }; return save.filePath }
      try {
        await wait('!!window.api')
        if (realIndex >= 0) {
          const db = new (require('better-sqlite3'))(path.join(data, 'learning-assistant.db'))
          const versions = db.prepare('SELECT v.id,v.format,d.current_revision_id FROM material_versions v JOIN learning_documents d ON d.version_id=v.id').all(); db.close()
          const files = []
          for (const version of versions) {
            const name = `真实教材-${version.format}.pdf`; target(name)
            const report = await call('learning', 'pdfExport', options({ kind: 'material', version_id: version.id, revision_id: version.current_revision_id }))
            console.log('REAL_PDF_EXPORTED', JSON.stringify({ format: version.format, ...report })); files.push(name)
          }
          assert.equal(files.length, 3)
          console.log('LEARNING_PDF_OK', JSON.stringify({ root, files })); clearTimeout(deadline); app.exit(0); return
        }
        const note = await call('notes', 'create', { title: '动量原理旧修订', source: 'class' })
        let theorem
        for (let index = 0; index < 120; index++) {
          const segment = await call('notes', 'addSegment', { note_id: note.id, seg_type: index === 0 ? 'note' : index === 1 ? 'proposition' : index === 2 ? 'proof' : 'note', raw_text: `教师口述保留 ${index}`, organized_text: `条目标记${String(index).padStart(3, '0')}：动量与冲量。${index === 2 ? '\n跨页证明开始\n' + '由牛顿第二定律积分，冲量等于动量的增量。\n'.repeat(100) + '跨页证明结束' : index === 1 ? ' 公式' : '学习要点完整保存。'}` })
          if (index === 1) theorem = segment
        }
        let doc = await call('notes', 'learningGet', { note_id: note.id })
        const change = async (index, operation) => { doc = await call('notes', 'learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[index].id, ...operation }) }
        await change(0, { action: 'edit', type: 'section', title: '动量与冲量' })
        await change(1, { action: 'formula', formula: { range: [doc.sources[1].raw_text.length - 2, doc.sources[1].raw_text.length], latex: '\\Delta \\mathbf{p}=\\int_{t_1}^{t_2}\\mathbf{F}\\,\\mathrm{d}t', display: true } })
        await change(2, { action: 'relate', target_id: doc.state.entries[1].id })
        const source = { kind: 'note', note_id: note.id, revision_id: doc.revision_id }
        await call('notes', 'learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[119].id, action: 'edit', type: 'note', title: '后加内容不得出现' })
        await call('notes', 'updateSegment', theorem.id, { organized_text: '后加内容不得出现' })
        const next = await call('notes', 'learningGet', { note_id: note.id }); assert.notEqual(next.revision_id, doc.revision_id)
        target('课堂笔记.pdf')
        const report = await call('learning', 'pdfExport', { ...options(source), include_original_text: true })
        assert.equal(report.entry_count, 120); assert.equal(report.revision_id, doc.revision_id)
        assert.equal(defaultPermissionWrites, 1, '打印页不得改写主窗口麦克风权限')
        // 保存框取消、托管路径防护和取消排版均必须保留已有文件。
        save = { canceled: true }; assert.equal(await call('learning', 'pdfExport', options(source)), null)
        save = { canceled: false, filePath: path.join(data, 'private.pdf') }
        assert.equal((await request('learning', 'pdfExport', options(source))).ok, false)
        const old = target('取消保留.pdf'); fs.writeFileSync(old, '原文件保留')
        hold = true; printWindow = undefined
        const pending = request('learning', 'pdfExport', options(source))
        while (!printWindow) await new Promise(resolve => setTimeout(resolve, 10))
        const other = await request('learning', 'pdfExport', options(source)); assert.equal(other.ok, false); assert.match(other.error, /已有 PDF/)
        assert.equal(await call('learning', 'pdfCancel'), true)
        assert.equal((await pending).ok, false); assert.equal(fs.readFileSync(old, 'utf8'), '原文件保留'); hold = false
        // 材料快照含本地图片、显式公式、目录和来源；图片 SHA 必须真实通过。
        const Database = require('better-sqlite3'), db = new Database(path.join(data, 'learning-assistant.db'))
        const canvas = require('@napi-rs/canvas').createCanvas(800, 320), ctx = canvas.getContext('2d')
        ctx.fillStyle = '#edf3fa'; ctx.fillRect(0, 0, 800, 320); ctx.fillStyle = '#315370'; ctx.fillRect(100, 100, 160, 130); ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(260, 165); ctx.lineTo(650, 165); ctx.lineTo(620, 145); ctx.stroke(); ctx.font = '32px serif'; ctx.fillText('F = ma', 370, 130)
        const bytes = canvas.toBuffer('image/png'), sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
        fs.mkdirSync(path.join(data, 'materials')); const imageFile = path.join(data, 'materials', 'figure.png'); fs.writeFileSync(imageFile, bytes)
        db.exec("PRAGMA foreign_keys=ON; INSERT INTO materials(id,title,created_at) VALUES('pdf-m','动量教材整理',1); INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('pdf-v','pdf-m','讲义.pdf','pdf','materials/original.pdf','hash','ready',1); INSERT INTO learning_documents(id,version_id,created_at) VALUES('pdf-d','pdf-v',1)")
        const rows = ['第一章 动量', '动量定理：公式', '受力示意图。来源文字隐藏标记']
        rows.forEach((raw, index) => db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES(?,?,?,?,?,?,?)').run('pdf-s' + index, 'pdf-d', index, raw, '', JSON.stringify({ kind: 'pdf', page: index + 1 }), 'native'))
        const state = { entries: rows.map((_raw, index) => ({ id: 'pdf-e' + index, type: index === 0 ? 'section' : index === 1 ? 'theorem' : 'figure', title: index === 0 ? '动量章节' : index === 1 ? '动量定理' : '受力示意图', sources: [{ source_id: 'pdf-s' + index }], analysis: { method: 'manual', review_status: 'confirmed' }, ...(index === 1 ? { formulas: [{ range: [5, 7], latex: 'a+'.repeat(25) + 'a', display: true }] } : index === 2 ? { figures: [{ asset_id: 'pdf-img', caption: '受力示意图' }] } : {}) })), relations: [] }
        db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES(?,?,?,?)').run('pdf-r', 'pdf-d', JSON.stringify(state), 1)
        db.exec("UPDATE learning_documents SET current_revision_id='pdf-r' WHERE id='pdf-d'")
        db.prepare('INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('pdf-img', 'pdf-d', 'image/png', sha, 'materials/figure.png', 800, 320, '{"kind":"pdf","page":3}', '受力图', 1)
        db.close()
        const material = options({ kind: 'material', version_id: 'pdf-v', revision_id: 'pdf-r' })
        target('教材讲义.pdf'); const materialReport = await call('learning', 'pdfExport', material)
        assert.equal(materialReport.image_count, 1); assert.equal(materialReport.entry_count, 3); assert.ok(materialReport.scaled_formulas > 0)
        target('横向讲义.pdf'); await call('learning', 'pdfExport', { ...material, landscape: true })
        // 不能解码的图片导致整体失败，不覆盖目标，也不能留下半份临时文件。
        const failed = target('失败保留.pdf'); fs.writeFileSync(failed, '旧文件不变'); fs.writeFileSync(imageFile, '损坏图片')
        assert.equal((await request('learning', 'pdfExport', material)).ok, false); assert.equal(fs.readFileSync(failed, 'utf8'), '旧文件不变')
        fs.writeFileSync(imageFile, bytes)
        const wide = new Database(path.join(data, 'learning-assistant.db')); state.entries[1].formulas[0].latex = 'a+'.repeat(200) + 'a'
        wide.prepare('INSERT INTO learning_revisions(id,document_id,parent_revision_id,snapshot_json,created_at) VALUES(?,?,?,?,?)').run('pdf-wide', 'pdf-d', 'pdf-r', JSON.stringify(state), 2); wide.close()
        const error = await request('learning', 'pdfExport', { ...material, source: { ...material.source, revision_id: 'pdf-wide' } })
        assert.equal(error.ok, false); assert.match(error.error, /公式过宽/); assert.equal(fs.readFileSync(failed, 'utf8'), '旧文件不变')
        assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.learning-pdf-')))
        // 真实笔记阅读入口与筛选无关，点击按钮可导出全部所选修订。
        await js(`location.hash=${JSON.stringify('/notes/' + note.id)}`)
        await wait("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='统一文档')")
        await js("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='统一文档').click()")
        await wait("Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='导出 PDF')")
        await js("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='导出 PDF').click()")
        await wait("!!document.querySelector('[aria-label=\"PDF 纸张方向\"]')")
        assert.ok((await js('document.body.innerText')).includes('全部条目'))
        target('界面导出.pdf')
        await js("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='选择位置并保存 PDF').click()")
        await wait("document.body.innerText.includes('已保存 界面导出.pdf')")
        assert.ok(fs.readFileSync(save.filePath).subarray(0, 5).toString() === '%PDF-')
        assert.equal(await js("document.querySelector('[aria-label=\"笔记修订\"]').disabled"), false)
        console.log('LEARNING_PDF_OK', JSON.stringify({ root, entries: 120 })); clearTimeout(deadline); app.exit(0)
      } catch (error) { console.error(error.stack || error); clearTimeout(deadline); app.exit(1) }
    })
  })
  require('../out/main/index.js')
}
