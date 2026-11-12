import './test-support.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtemp, writeFile, readFile, readdir, mkdir, chmod, access, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { createCanvas } from '@napi-rs/canvas'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, dbFilePath, closeDb } from '../src/main/services/db.ts'
import { saveConcept, listConcepts } from '../src/main/services/concepts.ts'
import { getLearningDocument, changeLearningDocument } from '../src/main/services/learning-documents.ts'
import { materialPath } from '../src/main/services/materials.ts'
import { materialOcrPage } from '../src/main/services/material-derivations.ts'
import { convertedMaterialFile } from '../src/main/services/office-conversions.ts'
import { installLearningPackage, recoverLearningPackageImports } from '../src/main/services/learning-package-import-store.ts'
import { verifyLearningPackageFiles } from '../src/main/services/learning-package-codec.ts'
import { validateLearningPackage } from '../src/main/services/learning-package-validation.ts'
import { remapLearningPackage, learningPackageBlocks } from '../shared/learning-package-remap.ts'
import { validateLearningState, entryText } from '../shared/learning-document.ts'
import { validateIpc } from '../src/main/services/security.ts'
import { confirmLearningPackage, cancelLearningPackageImport } from '../src/main/services/learning-package-import.ts'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function subject() { const id=nanoid(); getDb().prepare('INSERT INTO subjects(id,name,created_at) VALUES (?,?,0)').run(id,'导入学科 '+id); return id }
async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'learning-import-fixture-')),original=Buffer.from('%PDF-1.4\noriginal unchanged'),png=createCanvas(80,50).toBuffer('image/png')
  const sources=[{id:'s0',ordinal:0,raw_text:'第一章',heading:'章',locator_json:'{"kind":"pdf","page":1}',extraction:'native'}, {id:'s1',ordinal:1,raw_text:'动量定理😀 F=ma。',heading:'',locator_json:'{"kind":"pdf","page":2}',extraction:'manual'}, {id:'s2',ordinal:2,raw_text:'由运动定律推导。',heading:'',locator_json:'{"kind":"pdf","page":3}',extraction:'native'}]
  const manifest={format:'learning-assistant/document',schema_version:'0.2',document:{id:'doc-origin',version_id:'version-origin',revision_id:'revision-origin',title:'可移植力学文档',kind:'handout',created_at:123,subject_name:'理论力学'},original:{format:'pdf',file_name:'原件.pdf',derivation:'correction',path:'source/original.pdf',sha256:sha(original),byte_length:original.length},conversion:null,sources,
    state:{entries:[{id:'chapter',type:'section',title:'第一章',sources:[{source_id:'s0'}],analysis:{method:'manual',review_status:'confirmed'}},{id:'theorem',type:'theorem',parent_id:'chapter',title:'动量定理',sources:[{source_id:'s1'}],analysis:{method:'manual',review_status:'confirmed'},formulas:[{range:[7,11],latex:'F=ma',display:true}],figures:[{asset_id:'picture',caption:'原页图片'}]},{id:'proof',type:'proof',parent_id:'chapter',title:'证明',sources:[{source_id:'s2'}],analysis:{method:'ai',model:'local/test',review_status:'confirmed'}}],relations:[{from:'proof',to:'theorem',type:'proves',review_status:'confirmed'}]},
    assets:[{id:'picture',mime_type:'image/png',sha256:sha(png),width:80,height:50,locator_json:JSON.stringify({kind:'pdf',page:2,source:'pdf-crop:v1',bbox:[0,0,80,50],pageSize:[600,800],crop:{rect:[0.1,0.2,0.4,0.2],rotation:0,engine:'test'}}),alt_text:'配图',path:'assets/picture.png',byte_length:png.length}],asset_extraction:null,
    ocr_pages:[{page:2,raw_text:'动量定理 F=ma。',corrected_text:sources[1].raw_text,confidence:88,width:800,height:1200,lines_json:'[]',model_json:'{"engine":"test"}'}],
    concepts:[{id:'momentum',name:'动量定理',summary:'包内释义',aliases:['动量原理']},{id:'newton',name:'运动定律',summary:'同名的另一条内容',aliases:['Newton law']}],evidence:[{concept_id:'momentum',entry_id:'theorem',role:'definition',memo:'导入证据',quote_sha256:sha(sources[1].raw_text)},{concept_id:'newton',entry_id:'proof',role:'proof',memo:'导入推导',quote_sha256:sha(sources[2].raw_text)}]}
  validateLearningPackage(manifest)
  const files=[]
  for(const [path,bytes] of [[manifest.original.path,original],[manifest.assets[0].path,png]]){const file=join(directory,`file-${files.length+1}.bin`);await writeFile(file,bytes);files.push({path,file})}
  return {manifest,files,sha256:sha(directory),original,png}
}
const verify=(manifest,files)=>verifyLearningPackageFiles(manifest,new Map(files))
const install=(f,s,include=true,v=verify,aborted)=>installLearningPackage(f,learningPackageBlocks(f.manifest),s,include,v,aborted)
const counts=()=>Object.fromEntries(['materials','material_versions','learning_documents','learning_sources','learning_revisions','learning_assets','knowledge_points','knowledge_evidence','learning_package_imports'].map(table=>[table,getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get().n]))
const directories=async()=>readdir(join(dirname(dbFilePath()),'materials')).catch(()=>[])

test('迁移 15 可回滚并从 14 升级，旧修订、来源、图片与证据保持不变',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON')
  for(const m of MIGRATIONS.filter(m=>m.version<=14))db.exec(m.sql);db.pragma('user_version=14')
  db.exec("INSERT INTO materials(id,title,created_at) VALUES ('m','旧文档',0); INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES ('v','m','x.pdf','x.pdf','pdf','sha','ready',0); INSERT INTO learning_documents(id,version_id,created_at) VALUES ('d','v',0); INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES ('r','d','{}',0); UPDATE learning_documents SET current_revision_id='r'; INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES ('s','d',0,'原文','','{}','native'); INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES ('a','d','image/png','sha','x.png',1,1,'{}','图',0); INSERT INTO knowledge_points(id,name,created_at) VALUES ('c','概念',0); INSERT INTO knowledge_evidence(id,concept_id,version_id,revision_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,location,entry_title,created_at) VALUES ('e','c','v','r','{}','key','key','source','','原文','sha','旧文档','原位','',0)")
  const tables=['learning_documents','learning_revisions','learning_sources','learning_assets','knowledge_evidence'],before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()),sql=MIGRATIONS.find(m=>m.version===15).sql
  assert.throws(()=>db.transaction(()=>{db.exec(sql);throw Error('upgrade failure')})(),/upgrade failure/);assert.equal(db.pragma('user_version',{simple:true}),14)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='learning_package_imports'").get().n,0)
  db.transaction(()=>{db.exec(sql);db.pragma('user_version=15')})();assert.deepEqual(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()),before);assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close()
})
test('编号映射保留 UTF-16、章节、公式、配图和证明关系，不改包内原文',async()=>{
  const f=await fixture(),before=structuredClone(f.manifest),remap=remapLearningPackage(f.manifest,nanoid)
  validateLearningState(remap.state,remap.units)
  assert.notEqual(remap.units[0].id,'s0');assert.equal(remap.state.entries[1].parent_id,remap.state.entries[0].id)
  assert.equal(remap.state.relations[0].to,remap.state.entries[1].id);assert.equal(remap.state.entries[1].figures[0].asset_id,remap.assets.get('picture'))
  assert.deepEqual(remap.state.entries[1].formulas,f.manifest.state.entries[1].formulas);assert.equal(entryText(remap.state.entries[1],new Map(remap.units.map(s=>[s.id,s]))),f.manifest.sources[1].raw_text)
  assert.deepEqual(f.manifest,before)
})
test('完整安装、精确概念复用、同名冲突与证据重映射；重复导入不覆盖，跨学科独立',async()=>{
  const f=await fixture(),s=subject(),s2=subject(),before=structuredClone(f.manifest)
  const exact=saveConcept({subject_id:s,...f.manifest.concepts[0],id:undefined}),conflict=saveConcept({subject_id:s,name:'运动定律',summary:'保留旧释义',aliases:['Newton law']})
  const result=await install(f,s);assert.deepEqual([result.concepts_created,result.concepts_reused,result.concept_conflicts],[1,1,1])
  const doc=getLearningDocument({version_id:result.version_id});assert.equal(doc.history.length,1);assert.deepEqual(doc.state.entries[1].formulas,f.manifest.state.entries[1].formulas)
  assert.deepEqual(await readFile(materialPath(result.version_id)),f.original)
  const row=getDb().prepare('SELECT * FROM learning_package_imports WHERE version_id=?').get(result.version_id),ids=JSON.parse(row.id_map_json)
  assert.equal(ids.concepts.momentum,exact.id);assert.notEqual(ids.concepts.newton,conflict.id);assert.equal(ids.entries.theorem,doc.state.entries[1].id)
  assert.deepEqual(await readFile(join(dirname(dbFilePath()),getDb().prepare('SELECT file_path FROM learning_assets WHERE id=?').get(ids.assets.picture).file_path)),f.png)
  const evidence=getDb().prepare('SELECT * FROM knowledge_evidence WHERE version_id=? ORDER BY memo').all(result.version_id)
  assert.equal(evidence.length,2);assert.equal(JSON.parse(evidence.find(e=>e.role==='definition').source_json).entry_id,ids.entries.theorem)
  assert.equal(evidence.find(e=>e.role==='definition').quote_sha256,f.manifest.evidence[0].quote_sha256)
  assert.equal(materialOcrPage({version_id:result.version_id,page:2}).corrected_text,f.manifest.sources[1].raw_text)
  assert.equal(listConcepts().find(c=>c.id===conflict.id).summary,'保留旧释义');assert.deepEqual(f.manifest,before)
  const edited=changeLearningDocument({version_id:result.version_id,expected_revision_id:doc.revision_id,action:'edit',entry_id:doc.state.entries[1].id,type:'theorem',title:'导入后手动修改'})
  const installedCounts=counts(),duplicate=await install(f,s,false);assert.equal(duplicate.created,false);assert.equal(duplicate.version_id,result.version_id);assert.equal(duplicate.revision_id,edited.revision_id);assert.equal(duplicate.include_concepts,true);assert.deepEqual(counts(),installedCounts)
  const cross=await install(f,s2,false);assert.notEqual(cross.material_id,result.material_id);assert.equal(cross.concepts_created,0);assert.equal(getDb().prepare('SELECT count(*) n FROM knowledge_evidence WHERE version_id=?').get(cross.version_id).n,0)
  getDb().prepare('DELETE FROM subjects WHERE id=?').run(s2);assert.equal(getDb().prepare('SELECT subject_id FROM learning_package_imports WHERE version_id=?').get(cross.version_id).subject_id,null);assert.ok(getLearningDocument({version_id:cross.version_id}))
  assert.deepEqual(getDb().pragma('foreign_key_check'),[]);closeDb();assert.equal(getLearningDocument({version_id:result.version_id}).state.entries[1].figures[0].asset_id,ids.assets.picture)
})
test('复制后校验失败、事务写入失败和提交前取消全部回滚，只清理本批文件',async()=>{
  for(const mode of ['verify','transaction','cancel']){
    const f=await fixture(),s=subject(),before=counts(),dirs=await directories();let cancelled=false
    if(mode==='transaction')getDb().exec("CREATE TEMP TRIGGER fail_package_evidence BEFORE INSERT ON knowledge_evidence BEGIN SELECT RAISE(ABORT,'injected transaction failure'); END")
    try { await assert.rejects(install(f,s,true,async(m,files)=>{await verify(m,files);if(mode==='verify')throw Error('injected verify failure');if(mode==='cancel')cancelled=true},()=>cancelled),/injected|取消/) }
    finally {if(mode==='transaction')getDb().exec('DROP TRIGGER fail_package_evidence')}
    assert.deepEqual(counts(),before);assert.deepEqual((await directories()).sort(),dirs.sort());assert.deepEqual(await readFile(f.files[0].file),f.original)
  }
})
test('校验拒绝预览后改变的字节，已有材料保持可读',async()=>{
  const f=await fixture(),s=subject(),before=counts();await writeFile(f.files[0].file,'changed after preview')
  await assert.rejects(install(f,s),/预览后发生变化|容量超过/);assert.deepEqual(counts(),before)
})
test('中断恢复不清理存活进程和未知文件，清理只读的已登记附件后可重试',async()=>{
  const db=getDb(),s=subject(),version=nanoid(),id=nanoid(),directory=join(dirname(dbFilePath()),'materials',version);await mkdir(directory,{recursive:true})
  const file=join(directory,'source.pdf');await writeFile(file,'interrupted');await chmod(file,0o444);await writeFile(join(directory,'unknown.txt'),'保留未知文件')
  db.prepare("INSERT INTO learning_package_imports(id,package_sha256,subject_id,status,planned_version_id,directory_created,owner_pid,inventory_json,origin_document_id,origin_version_id,origin_revision_id,include_concepts,created_at) VALUES (?,? ,?,'staging',?,1,?,'[\"source.pdf\"]','d','v','r',0,0)").run(id,sha(id),s,version,process.pid)
  await recoverLearningPackageImports();await access(file)
  db.prepare('UPDATE learning_package_imports SET owner_pid=-1 WHERE id=?').run(id)
  await recoverLearningPackageImports();await assert.rejects(access(file));assert.equal(db.prepare('SELECT count(*) n FROM learning_package_imports WHERE id=?').get(id).n,1);assert.equal(await readFile(join(directory,'unknown.txt'),'utf8'),'保留未知文件')
  await mkdir(file);await writeFile(join(file,'child.txt'),'不递归处理其他目录');await recoverLearningPackageImports();assert.equal(await readFile(join(file,'child.txt'),'utf8'),'不递归处理其他目录');await unlink(join(file,'child.txt'));await rmdir(file)
  await unlink(join(directory,'unknown.txt'));await recoverLearningPackageImports();await assert.rejects(access(directory));assert.equal(db.prepare('SELECT count(*) n FROM learning_package_imports WHERE id=?').get(id).n,0)
})
test('导入 IPC 拒绝路径、正文和无效票据，不接受跨预览确认',async()=>{
  for(const args of [[{ticket:'x',subject_id:'s',include_concepts:true,path:'C:/x'}],[{ticket:'x',subject_id:'s',include_concepts:'yes'}],[{ticket:'x',subject_id:'s',include_concepts:true,state:{}}]])assert.throws(()=>validateIpc('learning:packageImport',args))
  assert.throws(()=>validateIpc('learning:packagePreview',['C:/x.ladoc']))
  await assert.rejects(confirmLearningPackage({ticket:'forged',subject_id:'s',include_concepts:true}),/预览不存在/);assert.equal(await cancelLearningPackageImport(),false)
})
test('旧 DOC/PPT 原件和转换产物分别保留，导入不依赖本机转换器',async()=>{
  for(const format of ['doc','ppt']){
    const f=await fixture(),m=f.manifest,convertedFormat=format==='doc'?'docx':'pptx',directory=dirname(f.files[0].file),original=Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]),converted=Buffer.from('PK synthetic converted fixture')
    m.original={format,file_name:`原件.${format}`,path:`source/original.${format}`,derivation:'native',sha256:sha(original),byte_length:original.length}
    m.conversion={format:convertedFormat,path:`source/converted.${convertedFormat}`,sha256:sha(converted),byte_length:converted.length,engine:'fixture converter',created_at:7}
    m.sources=[{id:'s',ordinal:0,raw_text:'原转换产物的规范正文',heading:'',locator_json:JSON.stringify({kind:convertedFormat,source:'source:1'}),extraction:'native'}]
    m.state={entries:[{id:'entry',type:'narrative',title:'',sources:[{source_id:'s'}],analysis:{method:'extracted',review_status:'unreviewed'}}],relations:[]};m.assets=[];m.asset_extraction=null;m.ocr_pages=[];m.concepts=[];m.evidence=[]
    f.files=[{path:m.original.path,file:join(directory,'legacy.bin')},{path:m.conversion.path,file:join(directory,'converted.bin')}];await writeFile(f.files[0].file,original);await writeFile(f.files[1].file,converted);validateLearningPackage(m)
    const result=await install(f,subject()),saved=convertedMaterialFile(result.version_id)
    assert.equal(saved.format,convertedFormat);assert.equal(saved.expectedFingerprint,sha(converted));assert.deepEqual(await readFile(saved.file),converted);assert.deepEqual(await readFile(materialPath(result.version_id)),original)
  }
})
test('复用概念的证据容量超限整批回滚，选择不携带概念后可重新导入',async()=>{
  const f=await fixture(),s=subject(),db=getDb(),concept=saveConcept({...f.manifest.concepts[0],id:undefined,subject_id:s})
  const insert=db.prepare("INSERT INTO knowledge_evidence(id,concept_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,location,entry_title,created_at) VALUES (?,?,'{}',?,?,'source','','保留的旧证据',?,'旧笔记','旧位置','',0)")
  for(let i=0;i<100;i++){const id=nanoid();insert.run(id,concept.id,id,id,sha('保留的旧证据'))}
  const before=counts(),dirs=await directories();await assert.rejects(install(f,s),/100 条/);assert.deepEqual(counts(),before);assert.deepEqual((await directories()).sort(),dirs.sort())
  const result=await install(f,s,false);assert.equal(result.created,true);assert.equal(db.prepare('SELECT count(*) n FROM knowledge_evidence WHERE concept_id=?').get(concept.id).n,100)
})

