import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { recoverLearningSuggestions, stopLearningSuggestions } from '../src/main/services/learning-suggestions.ts'
import { initialLearningState } from '../shared/learning-document.ts'
import { learningFragments, parseLearningProposal } from '../shared/learning-suggestions.ts'

registerAllIpc()
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
const id = () => 'suggest-test-' + ++sequence
function fixture() {
  const db = getDb(), material = id(), version = id(), doc = id(), revision = id()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?, ?, 0)').run(material,'AI 整理隔离材料')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version,material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(doc,version)
  const sources = ['定理😀：能量守恒。\n证明：由系统能量平衡可得。','人工确认的条目禁止发送或改写。'].map((raw_text,ordinal)=>({id:id(),ordinal,raw_text,heading:'',locator_json:'{"kind":"pdf","page":1}',extraction:'native'}))
  const state = initialLearningState(sources,id)
  state.entries[1].type='definition';state.entries[1].title='人工标题';state.entries[1].analysis={method:'manual',review_status:'confirmed'}
  for(const s of sources) db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)').run(s.id,doc,s.ordinal,s.raw_text,s.heading,s.locator_json,s.extraction)
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision,doc,JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision,doc)
  return { id:doc,version_id:version,current_revision_id:revision,revision_id:revision,created_at:0,sources,state,history:[{id:revision,created_at:0}] }
}
const answer = fragments => ({ entries:[{start:fragments[0].id,end:fragments[0].id,type:'theorem',title:'能量定理'},{start:fragments[1].id,end:fragments.at(-1).id,type:'proof',title:'证明'}],relations:[{from:1,to:0,type:'proves'}] })
test('程序片段覆盖 UTF-16 来源，模型只能分类不能改写来源；拒绝漏段/重复/伪造', () => {
  const document=fixture(), ids=[document.state.entries[0].id], fragments=learningFragments(document,ids)
  assert.equal(fragments.map(f=>f.text).join(''),document.sources[0].raw_text)
  const valid=answer(fragments), proposal=parseLearningProposal(JSON.stringify(valid),document,ids,fragments,'local/model',id)
  assert.equal(proposal.entries[0].id,ids[0]);assert.equal(proposal.entries[1].analysis.method,'ai')
  assert.equal(proposal.relations[0].type,'proves')
  for(const mutate of [
    v=>{v.entries.pop();v.relations=[]},
    v=>{v.entries[1].start=fragments[0].id},
    v=>{v.entries[0].end='unknown'},
    v=>{v.entries[0].raw_text='伪造正文'},
    v=>{v.entries[0].type='unknown'},
    v=>{v.relations=[{from:0,to:1,type:'proves'}]}
  ]) {const invalid=structuredClone(valid);mutate(invalid);assert.throws(()=>parseLearningProposal(JSON.stringify(invalid),document,ids,fragments,'local/model',id))}
  assert.throws(()=>learningFragments(document,[document.state.entries[1].id]),/保护/)
  assert.throws(()=>parseLearningProposal('not json',document,ids,fragments,'local/model',id),/JSON/)
})
test('跨来源候选保留来源顺序与字符边界，范围和输出有硬上限', () => {
  const document=fixture()
  document.sources[0].raw_text='甲'.repeat(299)+'😀。'
  document.state.entries[1].analysis={method:'extracted',review_status:'unreviewed'}
  const ids=document.state.entries.map(entry=>entry.id), fragments=learningFragments(document,ids)
  assert.equal(fragments[0].text,'甲'.repeat(299)+'😀')
  const value={entries:[{start:'f1',end:fragments.at(-1).id,type:'narrative',title:'跨来源条目'}],relations:[]}
  const proposal=parseLearningProposal(JSON.stringify(value),document,ids,fragments,'local/model',id)
  assert.deepEqual(proposal.entries[0].sources,document.sources.map(source=>({source_id:source.id,text_range:[0,source.raw_text.length]})))
  assert.throws(()=>learningFragments(document,[...ids].reverse()),/连续/)
  assert.throws(()=>parseLearningProposal(' '.repeat(32769),document,ids,fragments,'local/model',id),/过长/)
  document.sources[0].raw_text='甲'.repeat(12001)
  assert.throws(()=>learningFragments(document,ids),/12000/)
  document.sources[0].raw_text='句。'.repeat(201)
  assert.throws(()=>learningFragments(document,ids),/200/)
  document.sources[0].raw_text=''
  assert.throws(()=>learningFragments(document,ids),/没有可用文字/)
})
let mode='valid', requests=0, lastBody
const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req) body+=chunk
  requests++;lastBody=JSON.parse(body)
  if(mode==='fail'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'local-test-key rejected'}}));return}
  const fragments=JSON.parse(lastBody.messages.find(m=>m.role==='user').content)
  let value=answer(fragments)
  if(mode==='missing'){value.entries.pop();value.relations=[]}
  res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders()
  const text=mode==='hold'?'{':JSON.stringify(value)
  res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:text}}]})+'\n\n')
  if(mode!=='hold')res.end('data: [DONE]\n\n')
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const provider=ok(await invoke('providers:save',{name:'本地隔离模拟',base_url:`http://127.0.0.1:${server.address().port}/v1`,api_format:'openai',api_key:'local-test-key',enabled:true}))
const model=ok(await invoke('models:save',{provider_id:provider.id,model_id:'local-semantic-model'}))
const input=document=>({version_id:document.version_id,expected_revision_id:document.current_revision_id,entry_ids:[document.state.entries[0].id],model_db_id:model.id})
async function waitJob(job,status){const end=Date.now()+8000;let value;do{value=ok(await invoke('learning:suggestGet',job.id));if(value.status===status)return value;await new Promise(r=>setTimeout(r,10))}while(Date.now()<end);assert.fail(JSON.stringify(value))}
test('生成只保存候选；采纳才发布，保护人工内容并保留模型出处',async()=>{
  const document=fixture();mode='valid'
  const job=ok(await invoke('learning:suggestStart',input(document))), ready=await waitJob(job,'ready')
  assert.equal(ok(await invoke('learning:get',{version_id:document.version_id})).current_revision_id,document.current_revision_id)
  assert.equal(JSON.stringify(lastBody).includes(document.sources[1].raw_text),false)
  assert.equal(JSON.stringify(ready).includes('local-test-key'),false)
  const applied=ok(await invoke('learning:suggestApply',job.id))
  assert.notEqual(applied.revision_id,document.revision_id)
  assert.deepEqual(applied.state.entries.at(-1),document.state.entries[1])
  assert.equal(applied.state.entries[0].analysis.review_status,'confirmed')
  assert.match(applied.state.entries[0].analysis.model,/local-semantic-model/)
  assert.equal((await invoke('learning:suggestApply',job.id)).ok,false)
  assert.equal(ok(await invoke('learning:get',{version_id:document.version_id,revision_id:document.revision_id})).state.entries.length,2)
})
test('生成期间的人工修改使旧建议过期，放弃候选不改变文档',async()=>{
  const document=fixture();mode='valid'
  const job=ok(await invoke('learning:suggestStart',input(document)));await waitJob(job,'ready')
  const changed=ok(await invoke('learning:change',{version_id:document.version_id,expected_revision_id:document.revision_id,entry_id:document.state.entries[1].id,action:'edit',type:'definition',title:'期间的新标题'}))
  assert.equal((await invoke('learning:suggestApply',job.id)).ok,false)
  ok(await invoke('learning:suggestDismiss',job.id))
  assert.equal(ok(await invoke('learning:get',{version_id:document.version_id})).current_revision_id,changed.revision_id)
})
test('坏建议、请求失败和取消不发布；密钥不出现在错误中；重启不自动请求',async()=>{
  const document=fixture()
  for(const nextMode of ['missing','fail']){
    mode=nextMode
    const job=ok(await invoke('learning:suggestStart',input(document))), failed=await waitJob(job,'failed')
    assert.equal(failed.proposal,null);assert.equal(failed.error.includes('local-test-key'),false)
    assert.equal(ok(await invoke('learning:get',{version_id:document.version_id})).current_revision_id,document.revision_id)
  }
  mode='hold';const before=requests, job=ok(await invoke('learning:suggestStart',input(document)))
  while(requests===before)await new Promise(r=>setTimeout(r,10))
  ok(await invoke('learning:suggestCancel',job.id));await waitJob(job,'cancelled')
  await new Promise(r=>setTimeout(r,60))
  getDb().prepare("UPDATE learning_suggestions SET status='running' WHERE id=?").run(job.id)
  const count=requests;recoverLearningSuggestions();assert.equal(requests,count)
  assert.match(ok(await invoke('learning:suggestGet',job.id)).error,/未自动发送/)
  assert.equal(ok(await invoke('learning:get',{version_id:document.version_id})).revision_id,document.revision_id)
  assert.equal((await invoke('learning:suggestStart',{...input(document),entry_ids:[document.state.entries[1].id]})).ok,false)
  assert.equal((await invoke('learning:suggestStart',{...input(document),proposal:{entries:[]}})).ok,false)
})
after(async()=>{stopLearningSuggestions();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));closeDb()})
