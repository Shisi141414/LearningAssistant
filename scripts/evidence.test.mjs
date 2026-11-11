import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { initialLearningState } from '../shared/learning-document.ts'
import { evidenceHref, evidenceLookup } from '../shared/evidence.ts'

registerAllIpc()
const ok = response => { assert.equal(response.ok,true,response.error);return response.data }
let sequence=0
const id=()=>`evidence-test-${++sequence}`
function fixture(db=getDb()){
  const material=id(),version=id(),document=id(),revision=id()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?, ?, 0)').run(material,'固定教材标题')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'source.pdf','unused.pdf','pdf','hash','ready',0)").run(version,material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version,material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document,version)
  const sources=['定理😀：完整不可改写的定理。','证明：据定义和前提推导。'].map((raw_text,ordinal)=>({id:id(),ordinal,raw_text,heading:'',locator_json:JSON.stringify({kind:'pdf',page:ordinal+1}),extraction:'native'}))
  const state=initialLearningState(sources,id)
  state.entries[0].type='theorem';state.entries[0].title='原始定理标题'
  for(const source of sources)db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)').run(source.id,document,source.ordinal,source.raw_text,'',source.locator_json,'native')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision,document,JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision,document)
  return {material,version,document,revision,sources,state,source:{kind:'learning',material_id:material,version_id:version,revision_id:revision,entry_id:state.entries[0].id}}
}
const concept=async()=>ok(await invoke('concepts:save',{name:'能量方法 '+id(),summary:'不被引用自动改写',aliases:['别名 '+id()],subject_id:null}))
const add=(concept_id,source,extra={})=>invoke('evidence:add',{concept_id,source,role:'source',memo:'引用条件保持不变',...extra})
const list=async concept_id=>ok(await invoke('evidence:list',{concept_id}))

test('v11 升级只追加证据表，保留原文/修订/概念与外键',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON')
  for(const migration of MIGRATIONS.filter(m=>m.version<=11))db.exec(migration.sql)
  const document=fixture(db)
  db.prepare("INSERT INTO knowledge_points(id,name,summary,created_at) VALUES ('old-concept','旧概念','旧释义',0)").run()
  const before=db.prepare('SELECT snapshot_json FROM learning_revisions WHERE id=?').get(document.revision)
  db.exec(MIGRATIONS.find(m=>m.version===12).sql)
  assert.deepEqual(db.prepare('SELECT snapshot_json FROM learning_revisions WHERE id=?').get(document.revision),before)
  assert.equal(db.prepare('SELECT summary FROM knowledge_points').get().summary,'旧释义')
  assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_evidence').get().n,0)
  assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close()
})
test('主进程固定修订取证，拒绝伪造正文和错配；重整/新材料版本/归档不改变旧证据',async()=>{
  const c=await concept(),doc=fixture(),created=ok(await add(c.id,doc.source,{role:'definition'})).evidence
  assert.equal(created.quote,doc.sources[0].raw_text);assert.equal(created.entry_title,'原始定理标题')
  assert.equal(created.source_status,'current');assert.match(created.location,/修订 1.*PDF 第 1 页/)
  assert.match(evidenceHref(created),new RegExp(`revision=${doc.revision}.*entry=${doc.source.entry_id}`))
  assert.equal((await add(c.id,{...doc.source,material_id:'wrong'})).ok,false)
  assert.equal((await add(c.id,{...doc.source,revision_id:fixture().revision})).ok,false)
  assert.equal((await add(c.id,doc.source,{quote:'伪造正文'})).ok,false)
  assert.equal((await add(c.id,{...doc.source,quote:'伪造来源'})).ok,false)
  const duplicate=ok(await add(c.id,doc.source,{memo:'不能覆盖旧说明',role:'proof'}))
  assert.equal(duplicate.created,false);assert.equal(duplicate.evidence.memo,created.memo);assert.equal(duplicate.evidence.role,'definition')
  const changed=ok(await invoke('learning:change',{version_id:doc.version,expected_revision_id:doc.revision,entry_id:doc.source.entry_id,action:'split',position:5}))
  assert.notEqual(changed.revision_id,doc.revision)
  assert.equal((await list(c.id)).items[0].source_status,'historical')
  assert.equal((await list(c.id)).items[0].quote,created.quote)
  const second=ok(await add(c.id,{...doc.source,revision_id:changed.revision_id})).evidence
  assert.notEqual(second.id,created.id);assert.notEqual(second.quote,created.quote)
  getDb().prepare('UPDATE materials SET current_version_id=NULL, archived=1 WHERE id=?').run(doc.material)
  assert.ok((await list(c.id)).items.every(item=>item.source_status==='archived'))
  assert.equal((await list(c.id)).items.find(item=>item.id===created.id).quote_sha256,created.quote_sha256)
  assert.equal(ok(await invoke('concepts:list')).find(item=>item.id===c.id).summary,'不被引用自动改写')
  assert.throws(()=>getDb().prepare('DELETE FROM learning_revisions WHERE id=?').run(doc.revision),/FOREIGN KEY/)
})
test('笔记原文/整理分开引用，未保存及并发修改拒绝，修改和删除仍保留快照',async()=>{
  const c=await concept(),note=ok(await invoke('notes:create',{title:'可变笔记'}))
  const segment=ok(await invoke('notes:addSegment',{note_id:note.id,raw_text:'原文😀内容',organized_text:'整理后的解释'}))
  const source={kind:'note',note_id:note.id,segment_id:segment.id,field:'raw_text'}
  assert.equal((await add(c.id,source,{expected_note_text:'未保存内容'})).ok,false)
  const raw=ok(await add(c.id,source,{expected_note_text:segment.raw_text})).evidence
  const organized=ok(await add(c.id,{...source,field:'organized_text'},{expected_note_text:segment.organized_text})).evidence
  assert.notEqual(raw.id,organized.id);assert.equal(organized.quote,segment.organized_text)
  assert.match(evidenceHref(raw),/view=raw/)
  ok(await invoke('notes:updateSegment',{id:segment.id,raw_text:'更改后的原文'}))
  assert.equal((await add(c.id,source,{expected_note_text:segment.raw_text})).ok,false)
  assert.equal((await list(c.id)).items.find(item=>item.id===raw.id).source_status,'changed')
  assert.equal((await list(c.id)).items.find(item=>item.id===organized.id).source_status,'current')
  ok(await invoke('notes:remove',note.id))
  const deleted=(await list(c.id)).items
  assert.ok(deleted.every(item=>item.source_status==='deleted'&&evidenceHref(item)===null))
  assert.equal(deleted.find(item=>item.id===raw.id).quote,segment.raw_text)
  assert.deepEqual(getDb().pragma('foreign_key_check'),[])
})
test('知识点与引用原子创建；空或过长内容失败全部回滚；移除引用不删来源',async()=>{
  const doc=fixture(),input={source:doc.source,role:'proof',memo:'条件说明',concept:{name:'新建 '+id(),subject_id:null,summary:'人工摘要',aliases:['新别名 '+id()]}}
  const created=ok(await invoke('evidence:createConcept',input))
  assert.equal(created.evidence.concept_id,created.concept.id)
  const count=()=>getDb().prepare('SELECT count(*) AS n FROM knowledge_points').get().n
  const before=count()
  assert.equal((await invoke('evidence:createConcept',{...input,source:{...doc.source,entry_id:'missing'}})).ok,false)
  assert.equal(count(),before)
  for(const body of ['', '甲'.repeat(40001)]){
    getDb().prepare('UPDATE learning_sources SET raw_text=? WHERE id=?').run(body,doc.sources[0].id)
    assert.equal((await invoke('evidence:createConcept',{...input,concept:{...input.concept,name:id()}})).ok,false)
    assert.equal(count(),before)
  }
  ok(await invoke('evidence:remove',created.evidence.id))
  assert.equal((await list(created.concept.id)).total,0)
  assert.ok(getDb().prepare('SELECT id FROM learning_revisions WHERE id=?').get(doc.revision))
  assert.ok(getDb().prepare('SELECT id FROM knowledge_points WHERE id=?').get(created.concept.id))
})
test('证据分页、每概念容量、内容去重和数据库重开保持稳定',async()=>{
  const c=await concept(),note=ok(await invoke('notes:create',{title:'分页证据'})),segment=ok(await invoke('notes:addSegment',{note_id:note.id,raw_text:'0'}))
  const source={kind:'note',note_id:note.id,segment_id:segment.id,field:'raw_text'}
  let first
  for(let i=0;i<100;i++){
    getDb().prepare('UPDATE note_segments SET raw_text=? WHERE id=?').run(String(i),segment.id)
    const value=ok(await add(c.id,source,{expected_note_text:String(i)})).evidence
    if(i===0)first=value
  }
  getDb().prepare("UPDATE note_segments SET raw_text='overflow' WHERE id=?").run(segment.id)
  assert.match((await add(c.id,source,{expected_note_text:'overflow'})).error,/100/)
  getDb().prepare("UPDATE note_segments SET raw_text='0' WHERE id=?").run(segment.id)
  assert.equal(ok(await add(c.id,source,{expected_note_text:'0'})).evidence.id,first.id)
  const all=[];let offset=0
  do{const page=ok(await invoke('evidence:list',{concept_id:c.id,offset}));assert.equal(page.total,100);assert.ok(page.items.length<=20);all.push(...page.items);offset=page.next_offset}while(offset!==null)
  assert.equal(new Set(all.map(item=>item.id)).size,100)
  assert.equal(ok(await invoke('evidence:list',{source})).total,100)
  assert.equal(evidenceLookup(source),evidenceLookup({field:'raw_text',segment_id:segment.id,note_id:note.id,kind:'note'}))
  closeDb();assert.equal((await list(c.id)).total,100)
})
after(()=>closeDb())
