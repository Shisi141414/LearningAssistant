// 可选的真实材料验收：配置文件/教材放在仓库外或被忽略的目录，始终使用隔离应用数据。
// node scripts/test-real-materials.cjs <local-config.json>
// 配置：{cases:[{path,kind,query?,expectPages?,expectOcr?}], unsupported?:[path]}
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const configPath = path.resolve(process.argv[2] || 'missing-local-config.json')
if (!process.versions.electron) {
  assert.ok(fs.existsSync(configPath), '请提供本地材料测试配置，不在仓库中保存私人教材路径')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = require('node:child_process').spawnSync(require('electron'), [__filename, configPath], { env, windowsHide: true, encoding: 'utf8', timeout: 240_000 })
  process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '')
  if (child.error) console.error(child.error.message)
  process.exit(child.status ?? 1)
}
const electron = require('electron'), { app } = electron
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-real-'))
app.setPath('userData', root); app.setPath('sessionData', root)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let selectedFile
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }) }
  show() {}
}
const Module = require('node:module'), originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: false, filePaths: [selectedFile] }) }, shell: { ...electron.shell, openPath: async () => '' } }
  return originalLoad.call(this, request, parent, isMain)
}
const deadline = setTimeout(() => { console.error('REAL_MATERIAL_TIMEOUT'); app.exit(2) }, 225_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const call = async (group, method, ...args) => {
      const response = await win.webContents.executeJavaScript(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(response.ok, true, response.error); return response.data
    }
    try {
      const subject = await call('subjects', 'create', { name: '真实材料验收（隔离）' })
      const report = { isolatedData: root, cases: [], unsupported: [] }
      for (const test of config.cases) {
        selectedFile = path.resolve(test.path)
        const before = hash(selectedFile)
        const material = await call('materials', 'import', { subject_id: subject.id, kind: test.kind })
        const end = Date.now() + 140_000
        let version
        while (Date.now() < end) {
          version = (await call('materials', 'get', material.id)).versions[0]
          if (!['queued', 'parsing'].includes(version.status)) break
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        assert.equal(version.status, 'ready', version.error)
        assert.equal(version.fingerprint, before)
        assert.equal(hash(selectedFile), before, '源文件不可更改')
        let blocks = [], offset = 0, page
        do {
          page = await call('materials', 'blocks', { version_id: version.id, offset })
          blocks.push(...page.blocks); offset += 100
        } while (offset < page.total)
        const locators = blocks.map(b => JSON.parse(b.locator_json))
        const pages = new Set(locators.map(l => l.page ?? l.slide).filter(Boolean)).size
        if (test.expectPages) assert.equal(pages, test.expectPages)
        if (test.expectOcr) assert.match(version.warnings_json, /OCR/)
        if (test.query) assert.ok(blocks.some(b => b.text.includes(test.query)), '真实文字查询命中')
        const dup = await call('materials', 'import', { subject_id: subject.id, kind: test.kind })
        assert.equal(dup.id, material.id)
        if (test.concept) {
          const point = await call('concepts', 'save', { ...test.concept, subject_id: subject.id, summary: '真实材料关联验收，人工登记名称' })
          let scanOffset = 0, found = false
          do {
            const refs = await call('concepts', 'references', { id: point.id, offset: scanOffset })
            found ||= refs.items.some(r => r.material_id === material.id)
            scanOffset = refs.next_offset
          } while (scanOffset !== null)
          assert.ok(found, '真实材料中的概念可反向定位')
        }
        report.cases.push({ format: version.format, blocks: blocks.length, sourcePagesOrSlides: pages, needsOcr: !!test.expectOcr, queryHit: !!test.query, conceptLinked: !!test.concept, originalUnchanged: true, deduplicated: true })
      }
      for (const file of config.unsupported ?? []) {
        selectedFile = path.resolve(file)
        const before = hash(selectedFile)
        const response = await win.webContents.executeJavaScript(`window.api.materials.import(${JSON.stringify({ subject_id: subject.id, kind: 'handout' })})`)
        assert.equal(response.ok, false); assert.match(response.error, /先转换/)
        assert.equal(hash(selectedFile), before)
        report.unsupported.push({ format: path.extname(file), error: response.error, originalUnchanged: true })
      }
      fs.writeFileSync(path.join(root, 'real-material-report.json'), JSON.stringify(report, null, 2))
      console.log('REAL_MATERIAL_TEST_OK ' + JSON.stringify(report))
      clearTimeout(deadline); app.quit()
    } catch (error) { console.error(error.stack); clearTimeout(deadline); app.exit(1) }
  })
})
require('../out/main/index.js')
