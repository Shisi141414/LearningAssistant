import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
registerAllIpc(); after(() => closeDb())
const ok = r => { assert.equal(r.ok,true,r.error);return r.data }
const create = async () => ok(await invoke('projects:create',{title:'跨学科学习项目',goal:'应用动力学'}))
test('任务创建和更新都拒绝其他项目的里程碑；手动收件箱不能挂项目里程碑',async()=>{
  const a=await create(),b=await create(),ms=ok(await invoke('milestones:create',{project_id:b.id,title:'其他项目里程碑'}))
  assert.ok(ok(await invoke('projects:list',undefined)).some(project=>project.id===a.id), '预加载默认传递 undefined，不能被参数白名单拒绝')
  assert.ok(ok(await invoke('projects:list',null)).some(project=>project.id===b.id))
  const task=ok(await invoke('tasks:create',{project_id:a.id,title:'项目任务'}))
  assert.equal((await invoke('tasks:create',{project_id:a.id,milestone_id:ms.id,title:'非法归属'})).ok,false)
  assert.equal((await invoke('tasks:update',{id:task.id,milestone_id:ms.id})).ok,false)
  assert.equal(getDb().prepare('SELECT milestone_id FROM tasks WHERE id=?').get(task.id).milestone_id,null)
  const manual=ok(await invoke('tasks:create',{title:'独立任务'}))
  assert.equal((await invoke('tasks:update',{id:manual.id,milestone_id:ms.id})).ok,false)
  assert.equal((await invoke('tasks:create',{kind:'project_task',title:'无项目的项目任务'})).ok,false)
  assert.equal((await invoke('tasks:create',{kind:'manual',project_id:a.id,title:'归属矛盾'})).ok,false)
})
test('阻塞状态始终要求非空原因，不能通过单独清空原因绕过；拒绝重复知识引用',async()=>{
  const project=await create(),task=ok(await invoke('tasks:create',{project_id:project.id,title:'核对实验'}))
  assert.equal((await invoke('tasks:update',{id:task.id,status:'blocked'})).ok,false)
  ok(await invoke('tasks:update',{id:task.id,status:'blocked',blocked_reason:'等待仪器'}))
  assert.equal((await invoke('tasks:update',{id:task.id,blocked_reason:'  '})).ok,false)
  assert.equal((await invoke('tasks:update',{id:task.id,status:'blocked',blocked_reason:''})).ok,false)
  assert.equal(getDb().prepare('SELECT blocked_reason FROM tasks WHERE id=?').get(task.id).blocked_reason,'等待仪器')
  const concept=ok(await invoke('concepts:save',{subject_id:null,name:'动力学',summary:'用于实验',aliases:[]})),refs=[{concept_id:concept.id,why:'建立模型'},{concept_id:concept.id,why:'重复引用'}]
  assert.equal((await invoke('tasks:update',{id:task.id,knowledge_refs:refs})).ok,false)
  assert.equal((await invoke('tasks:create',{project_id:project.id,title:'重复引用',knowledge_refs:refs})).ok,false)
  assert.equal((await invoke('tasks:create',{project_id:project.id,title:'未知引用',knowledge_refs:[{concept_id:'missing',why:''}]})).ok,false)
})
test('项目任务、知识用途和日期往返，完成进度、里程碑删除与项目级联互不串扰',async()=>{
  const project=await create(),ms=ok(await invoke('milestones:create',{project_id:project.id,title:'实验完成',due_at:Date.now()}))
  const concept=ok(await invoke('concepts:save',{subject_id:null,name:'守恒方法',summary:'理论依据',aliases:[]})),refs=[{concept_id:concept.id,why:'用来校验数值结果'}]
  const task=ok(await invoke('tasks:create',{project_id:project.id,milestone_id:ms.id,title:'交付报告',knowledge_refs:refs,due_at:1000}))
  const manual=ok(await invoke('tasks:create',{kind:'manual',title:'手动收件箱'}))
  const updated=ok(await invoke('tasks:update',{id:task.id,status:'done',planned_at:500,due_at:2000}));assert.deepEqual(JSON.parse(updated.knowledge_refs_json),refs)
  const detail=ok(await invoke('projects:detail',project.id));assert.equal(detail.milestones[0].tasks_done,1);assert.equal(detail.tasks[0].due_at,2000);assert.equal(detail.tasks[0].planned_at,500)
  const all=ok(await invoke('tasks:listAll'));assert.equal(all.find(row=>row.id===task.id).project_title,project.title)
  ok(await invoke('milestones:remove',ms.id));assert.equal(ok(await invoke('projects:detail',project.id)).tasks[0].milestone_id,null)
  ok(await invoke('projects:remove',project.id));assert.equal(getDb().prepare('SELECT id FROM tasks WHERE id=?').get(task.id),undefined)
  assert.ok(getDb().prepare('SELECT id FROM tasks WHERE id=?').get(manual.id));assert.ok(getDb().prepare('SELECT id FROM knowledge_points WHERE id=?').get(concept.id));assert.deepEqual(getDb().pragma('foreign_key_check'),[])
})
test('从迁移19升级项目表时保留旧笔记与标注，失败回滚后可以完整重试',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON')
  for(const migration of MIGRATIONS.filter(row=>row.version<=19))db.exec(migration.sql)
  db.pragma('user_version=19')
  db.exec("INSERT INTO notes(id,title,source,created_at,updated_at) VALUES ('old-note','人工笔记','manual',1,2); INSERT INTO note_segments(id,note_id,sort_order,raw_text,organized_text,created_at,updated_at) VALUES ('old-segment','old-note',0,'原始口述','人工校正',1,2); INSERT INTO annotations VALUES ('old-annotation','old-segment','question',NULL,'保留疑问',3)")
  const migration=MIGRATIONS.find(row=>row.version===20),note=db.prepare('SELECT * FROM notes').get(),segment=db.prepare('SELECT * FROM note_segments').get()
  assert.throws(()=>db.transaction(()=>{db.exec(migration.sql);db.pragma('user_version=20');throw Error('模拟升级中断')})(),/升级中断/)
  assert.equal(db.pragma('user_version',{simple:true}),19);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get(),undefined)
  db.transaction(()=>{db.exec(migration.sql);db.pragma('user_version=20')})()
  assert.deepEqual(db.prepare('SELECT * FROM notes').get(),note);assert.deepEqual(db.prepare('SELECT * FROM note_segments').get(),segment);assert.equal(db.prepare('SELECT comment FROM annotations').get().comment,'保留疑问');assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close()
})
