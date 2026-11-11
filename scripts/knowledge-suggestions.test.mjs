import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { initialLearningState } from '../shared/learning-document.ts'
import { parseKnowledgeCandidates, knowledgePrompt } from '../shared/knowledge-suggestions.ts'
import { recoverKnowledgeSuggestions, stopKnowledgeSuggestions } from '../src/main/services/knowledge-suggestions.ts'
import { assertIdle } from '../src/main/services/work.ts'

registerAllIpc()
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
const id = () => `knowledge-test-${++sequence}`
const text = '能量守恒又称能量守恒定律。隔离系统的总能量保持不变。能量方法用来分析运动。😀'
const candidates = () => [
  { name: '能量守恒', summary: '隔离系统的总能量保持不变。', aliases: ['能量守恒定律'], excerpt: '隔离系统的总能量保持不变。', role: 'definition' },
  { name: '能量方法', summary: '用能量分析运动。', aliases: [], excerpt: '能量方法用来分析运动。', role: 'application' }
]
const newConcept = () => ({ kind: 'new', concept: { name: id(), summary: '人工核对的释义', aliases: [], subject_id: null } })
const adoption = (job, target = newConcept(), index = 0) => ({ suggestion_id: job.id, candidate_index: index, target, role: 'definition', memo: '核对过原文与条件' })
async function noteSource(value = text) {
  const note = ok(await invoke('notes:create', { title: '知识候选原笔记' }))
  const segment = ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: value, organized_text: '另一字段不发送' }))
  return { source: { kind: 'note', note_id: note.id, segment_id: segment.id, field: 'raw_text' }, expected_note_text: value }
}
function learningSource() {
  const db = getDb(), material = id(), version = id(), document = id(), revision = id()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?,?,0)').run(material, '学习候选来源')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document, version)
  const sources = [{ id: id(), ordinal: 0, raw_text: text, heading: '', locator_json: '{"kind":"pdf","page":1}', extraction: 'native' }]
  const state = initialLearningState(sources, id), unit = sources[0]
  db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,0,?,?,?,?)').run(unit.id, document, text, '', unit.locator_json, 'native')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
  return { source: { kind: 'learning', material_id: material, version_id: version, revision_id: revision, entry_id: state.entries[0].id } }
}

test('候选严格校验原文名称、别名、连续摘录、字段和长度，拒绝模型额外字段', () => {
  const valid = JSON.stringify({ candidates: candidates() })
  assert.equal(parseKnowledgeCandidates(valid, text).length, 2)
  assert.equal(parseKnowledgeCandidates('{"candidates":[]}', text).length, 0)
  const prompt = knowledgePrompt(text)
  assert.deepEqual(JSON.parse(prompt[1].content), { text })
  for (const mutate of [
    value => { value.extra = '越权' }, value => { value.candidates[0].quote = '伪造正文' },
    value => { value.candidates[0].name = '不存在的定理' }, value => { value.candidates[0].aliases = ['不存在的别名'] },
    value => { value.candidates[0].excerpt = '隔离系统……不变' }, value => { value.candidates[0].role = 'magic' },
    value => { value.candidates[0].summary = '甲'.repeat(1201) }, value => { value.candidates.push(value.candidates[0]) },
    value => { value.candidates = Array(9).fill(value.candidates[0]) }
  ]) { const value = JSON.parse(valid); mutate(value); assert.throws(() => parseKnowledgeCandidates(JSON.stringify(value), text)) }
  assert.throws(() => parseKnowledgeCandidates('not json', text), /JSON/)
  assert.throws(() => parseKnowledgeCandidates(' '.repeat(32769), text), /过长/)
})

test('v12 升级保留已有概念和证据；新采纳关系受外键保护', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter(m => m.version <= 12)) db.exec(m.sql)
  db.prepare("INSERT INTO knowledge_points(id,name,summary,created_at) VALUES ('old','旧知识','保留人工说明',0)").run()
  db.prepare("INSERT INTO knowledge_evidence(id,concept_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,location,entry_title,created_at) VALUES ('ev','old','{}','lookup','key','source','','不可改原证据','hash','来源','位置','',0)").run()
  db.exec(MIGRATIONS.find(m => m.version === 13).sql)
  assert.equal(db.prepare('SELECT quote FROM knowledge_evidence').get().quote, '不可改原证据')
  assert.equal(db.prepare('SELECT summary FROM knowledge_points').get().summary, '保留人工说明')
  assert.equal(db.prepare('SELECT count(*) AS n FROM knowledge_suggestions').get().n, 0)
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close()
})

let mode = 'valid', requests = 0, lastBody
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  requests++; lastBody = JSON.parse(body)
  if (mode === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'local-knowledge-key rejected' } })); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
  const value = candidates()
  if (mode === 'hallucination') value[0].excerpt = '编造引用'
  const output = mode === 'hold' ? '{' : mode === 'long' ? '甲'.repeat(40000) : JSON.stringify({ candidates: value })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: output } }] }) + '\n\n')
  if (mode !== 'hold') res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const provider = ok(await invoke('providers:save', { name: '本地知识模拟', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_format: 'openai', api_key: 'local-knowledge-key', enabled: true }))
const model = ok(await invoke('models:save', { provider_id: provider.id, model_id: 'local-knowledge-model' }))
async function waitJob(job, status) {
  const end = Date.now() + 8000
  let result
  do { result = ok(await invoke('knowledge:suggestGet', job.id)); if (result.status === status) return result; await new Promise(resolve => setTimeout(resolve, 10)) } while (Date.now() < end)
  assert.fail(JSON.stringify(result))
}
const start = async input => ok(await invoke('knowledge:suggestStart', { ...input, model_db_id: model.id }))

test('仅发送选择的已保存字段，生成不入库；逐条确认新建或引用已有知识并幂等保存', async () => {
  mode = 'valid'; const input = await noteSource(), before = getDb().prepare('SELECT count(*) AS n FROM knowledge_points').get().n
  const existing = ok(await invoke('concepts:save', { name: id(), summary: '人工内容不能改', aliases: ['旧别名'], subject_id: null }))
  const job = await start(input), ready = await waitJob(job, 'ready')
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM knowledge_points').get().n, before + 1)
  assert.deepEqual(JSON.parse(lastBody.messages[1].content), { text })
  assert.ok(!JSON.stringify(lastBody).includes('另一字段不发送')); assert.ok(!JSON.stringify(lastBody).includes(existing.name))
  assert.ok(!JSON.stringify(ready).includes('local-knowledge-key'))
  const firstInput = adoption(job), first = ok(await invoke('knowledge:suggestAdopt', firstInput))
  assert.equal(first.status, 'ready'); assert.equal(first.adoptions.length, 1)
  const evidence = ok(await invoke('evidence:list', { concept_id: first.adoptions[0].concept_id })).items[0]
  assert.equal(evidence.quote, text); assert.notEqual(evidence.quote, candidates()[0].excerpt)
  assert.deepEqual(ok(await invoke('knowledge:suggestAdopt', firstInput)).adoptions, first.adoptions)
  assert.equal((await invoke('knowledge:suggestAdopt', adoption(job, { kind: 'existing', concept_id: existing.id, expected_revision: 100 }, 1))).ok, false)
  const done = ok(await invoke('knowledge:suggestAdopt', adoption(job, { kind: 'existing', concept_id: existing.id, expected_revision: existing.revision }, 1)))
  assert.equal(done.status, 'applied')
  const unchanged = ok(await invoke('concepts:list')).find(c => c.id === existing.id)
  assert.equal(unchanged.summary, existing.summary); assert.deepEqual(unchanged.aliases, existing.aliases)
  ok(await invoke('evidence:remove', evidence.id))
  const retried = ok(await invoke('knowledge:suggestAdopt', firstInput))
  assert.equal(retried.adoptions[0].evidence_id, null)
  assert.equal(ok(await invoke('evidence:list', { concept_id: first.adoptions[0].concept_id })).total, 0)
  assert.equal((await invoke('knowledge:suggestAdopt', { ...firstInput, candidate_index: -1 })).ok, false)
  assert.equal((await invoke('knowledge:suggestAdopt', { ...firstInput, quote: '注入正文' })).ok, false)
})

test('新建失败整体回滚；放弃剩余候选保留已采纳结果', async () => {
  const input = await noteSource(), job = await start(input); await waitJob(job, 'ready')
  const before = getDb().prepare('SELECT count(*) AS n FROM knowledge_points').get().n
  const badTarget = newConcept(); badTarget.concept.subject_id = '不存在的学科'
  assert.equal((await invoke('knowledge:suggestAdopt', adoption(job, badTarget))).ok, false)
  assert.equal(getDb().prepare('SELECT count(*) AS n FROM knowledge_points').get().n, before)
  assert.equal(ok(await invoke('knowledge:suggestGet', job.id)).adoptions.length, 0)
  const saved = ok(await invoke('knowledge:suggestAdopt', adoption(job)))
  ok(await invoke('knowledge:suggestDismiss', job.id))
  assert.equal((await invoke('knowledge:suggestAdopt', adoption(job, newConcept(), 1))).ok, false)
  assert.equal(ok(await invoke('knowledge:suggestGet', job.id)).adoptions[0].evidence_id, saved.adoptions[0].evidence_id)
})

test('笔记草稿不发送，变化或删除后禁止旧候选采纳，快照仍可核对', async () => {
  const input = await noteSource()
  assert.equal((await invoke('knowledge:suggestStart', { ...input, expected_note_text: '未保存文字', model_db_id: model.id })).ok, false)
  const job = await start(input); await waitJob(job, 'ready')
  ok(await invoke('notes:updateSegment', { id: input.source.segment_id, raw_text: text + '课后修改' }))
  assert.equal((await invoke('knowledge:suggestAdopt', adoption(job))).ok, false)
  assert.equal(ok(await invoke('knowledge:suggestGet', job.id)).quote, text)
  ok(await invoke('notes:remove', input.source.note_id))
  assert.equal((await invoke('knowledge:suggestAdopt', adoption(job))).ok, false)
  assert.equal(ok(await invoke('knowledge:suggestGet', job.id)).candidates.length, 2)
  const long = await noteSource('甲'.repeat(12001))
  assert.equal((await invoke('knowledge:suggestStart', { ...long, model_db_id: model.id })).ok, false)
  assert.equal((await invoke('knowledge:suggestStart', { ...input, model_db_id: model.id, quote: '伪造正文' })).ok, false)
})

test('学习文档更新后候选仍固定原修订，采纳不改当前条目；关闭数据库后候选及证据保留', async () => {
  const input = learningSource(), job = await start(input); await waitJob(job, 'ready')
  const changed = ok(await invoke('learning:change', { version_id: input.source.version_id, expected_revision_id: input.source.revision_id, entry_id: input.source.entry_id, action: 'edit', type: 'theorem', title: '更新后的条目' }))
  const adopted = ok(await invoke('knowledge:suggestAdopt', adoption(job)))
  const evidence = ok(await invoke('evidence:list', { concept_id: adopted.adoptions[0].concept_id })).items[0]
  assert.equal(evidence.source.revision_id, input.source.revision_id); assert.equal(evidence.source_status, 'historical')
  assert.equal(ok(await invoke('learning:get', { version_id: input.source.version_id })).revision_id, changed.revision_id)
  closeDb()
  assert.equal(ok(await invoke('knowledge:suggestGet', job.id)).adoptions.length, 1)
  assert.equal(ok(await invoke('evidence:list', { concept_id: evidence.concept_id })).items[0].quote, text)
})

test('坏输出、失败与输出上限不入库，取消释放迁移保护；重启不补发请求', async () => {
  const input = await noteSource()
  for (const nextMode of ['hallucination', 'fail', 'long']) {
    mode = nextMode; const job = await start(input), failed = await waitJob(job, 'failed')
    assert.equal(failed.candidates, null); assert.ok(!failed.error.includes('local-knowledge-key'))
    assert.equal(failed.adoptions.length, 0)
  }
  mode = 'hold'; const before = requests, job = await start(input)
  while (requests === before) await new Promise(resolve => setTimeout(resolve, 10))
  assert.throws(() => assertIdle(), /知识候选/)
  assert.equal((await invoke('knowledge:suggestStart', { ...input, model_db_id: model.id })).ok, false)
  ok(await invoke('knowledge:suggestCancel', job.id)); await waitJob(job, 'cancelled')
  await new Promise(resolve => setTimeout(resolve, 60)); assert.doesNotThrow(() => assertIdle())
  getDb().prepare("UPDATE knowledge_suggestions SET status='running' WHERE id=?").run(job.id)
  const count = requests; recoverKnowledgeSuggestions(); assert.equal(requests, count)
  assert.match(ok(await invoke('knowledge:suggestGet', job.id)).error, /未自动发送/)
  assert.ok(ok(await invoke('knowledge:suggestList', input.source)).length <= 20)
  mode = 'valid'
})

after(async () => { stopKnowledgeSuggestions(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDb() })
