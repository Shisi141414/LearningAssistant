// 可选的真实材料验收：配置文件/教材放在仓库外或被忽略的目录，始终使用隔离应用数据。
// node scripts/test-real-materials.cjs <local-config.json>
// 配置：{cases:[{path,kind,query?,expectPages?,expectOcr?,learning?,assets?}], converterPath?, restart?, unsupported?:[path]}
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
  if(child.status===0 && JSON.parse(fs.readFileSync(configPath,'utf8')).restart){
    const match=/REAL_MATERIAL_TEST_OK (.+)/.exec(child.stdout)
    assert.ok(match)
    const saved=JSON.parse(match[1])
    const resumed=require('node:child_process').spawnSync(require('electron'),[__filename,configPath,'--resume',saved.isolatedData],{env,windowsHide:true,encoding:'utf8',timeout:60000})
    process.stdout.write(resumed.stdout||'');process.stderr.write(resumed.stderr||'')
    process.exit(resumed.status??1)
  }
  process.exit(child.status ?? 1)
}
const electron = require('electron'), { app } = electron
const resumeIndex=process.argv.indexOf('--resume')
const root = resumeIndex>=0?process.argv[resumeIndex+1]:fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-real-'))
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
const stopWithFailure = code => { app.once('will-quit',()=>app.exit(code)); app.quit() }
const deadline = setTimeout(() => { console.error('REAL_MATERIAL_TIMEOUT'); stopWithFailure(2) }, 225_000)
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const call = async (group, method, ...args) => {
      const response = await win.webContents.executeJavaScript(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
      assert.equal(response.ok, true, response.error); return response.data
    }
    try {
      if(resumeIndex>=0){
        const saved=JSON.parse(fs.readFileSync(path.join(root,'real-material-report.json'),'utf8'))
        await call('materials','converterAuto')
        for(const item of saved.cases){
          const detail=await call('materials','get',item.materialId)
          assert.equal(detail.versions[0].status,'ready')
          assert.ok((await call('materials','blocks',{version_id:item.versionId})).total>0)
          if(item.converted){
            assert.equal(detail.conversions[0].fingerprint,item.converted.fingerprint)
            assert.equal((await call('learning','get',{version_id:item.versionId})).sources.length,item.semanticSources)
            await call('materials','openConverted',item.versionId)
          }
          if(item.assets){
            const document=await call('learning','get',{version_id:item.versionId})
            assert.deepEqual(document.assets.map(asset=>({sha256:asset.sha256,locator:asset.locator_json})),item.assets.items)
            assert.equal(document.revision_id,item.assets.revision)
            assert.ok(document.asset_extraction)
          }
        }
        console.log('REAL_MATERIAL_RESTART_OK immutable conversions, sources and blocks survive restart without the converter')
        clearTimeout(deadline);app.quit();return
      }
      if(config.converterPath){selectedFile=path.resolve(config.converterPath);assert.equal((await call('materials','converterPick')).ready,true)}
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
        let semanticSources
        if (test.learning) {
          const learning = await call('learning', 'prepare', version.id)
          semanticSources = learning.sources.length
          if (test.query) assert.ok(learning.sources.some(source => source.raw_text.includes(test.query)), '规范来源应含真实文字')
          if (version.format === 'pptx' && test.expectPages) assert.equal(new Set(learning.sources.map(s=>JSON.parse(s.locator_json).slide)).size,test.expectPages)
          assert.equal((await call('learning','prepare',version.id)).sources[0].id,learning.sources[0].id,'规范来源不能重建 ID')
        }
        let assets
        if(test.assets){
          const before=await call('learning','prepare',version.id),after=await call('learning','assetsPrepare',version.id)
          assert.equal(after.revision_id,before.revision_id);assert.deepEqual(after.sources,before.sources)
          assets={revision:after.revision_id,items:after.assets.map(asset=>({sha256:asset.sha256,locator:asset.locator_json})),count:after.assets.length,warnings:after.asset_extraction.warnings}
          for(const asset of after.assets){const status=await win.webContents.executeJavaScript(`fetch('study-material://learning-assets/${asset.id}').then(response=>response.status)`);assert.equal(status,200)}
        }
        const detail=await call('materials','get',material.id),converted=detail.conversions[0]
        if(['doc','ppt'].includes(version.format)){
          assert.ok(converted);assert.match(converted.engine,/LibreOffice/)
          assert.equal(hash(path.join(root,'materials',version.id,`converted.${converted.format}`)),converted.fingerprint)
          assert.equal(hash(path.join(root,'materials',version.id,`source.${version.format}`)),before)
        }
        report.cases.push({ materialId:material.id,versionId:version.id,converted,assets,format: version.format, blocks: blocks.length, sourcePagesOrSlides: pages, semanticSources, needsOcr: !!test.expectOcr, queryHit: !!test.query, conceptLinked: !!test.concept, originalUnchanged: true, deduplicated: true })
      }
      for (const file of config.unsupported ?? []) {
        selectedFile = path.resolve(file)
        const before = hash(selectedFile)
        const response = await win.webContents.executeJavaScript(`window.api.materials.import(${JSON.stringify({ subject_id: subject.id, kind: 'handout' })})`)
        assert.equal(response.ok, false); assert.match(response.error, /目前支持/)
        assert.equal(hash(selectedFile), before)
        report.unsupported.push({ format: path.extname(file), error: response.error, originalUnchanged: true })
      }
      if(config.converterPath){
        const invalid=path.join(root,'truncated.doc')
        fs.writeFileSync(invalid,Buffer.from('d0cf11e0a1b11ae1000000000000000000000000000000000000000000000000','hex'))
        selectedFile=invalid
        const damaged=await call('materials','import',{subject_id:subject.id,kind:'handout'})
        let detail
        const limit=Date.now()+20000
        do{detail=await call('materials','get',damaged.id);if(!['queued','parsing'].includes(detail.versions[0].status))break;await new Promise(r=>setTimeout(r,50))}while(Date.now()<limit)
        assert.equal(detail.versions[0].status,'failed');assert.equal(detail.conversions.length,0)
        assert.equal(hash(path.join(root,'materials',detail.versions[0].id,'source.doc')),hash(invalid))
        const legacyCase=config.cases.find(item=>['.doc','.ppt'].includes(path.extname(item.path).toLowerCase()))
        if(legacyCase){
          const cancelSubject=await call('subjects','create',{name:'转换取消验收'})
          selectedFile=path.resolve(legacyCase.path)
          const cancelled=await call('materials','import',{subject_id:cancelSubject.id,kind:'handout'})
          const cancelId=cancelled.current_version_id
          await call('materials','cancel',cancelId)
          await new Promise(r=>setTimeout(r,300))
          const cancelledDetail=await call('materials','get',cancelled.id)
          assert.equal(cancelledDetail.versions[0].status,'cancelled');assert.equal(cancelledDetail.conversions.length,0)
          assert.equal(hash(path.join(root,'materials',cancelId,`source${path.extname(selectedFile).toLowerCase()}`)),hash(selectedFile))
          report.invalidAndCancelledOriginalsRetained=true
        }
      }
      fs.writeFileSync(path.join(root, 'real-material-report.json'), JSON.stringify(report, null, 2))
      console.log('REAL_MATERIAL_TEST_OK ' + JSON.stringify(report))
      clearTimeout(deadline); app.quit()
    } catch (error) { console.error(error.stack); clearTimeout(deadline); stopWithFailure(1) }
  })
})
require('../out/main/index.js')
