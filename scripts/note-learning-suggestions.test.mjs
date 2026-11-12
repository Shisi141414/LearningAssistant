import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { recoverNoteSuggestions, stopNoteSuggestions } from '../src/main/services/note-learning-suggestions.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { entryText } from '../shared/learning-document.ts'

registerAllIpc()
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
const read = note_id => invoke('notes:learningGet', { note_id }).then(ok)
const text = doc => doc.state.entries.map(e => entryText(e, new Map(doc.sources.map(s => [s.id, s]))))
async function fixture() {
  const note = ok(await invoke('notes:create', { title: '笔记 AI 结构', source: 'manual' }))
  const first = ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '仅保留的原始口述😀。', organized_text: '定理：能量守恒。\n证明：由能量平衡可得。' }))
  ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '人工内容禁止发送。' }))
  const base = await read(note.id)
  const doc = ok(await invoke('notes:learningChange', { note_id: note.id, expected_revision_id: base.revision_id, entry_id: base.state.entries[1].id, action: 'edit', type: 'definition', title: '人工保留' }))
  return { doc, first }
}
let mode = 'valid', requests = 0, lastBody
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  requests++; lastBody = JSON.parse(body)
  if (mode === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'note-test-key rejected' } })); return }
  const fragments = JSON.parse(lastBody.messages.find(m => m.role === 'user').content)
  const value = { entries: [{ start: fragments[0].id, end: fragments[0].id, type: 'theorem', title: '能量守恒' }, { start: fragments[1].id, end: fragments.at(-1).id, type: 'proof', title: '证明' }], relations: [{ from: 1, to: 0, type: 'proves' }] }
  if (mode === 'missing') { value.entries.pop(); value.relations = [] }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: mode === 'hold' ? '{' : JSON.stringify(value) } }] }) + '\n\n')
  if (mode !== 'hold') res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const provider = ok(await invoke('providers:save', { name: '笔记隔离模拟', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_format: 'openai', api_key: 'note-test-key', enabled: true }))
const model = ok(await invoke('models:save', { provider_id: provider.id, model_id: 'note-structure-model' }))
const input = doc => ({ note_id: doc.note_id, expected_revision_id: doc.revision_id, entry_ids: [doc.state.entries[0].id], model_db_id: model.id })
async function waitJob(job, status) {
  const end = Date.now() + 8000
  do { const value = ok(await invoke('notes:learningSuggestGet', job.id)); if (value.status === status) return value; await new Promise(r => setTimeout(r, 10)) } while (Date.now() < end)
  assert.fail(`任务未达到 ${status}`)
}
test('迁移 18 失败回滚，旧笔记、来源、语义修订和标注不变', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter(m => m.version <= 17)) db.exec(m.sql)
  db.pragma('user_version=17')
  db.exec("INSERT INTO notes(id,title,source,created_at,updated_at) VALUES('n','旧笔记','manual',1,1); INSERT INTO note_segments(id,note_id,sort_order,seg_type,raw_text,organized_text,created_at,updated_at) VALUES('s','n',0,'proof','旧口述','旧证明',1,1); INSERT INTO annotations(id,segment_id,kind,comment,created_at) VALUES('a','s','keypoint','保留',1); INSERT INTO note_learning_documents VALUES('d','n',1); INSERT INTO note_learning_blocks VALUES('b','d','s','hash','{}',1); INSERT INTO note_learning_revisions VALUES('r','d','标题',NULL,'[\"b\"]',1,'{\"entries\":[],\"relations\":[]}')")
  const tables = ['notes', 'note_segments', 'annotations', 'note_learning_documents', 'note_learning_blocks', 'note_learning_revisions']
  const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()), sql = MIGRATIONS.find(m => m.version === 18).sql
  assert.throws(() => db.transaction(() => { db.exec(sql); throw Error('中断') })(), /中断/)
  assert.equal(db.pragma('user_version', { simple: true }), 17)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='note_learning_suggestions'").get().n, 0)
  db.transaction(() => { db.exec(sql); db.pragma('user_version=18') })()
  assert.deepEqual(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()), before)
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close()
})
test('生成只保存候选，发送所选整理稿；采纳保留原文/其他条目并增加固定修订', async () => {
  mode = 'valid'; const { doc, first } = await fixture()
  const job = ok(await invoke('notes:learningSuggestStart', input(doc))), ready = await waitJob(job, 'ready')
  assert.equal((await read(doc.note_id)).revision_id, doc.revision_id)
  assert.equal(JSON.stringify(lastBody).includes('人工内容禁止发送'), false)
  assert.equal(JSON.stringify(lastBody).includes('仅保留的原始口述'), false)
  assert.equal(JSON.stringify(ready).includes('note-test-key'), false)
  const applied = ok(await invoke('notes:learningSuggestApply', job.id))
  assert.equal(applied.state.entries.length, 3); assert.equal(applied.state.relations[0].type, 'proves')
  assert.equal(applied.state.entries[0].analysis.review_status, 'confirmed')
  assert.match(applied.state.entries[0].analysis.model, /note-structure-model/)
  assert.deepEqual(applied.state.entries.at(-1), doc.state.entries[1])
  assert.equal(text(applied).slice(0, 2).join(''), doc.sources[0].raw_text)
  assert.deepEqual(applied.origins, doc.origins)
  assert.deepEqual(ok(await invoke('notes:get', doc.note_id)).segments[0], first)
  assert.deepEqual(ok(await invoke('notes:learningGet', { note_id: doc.note_id, revision_id: doc.revision_id })).state, doc.state)
  assert.equal(ok(await invoke('notes:learningSuggestList', doc.note_id))[0].status, 'applied')
  assert.equal((await invoke('notes:learningSuggestApply', job.id)).ok, false)
  assert.equal((await invoke('notes:learningSuggestStart', input(applied))).ok, false)
})
test('生成后的新增来源与人工编辑都会拒绝旧候选，放弃不改正文', async () => {
  for (const change of ['append', 'edit', 'raw']) {
    mode = 'valid'; const { doc, first } = await fixture()
    const job = ok(await invoke('notes:learningSuggestStart', input(doc))); await waitJob(job, 'ready')
    if (change === 'append') ok(await invoke('notes:addSegment', { note_id: doc.note_id, raw_text: '课堂继续保存。' }))
    else if (change === 'edit') ok(await invoke('notes:learningChange', { note_id: doc.note_id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[1].id, action: 'edit', type: 'definition', title: '新人工标题' }))
    else getDb().prepare('UPDATE note_segments SET raw_text=?,revision=revision+1 WHERE id=?').run('原文已校正', first.id)
    const rejected = await invoke('notes:learningSuggestApply', job.id)
    assert.equal(rejected.ok, false); assert.match(rejected.error, /变化/)
    ok(await invoke('notes:learningSuggestDismiss', job.id))
    const current = await read(doc.note_id)
    assert.equal(current.state.entries.some(e => e.title === '能量守恒'), false)
    assert.equal(ok(await invoke('notes:learningSuggestGet', job.id)).status, 'dismissed')
  }
})
test('坏结构、请求失败、取消及关闭恢复不发布；密钥隐藏且不自动重发', async () => {
  const { doc } = await fixture()
  for (const next of ['missing', 'fail']) {
    mode = next
    const job = ok(await invoke('notes:learningSuggestStart', input(doc))), failed = await waitJob(job, 'failed')
    assert.equal(failed.proposal, null); assert.equal(failed.error.includes('note-test-key'), false)
    assert.equal((await read(doc.note_id)).revision_id, doc.revision_id)
  }
  mode = 'hold'; const before = requests, job = ok(await invoke('notes:learningSuggestStart', input(doc)))
  while (requests === before) await new Promise(r => setTimeout(r, 10))
  assert.equal((await invoke('notes:learningSuggestStart', input(doc))).ok, false)
  ok(await invoke('notes:learningSuggestCancel', job.id)); await waitJob(job, 'cancelled')
  await new Promise(r => setTimeout(r, 60))
  getDb().prepare("UPDATE note_learning_suggestions SET status='running' WHERE id=?").run(job.id)
  const count = requests; recoverNoteSuggestions(); assert.equal(requests, count)
  assert.match(ok(await invoke('notes:learningSuggestGet', job.id)).error, /未自动发送/)
  assert.equal((await read(doc.note_id)).revision_id, doc.revision_id)
})
test('IPC 拒绝注入字段、过长/重复范围、其他笔记的条目与非法操作', async () => {
  mode = 'valid'; const { doc } = await fixture(), other = (await fixture()).doc
  for (const invalid of [{ ...input(doc), proposal: {} }, { ...input(doc), entry_ids: [] }, { ...input(doc), entry_ids: Array(21).fill(doc.state.entries[0].id) }, { ...input(doc), entry_ids: [doc.state.entries[0].id, doc.state.entries[0].id] }, { ...input(doc), entry_ids: [other.state.entries[0].id] }]) assert.equal((await invoke('notes:learningSuggestStart', invalid)).ok, false)
  for (const action of ['Get', 'Cancel', 'Dismiss', 'Apply']) assert.equal((await invoke('notes:learningSuggest' + action, { id: 'invalid' })).ok, false)
  assert.deepEqual(ok(await invoke('notes:learningSuggestList', other.note_id)), [])
})
after(async () => { stopNoteSuggestions(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeDb() })
