// 真实隐藏桌面窗口：源目录生成标准包，空目标目录导入，再实际重启验证。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), fixture = require('./note-package-fixture.cjs')
if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'learning-assistant-note-import-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  for (const phase of ['prepare','import','resume']) {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, root, phase], { env, windowsHide: true, encoding: 'utf8', timeout: 75_000 })
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); if (result.error) throw result.error
    assert.equal(result.status, 0, `笔记导入 ${phase} 失败`)
  }
  console.log('NOTE_IMPORT_ROOT '+root); process.exit(0)
}
const electron = require('electron'), { app } = electron, RealWorker = require('node:worker_threads').Worker
app.disableHardwareAcceleration()
const root = process.argv[2], phase = process.argv[3], data = path.join(root, phase === 'prepare' ? 'source-data' : 'target-data')
fs.mkdirSync(data, { recursive: true }); app.setPath('userData', data); app.setPath('sessionData', data)
const file = path.join(root, '课堂笔记.ladoc'), checkpoint = path.join(root,'checkpoint.json')
let openPath, holdRead = false, held = false
class HiddenWindow extends electron.BrowserWindow { constructor(options) { super({ ...options, width: 1024, height: 768, show: false, webPreferences: { ...options.webPreferences, offscreen: true } }) } show() {} }
class ControlledWorker extends RealWorker {
  constructor(file, options) { if (holdRead && options?.workerData?.action === 'note-read') { held=true; super('setInterval(()=>{},1000)',{eval:true}) } else super(file, options) }
}
const Module = require('node:module'), originalLoad = Module._load
Module._load = function(request,parent,main) {
  if (request === 'electron') return { ...electron, BrowserWindow: HiddenWindow, dialog: { ...electron.dialog, showOpenDialog: async () => openPath ? {canceled:false,filePaths:[openPath]} : {canceled:true,filePaths:[]} } }
  if (request === 'node:worker_threads') return {...originalLoad.call(this,request,parent,main),Worker:ControlledWorker}
  return originalLoad.call(this,request,parent,main)
}
const deadline = setTimeout(()=>{console.error('NOTE_IMPORT_TIMEOUT');app.exit(2)},70_000)
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
  const js = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(error.message+'\n表达式：'+code.slice(0,600)) })
  const raw = (group,method,...args) => js(`window.api[${JSON.stringify(group)}][${JSON.stringify(method)}](...${JSON.stringify(args)})`)
  const call = async (...args) => {const r=await raw(...args);assert.equal(r.ok,true,r.error);return r.data}
  const pause = ms => new Promise(resolve=>setTimeout(resolve,ms))
  const wait = async expr => {const end=Date.now()+10000;while(!await js(expr)){if(Date.now()>end)throw Error(`等待失败：${expr}\n${await js('document.body.innerText')}`);await pause(30)}}
  const click = label => js(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled||!b.getClientRects().length)throw Error('按钮不可操作：'+${JSON.stringify(label)});b.click();return true})()`)
  const worker = input => new Promise((resolve,reject)=>{const w=new RealWorker(path.join(__dirname,'../out/main/learning-package-worker.js'),{workerData:input});w.once('error',reject);w.once('message',m=>{void w.terminate();m.type==='done'?resolve(m.result):reject(Error(m.error))})})
  try {
    await wait('!!window.api')
    if (phase==='prepare') {
      assert.equal((await call('notes','list')).length,0)
      await worker({action:'note-write',manifest:fixture(),files:[],output:file})
      console.log('NOTE_IMPORT_PREPARE_OK independent source directory, actual ZIP worker');clearTimeout(deadline);app.exit(0);return
    }
    const db = new (require('better-sqlite3'))(path.join(data,'learning-assistant.db'))
    const allCounts = () => ['notes','note_segments','note_learning_documents','note_learning_blocks','note_learning_revisions','annotations','knowledge_points','knowledge_evidence','note_package_imports'].map(table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n)
    openPath=file
    if (phase==='resume') {
      const saved=JSON.parse(fs.readFileSync(checkpoint,'utf8')), doc=await call('notes','learningGet',{note_id:saved.note_id,revision_id:saved.revision_id})
      assert.deepEqual(doc.state,saved.state);assert.deepEqual(doc.sources,saved.sources);assert.deepEqual(doc.external_materials,saved.external_materials)
      assert.equal((await call('notes','packageReceipt',saved.note_id)).evidence[0].quote,fixture().evidence[1].quote)
      const preview=await call('notes','packagePreview'), before=allCounts(),result=await call('notes','packageImport',{ticket:preview.ticket,subject_id:saved.subject,include_concepts:false})
      assert.equal(result.created,false);assert.equal(result.note_id,saved.note_id);assert.equal(result.include_concepts,true);assert.deepEqual(allCounts(),before)
      assert.equal((await call('notes','get',saved.note_id)).segments[0].organized_text,'导入后人工修改😀')
      assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();console.log('NOTE_IMPORT_RESTART_OK mappings, fixed history, manual edits, receipt and dedup survive actual restart');clearTimeout(deadline);app.exit(0);return
    }
    assert.equal((await call('notes','list')).length,0)
    const subject=(await call('subjects','list'))[0].id, initial=allCounts()
    openPath=undefined;assert.equal(await call('notes','packagePreview'),null);openPath=file
    await js("location.hash='/notes'");await wait("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='导入笔记文档包')")
    await click('导入笔记文档包');await wait("!!document.querySelector('.learning-package-preview')")
    assert.deepEqual(allCounts(),initial);assert.match(await js('document.body.innerText'),/1 个标注和 1 项证据与修订不匹配/)
    await click('取消预览');await wait("!document.querySelector('.learning-package-preview')");assert.deepEqual(allCounts(),initial)
    let preview=await call('notes','packagePreview');assert.equal(Object.hasOwn(preview,'manifest'),false);assert.equal(Object.hasOwn(preview,'origins'),false)
    let failed=await raw('notes','packageImport',{ticket:preview.ticket,subject_id:'missing-subject',include_concepts:true});assert.equal(failed.ok,false);assert.deepEqual(allCounts(),initial)
    preview=await call('notes','packagePreview');db.exec("CREATE TRIGGER manufacture_import_failure BEFORE INSERT ON note_package_imports BEGIN SELECT RAISE(ABORT,'native rollback failure'); END")
    try {failed=await raw('notes','packageImport',{ticket:preview.ticket,subject_id:subject,include_concepts:true});assert.equal(failed.ok,false);assert.match(failed.error,/native rollback failure/)}finally{db.exec('DROP TRIGGER manufacture_import_failure')}
    assert.deepEqual(allCounts(),initial)
    // 暂停只用于稳定触发取消；正常读写仍使用实际归档线程。
    holdRead=true;const pending=raw('notes','packagePreview');for(let i=0;i<100&&!held;i++)await pause(20);assert.equal(held,true)
    assert.equal(await call('notes','packageImportCancel'),true);assert.equal((await pending).ok,false);holdRead=false;assert.deepEqual(allCounts(),initial)
    await click('导入笔记文档包');await wait("!!document.querySelector('.learning-package-preview')")
    await js(`(()=>{const s=document.querySelector('select[aria-label="笔记包目标学科"]');s.value=${JSON.stringify(subject)};s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
    await click('确认导入');await wait("!!document.querySelector('.learning-reader') && !!document.querySelector('.learning-entry')")
    const note=(await call('notes','list'))[0],doc=await call('notes','learningGet',{note_id:note.id}),original=fixture()
    assert.equal(doc.sources.length,2);assert.equal(doc.pending_sync,undefined)
    for(const source of original.sources) {
      const local=doc.sources[source.ordinal], origin=doc.origins[local.id], old=original.origins[source.id]
      assert.equal(local.raw_text,source.raw_text);assert.equal(local.heading,source.heading);assert.equal(origin.raw_text,old.raw_text);assert.equal(origin.segment_revision,old.segment_revision);assert.equal(origin.model,old.model);assert.equal(origin.material_ref,null)
    }
    assert.equal(doc.state.entries[0].formulas[0].latex,'p = mv');assert.equal(doc.state.relations[0].from,doc.state.entries[1].id)
    const imported=await call('notes','get',note.id);assert.equal(imported.annotations.length,1);assert.equal(imported.annotations[0].comment,'当前重点')
    assert.equal(db.prepare('SELECT count(*) n FROM knowledge_evidence').get().n,1)
    await js("(()=>{document.querySelector('.learning-note-receipt').open=true;document.querySelector('.learning-entry details').open=true;return true})()")
    await wait("document.body.innerText.includes('历史疑问不得标到新正文')")
    assert.match(await js('document.body.innerText'),/未关联的外部教材：原课堂课件/)
    assert.equal(await js("Array.from(document.querySelectorAll('a')).some(a=>a.href.includes('foreign-material'))"),false)
    fs.writeFileSync(path.join(root,'note-import.png'),(await win.webContents.capturePage()).toPNG())
    fs.writeFileSync(checkpoint,JSON.stringify({note_id:note.id,revision_id:doc.revision_id,state:doc.state,sources:doc.sources,external_materials:doc.external_materials,subject}))
    await call('notes','updateSegment',imported.segments[0].id,{organized_text:'导入后人工修改😀'})
    preview=await call('notes','packagePreview');const result=await call('notes','packageImport',{ticket:preview.ticket,subject_id:subject,include_concepts:true});assert.equal(result.created,false);assert.equal(result.note_id,note.id)
    assert.equal((await call('notes','get',note.id)).segments[0].organized_text,'导入后人工修改😀')
    failed=await raw('notes','packageImport',{ticket:preview.ticket,subject_id:subject,include_concepts:true});assert.equal(failed.ok,false)
    const wrong=await raw('learning','packagePreview');assert.equal(wrong.ok,false);assert.match(wrong.error,/笔记文档包.*笔记页/)
    assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close()
    console.log('NOTE_IMPORT_OK preview/cancel, rollback, actual worker, empty-directory import, provenance, UI and edit/reimport');clearTimeout(deadline);app.exit(0)
  } catch(error) {console.error(error.stack||error);clearTimeout(deadline);app.exit(1)}
}))
require('../out/main/index.js')
