import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { changeLearningState, entryText, initialLearningState, validateLearningState } from '../shared/learning-document.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'

registerAllIpc()
after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
const newId = () => `learning-test-${++sequence}`
const source = (id, ordinal, raw_text) => ({ id, ordinal, raw_text, heading: '', locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 }), extraction: 'native' })
const base = { version_id: 'version', expected_revision_id: 'revision' }
test('v8 升级保留 OCR 校正和旧课堂来源，学习文档按需建立', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS.filter(m=>m.version<=8)) db.exec(migration.sql)
  db.exec("INSERT INTO materials(id,title,created_at) VALUES ('m','旧教材',0); INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,created_at) VALUES ('v','m','x.pdf','source.pdf','pdf','h',0); INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES ('b','v',0,'旧块','{}'); INSERT INTO material_ocr_pages(version_id,page,raw_text,corrected_text,confidence,width,height,lines_json,model_json) VALUES ('v',1,'OCR 原文','人工校正',90,100,100,'[]','{}'); INSERT INTO notes(id,title,created_at,updated_at) VALUES ('n','课堂',0,0); INSERT INTO classroom_positions(note_id,block_id,updated_at) VALUES ('n','b',0)")
  db.exec(MIGRATIONS.find(m=>m.version===9).sql)
  assert.equal(db.prepare('SELECT corrected_text FROM material_ocr_pages').get().corrected_text,'人工校正')
  assert.equal(db.prepare('SELECT block_id FROM classroom_positions').get().block_id,'b')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM learning_documents').get().n,0)
  assert.deepEqual(db.pragma('foreign_key_check'),[]); db.close()
})
test('同页语义拆分、跨页合并保留完整来源、字符边界和稳定左 ID', () => {
  const sources = [source('s1', 0, '定理😀。证明开始'), source('s2', 1, '证明继续。')]
  const initial = initialLearningState(sources, newId), leftId = initial.entries[0].id
  const split = changeLearningState(initial, sources, { ...base, action: 'split', entry_id: leftId, position: 5 }, newId)
  assert.equal(split.entries[0].id, leftId)
  assert.equal(entryText(split.entries[0], new Map(sources.map(s => [s.id, s]))), '定理😀。')
  const merged = changeLearningState(split, sources, { ...base, action: 'merge', entry_id: split.entries[2].id }, newId)
  assert.equal(merged.entries[1].sources.length, 2)
  assert.equal(entryText(merged.entries[1], new Map(sources.map(s => [s.id, s]))), '证明开始\n证明继续。')
  assert.throws(() => changeLearningState(initial, sources, { ...base, action: 'split', entry_id: leftId, position: 3 }, newId), /完整字符/)
  assert.equal(initial.entries.length, 2, '不能原地改写旧修订')
})
test('来源覆盖拒绝遗漏、重复、越界、伪造 ID；空白页不注入提示正文', () => {
  const sources = [source('s', 0, '教材原文'), source('blank', 1, '')], state = initialLearningState(sources, newId)
  validateLearningState(state, sources)
  for (const mutate of [
    s => { s.entries.pop() },
    s => { s.entries[0].sources[0].text_range = [1, 4] },
    s => { s.entries[0].sources[0].text_range = [0, 99] },
    s => { s.entries[0].sources.push({ source_id: 's' }) },
    s => { s.entries[0].sources[0].source_id = 'fake' }
  ]) { const bad = structuredClone(state); mutate(bad); assert.throws(() => validateLearningState(bad, sources)) }
  assert.equal(entryText(state.entries[1], new Map(sources.map(s => [s.id, s]))), '')
})
test('证明和解答只接受合适目标，关联条目合并须先解除关系', () => {
  const sources = [source('a', 0, '定理正文'), source('b', 1, '证明正文')]
  let state = initialLearningState(sources, newId)
  state = changeLearningState(state, sources, { ...base, action: 'edit', entry_id: state.entries[0].id, type: 'theorem', title: '定理' }, newId)
  state = changeLearningState(state, sources, { ...base, action: 'edit', entry_id: state.entries[1].id, type: 'proof', title: '证明' }, newId)
  state = changeLearningState(state, sources, { ...base, action: 'relate', entry_id: state.entries[1].id, target_id: state.entries[0].id }, newId)
  assert.equal(state.relations[0].type, 'proves')
  assert.throws(() => changeLearningState(state, sources, { ...base, action: 'merge', entry_id: state.entries[1].id }, newId), /解除/)
  assert.throws(() => changeLearningState(state, sources, { ...base, action: 'edit', entry_id: state.entries[0].id, type: 'definition', title: '' }, newId), /目标或方向/)
  assert.throws(() => changeLearningState(state, sources, { ...base, action: 'relate', entry_id: state.entries[0].id, target_id: state.entries[1].id }, newId), /目标或方向/)
})
test('相同来源拆分后重新合并，不人为插入换行或重复文字', () => {
  const sources = [source('one', 0, '一页定义。另一条证明。')], original = initialLearningState(sources, newId)
  const split = changeLearningState(original, sources, { ...base, action: 'split', entry_id: original.entries[0].id, position: 5 }, newId)
  const merged = changeLearningState(split, sources, { ...base, action: 'merge', entry_id: split.entries[1].id }, newId)
  assert.equal(entryText(merged.entries[0], new Map(sources.map(s => [s.id, s]))), sources[0].raw_text)
  assert.equal(merged.entries[0].id, original.entries[0].id)
})
test('修订持久化、陈旧编辑拒绝、历史只读及 IPC 字段隔离', async () => {
  const db = getDb(), material = newId(), version = newId(), doc = newId(), revision = newId()
  db.prepare('INSERT INTO materials (id,title,created_at) VALUES (?, ?, 0)').run(material, '语义测试')
  db.prepare("INSERT INTO material_versions (id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version, material)
  db.prepare('INSERT INTO learning_documents (id,version_id,created_at) VALUES (?,?,0)').run(doc, version)
  const s = source(newId(), 0, '定义：固定的来源文字。'), state = initialLearningState([s], newId)
  db.prepare('INSERT INTO learning_sources (id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,0,?,?,?,?)').run(s.id, doc, s.raw_text, '', s.locator_json, 'native')
  db.prepare('INSERT INTO learning_revisions (id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, doc, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id = ? WHERE id = ?').run(revision, doc)
  const request = { version_id: version, expected_revision_id: revision, action: 'edit', entry_id: state.entries[0].id, type: 'definition', title: '人工标题' }
  const result = ok(await invoke('learning:change', request))
  assert.notEqual(result.revision_id, revision)
  assert.equal((await invoke('learning:change', request)).ok, false, '旧客户端不能覆盖新修订')
  assert.equal((await invoke('learning:change', { ...request, expected_revision_id: result.revision_id, raw_text: '恶意覆盖来源' })).ok, false)
  const old = ok(await invoke('learning:get', { version_id: version, revision_id: revision }))
  assert.equal(old.state.entries[0].type, 'narrative')
  assert.equal(old.sources[0].raw_text, s.raw_text)
  assert.equal(ok(await invoke('learning:prepare', version)).revision_id, result.revision_id, '重复建立不能重置人工修改')
  closeDb()
  assert.equal(ok(await invoke('learning:get', { version_id: version })).state.entries[0].title, '人工标题')
})
