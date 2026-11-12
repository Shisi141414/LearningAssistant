import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { invoke } from './test-support.mjs'
import fixture from './note-package-fixture.cjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { validateNotePackage } from '../src/main/services/note-package-validation.ts'
import { installNotePackage } from '../src/main/services/note-package-import-store.ts'
import { notePackageReceipt } from '../src/main/services/note-package-receipts.ts'
import { getNoteLearning } from '../src/main/services/note-learning.ts'
import { notePackageSnapshot } from '../src/main/services/note-package-export.ts'
import { saveConcept } from '../src/main/services/concepts.ts'
import { validateIpc } from '../src/main/services/security.ts'
registerAllIpc(); after(() => closeDb())
const ok = r => { assert.equal(r.ok, true, r.error); return r.data }
function subject() { const id=nanoid(); getDb().prepare('INSERT INTO subjects(id,name,created_at) VALUES (?,?,0)').run(id,'导入学科 '+id); return id }
const decoded = () => { const manifest=fixture(); validateNotePackage(manifest); return { manifest, sha256: nanoid(), files: [] } }
const counts = () => ['notes','note_segments','note_learning_documents','note_learning_blocks','note_learning_revisions','annotations','knowledge_points','concept_aliases','knowledge_evidence','note_package_imports'].map(table => getDb().prepare(`SELECT count(*) AS n FROM ${table}`).get().n)
test('笔记包原子重建全部文字、语义、公式、模型与历史出处；来源稳定且不使用外部导航身份', () => {
  const d=decoded(), target=subject(), result=installNotePackage(d,target,true), doc=getNoteLearning({note_id:result.note_id})
  assert.equal(result.created,true); assert.notEqual(doc.id,d.manifest.document.id); assert.notEqual(doc.note_id,d.manifest.document.note_id)
  assert.equal(doc.revision_id,result.revision_id); assert.equal(doc.pending_sync,undefined); assert.equal(getNoteLearning({note_id:result.note_id}).revision_id,doc.revision_id)
  const mapping=JSON.parse(getDb().prepare('SELECT mapping_json FROM note_package_imports WHERE note_id=?').get(result.note_id).mapping_json)
  for (const source of d.manifest.sources) {
    const local=doc.sources[source.ordinal], original=d.manifest.origins[source.id], origin=doc.origins[local.id]
    assert.equal(local.raw_text,source.raw_text); assert.equal(local.heading,source.heading); assert.equal(local.id,mapping.sources[source.id])
    assert.deepEqual({...origin,segment_id:original.segment_id,material_ref:original.material_ref},original)
    assert.equal(origin.material_ref,null); assert.equal(JSON.parse(local.locator_json).note_id,result.note_id)
  }
  assert.deepEqual(doc.external_materials[doc.sources[0].id],d.manifest.origins['source-0'].material_ref)
  const expected=structuredClone(d.manifest.state)
  for (const entry of expected.entries) { entry.id=mapping.entries[entry.id]; for(const ref of entry.sources) ref.source_id=mapping.sources[ref.source_id] }
  for (const relation of expected.relations) {relation.from=mapping.entries[relation.from];relation.to=mapping.entries[relation.to]}
  assert.deepEqual(doc.state,expected)
  const note=getDb().prepare('SELECT * FROM notes WHERE id=?').get(result.note_id); assert.equal(note.source,'import')
  const annotations=getDb().prepare('SELECT * FROM annotations WHERE segment_id=?').all(mapping.segments['segment-0']); assert.equal(annotations.length,1);assert.equal(annotations[0].comment,'当前重点')
  const evidence=getDb().prepare('SELECT * FROM knowledge_evidence WHERE note_segment_id=?').all(mapping.segments['segment-0']);assert.equal(evidence.length,1);assert.equal(evidence[0].created_at,2100)
  const receipt=notePackageReceipt(result.note_id);assert.deepEqual(receipt.annotations,d.manifest.annotations.filter(a=>!a.matches_revision));assert.equal(receipt.evidence[0].quote,d.manifest.evidence[1].quote)
  const again=notePackageSnapshot({note_id:doc.note_id,revision_id:doc.revision_id});validateNotePackage(again);assert.deepEqual(again.origins[doc.sources[0].id].material_ref,d.manifest.origins['source-0'].material_ref)
})
test('重复导入保留人工文字和固定副本；不携带概念时不附加证据；删除后不静默制造副本', async () => {
  const d=decoded(),target=subject(),first=installNotePackage(d,target,false), before=counts()
  assert.equal(first.concepts_created,0)
  const segment=getDb().prepare('SELECT id FROM note_segments WHERE note_id=? ORDER BY sort_order').get(first.note_id)
  ok(await invoke('notes:updateSegment',{id:segment.id,organized_text:'后续人工修改😀'}))
  const again=installNotePackage(d,target,true);assert.equal(again.note_id,first.note_id);assert.equal(again.created,false);assert.equal(again.include_concepts,false)
  assert.equal(getDb().prepare('SELECT organized_text FROM note_segments WHERE id=?').get(segment.id).organized_text,'后续人工修改😀')
  assert.equal(counts()[0],before[0]);assert.deepEqual(notePackageReceipt(first.note_id).evidence,[])
  ok(await invoke('notes:remove',first.note_id));assert.throws(()=>installNotePackage(d,target,true),/已删除/)
  assert.equal(getDb().prepare('SELECT count(*) n FROM note_package_imports WHERE package_sha256=?').get(d.sha256).n,1)
})
test('原包同名内容一致的概念复用、冲突另存；强制中途失败和取消时全部登记回滚', () => {
  const d=decoded(),target=subject(),same=saveConcept({subject_id:target,...d.manifest.concepts[0],id:undefined}),different=saveConcept({subject_id:target,name:'力',summary:'本机人工定义',aliases:[]})
  const result=installNotePackage(d,target,true);assert.equal(result.concepts_reused,1);assert.equal(result.concept_conflicts,1);assert.equal(result.concepts_created,1)
  assert.equal(getDb().prepare('SELECT summary FROM knowledge_points WHERE id=?').get(different.id).summary,'本机人工定义')
  assert.equal(getDb().prepare('SELECT concept_id FROM knowledge_evidence WHERE note_segment_id IN (SELECT id FROM note_segments WHERE note_id=?)').get(result.note_id).concept_id,same.id)
  const before=counts();getDb().exec("CREATE TEMP TRIGGER fail_import BEFORE INSERT ON note_package_imports BEGIN SELECT RAISE(ABORT,'manufactured import failure'); END")
  try {assert.throws(()=>installNotePackage(decoded(),subject(),true),/manufactured/)} finally {getDb().exec('DROP TRIGGER fail_import')}
  assert.deepEqual(counts(),before)
  let checks=0;assert.throws(()=>installNotePackage(decoded(),target,true,()=>++checks>1),/已取消/);assert.deepEqual(counts(),before)
})
test('来源编辑、同步及删除后历史修订仍保存外部出处与原包；重启保持映射', async () => {
  const d=decoded(),result=installNotePackage(d,subject(),true),old=getNoteLearning({note_id:result.note_id}),segment=old.origins[old.sources[0].id].segment_id
  ok(await invoke('notes:updateSegment',{id:segment,organized_text:'人工修改后的新正文'}))
  const pending=getNoteLearning({note_id:result.note_id});assert.ok(pending.pending_sync)
  const preview=ok(await invoke('notes:learningPreview',result.note_id));const current=ok(await invoke('notes:learningSync',{note_id:result.note_id,expected_revision_id:preview.base_revision_id,fingerprint:preview.fingerprint}))
  assert.equal(Object.values(current.external_materials)[0].material_title,'原课堂课件')
  ok(await invoke('notes:removeSegment',segment));closeDb()
  const historical=getNoteLearning({note_id:result.note_id,revision_id:old.revision_id});assert.deepEqual(historical.sources,old.sources);assert.deepEqual(historical.external_materials,old.external_materials);assert.equal(notePackageReceipt(result.note_id).evidence[0].quote,d.manifest.evidence[1].quote)
})
test('迁移18升19保留人工段落与关联；迁移事务失败可重试；IPC不接受路径或伪造清单', () => {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');for(const m of MIGRATIONS.filter(m=>m.version<19))db.exec(m.sql)
  db.exec("INSERT INTO notes(id,title,created_at,updated_at) VALUES ('n','旧笔记',1,1); INSERT INTO note_segments(id,note_id,sort_order,raw_text,organized_text,created_at,updated_at) VALUES ('s','n',0,'原文','人工整理',1,2); INSERT INTO annotations VALUES ('a','s','keypoint',NULL,'保留',3)")
  const migration=MIGRATIONS.find(m=>m.version===19)
  assert.throws(()=>db.transaction(()=>{db.exec(migration.sql);throw Error('中断')})(),/中断/);assert.equal(db.prepare('PRAGMA table_info(note_segments)').all().some(c=>c.name==='learning_heading'),false)
  db.transaction(()=>db.exec(migration.sql))();assert.equal(db.prepare('SELECT organized_text,learning_heading FROM note_segments').get().organized_text,'人工整理');assert.equal(db.prepare('SELECT comment FROM annotations').get().comment,'保留');assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close()
  assert.throws(()=>validateIpc('notes:packagePreview',[{path:'D:\\private.ladoc'}]))
  assert.throws(()=>validateIpc('notes:packageImport',[{ticket:'x',subject_id:'s',include_concepts:true,manifest:fixture()}]))
})
