import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { changeLearningState, initialLearningState, validateLearningState, learningAncestors, availableLearningParents, entryText } from '../shared/learning-document.ts'
import { learningFragments, parseLearningProposal } from '../shared/learning-suggestions.ts'

registerAllIpc()
after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
const id = () => `outline-test-${++sequence}`
const base = { version_id: 'version', expected_revision_id: 'revision' }
function fixture(count = 7) {
  const sources = Array.from({ length: count }, (_, ordinal) => ({ id: id(), ordinal, raw_text: `来源${ordinal}😀正文。`, heading: '', locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 }), extraction: 'native' }))
  return { sources, state: initialLearningState(sources, id) }
}
function tree() {
  const value = fixture(), e = value.state.entries
  e[0].type = 'section'; e[0].title = '第一章'
  e[1].type = 'theorem'; e[1].parent_id = e[0].id
  e[2].type = 'section'; e[2].title = '第一节'; e[2].parent_id = e[0].id
  e[3].type = 'proof'; e[3].parent_id = e[2].id
  e[4].type = 'section'; e[4].title = '第二章'
  e[5].parent_id = e[4].id
  value.state.relations = [{ from: e[3].id, to: e[1].id, type: 'proves', review_status: 'confirmed' }]
  return value
}

test('旧顶层快照兼容，章节路径和可选父节点保持顺序，证明关系不受章节层级限制', () => {
  const old = fixture(); validateLearningState(old.state, old.sources)
  assert.ok(old.state.entries.every(entry => !Object.hasOwn(entry, 'parent_id')))
  const { state, sources } = tree(), e = state.entries
  validateLearningState(state, sources)
  assert.deepEqual(learningAncestors(e[3].id, e).map(item => item.id), [e[0].id, e[2].id])
  assert.deepEqual(availableLearningParents(e, 3).map(item => item.id), [e[0].id, e[2].id])
  assert.deepEqual(availableLearningParents(e, 6).map(item => item.id), [e[4].id])
  assert.deepEqual(availableLearningParents(e, 0), [])
})

test('拒绝缺失父节点、普通父节点、自指/向后循环、非连续子树和超过六层章节', () => {
  const { state, sources } = tree()
  for (const mutate of [
    s => { s.entries[1].parent_id = 'missing' }, s => { s.entries[3].parent_id = s.entries[1].id },
    s => { s.entries[0].parent_id = s.entries[0].id }, s => { s.entries[0].parent_id = s.entries[2].id },
    s => { s.entries[6].parent_id = s.entries[0].id }, s => { s.entries[1].parent_id = 1 }
  ]) { const bad = structuredClone(state); mutate(bad); assert.throws(() => validateLearningState(bad, sources)) }
  const deep = fixture(7)
  deep.state.entries.forEach((entry, index, entries) => { entry.type = 'section'; entry.parent_id = index ? entries[index - 1].id : null })
  assert.throws(() => validateLearningState(deep.state, deep.sources), /六层/)
  deep.state.entries[6].type = 'narrative'; validateLearningState(deep.state, deep.sources)
})

test('连续范围归属保留内部子章节、来源和确认状态，拒绝不完整子树和范围内父节点', () => {
  const { state, sources } = tree(), e = state.entries
  const changed = changeLearningState(state, sources, { ...base, action: 'outline', entry_id: e[4].id, end_entry_id: e[5].id, parent_id: e[0].id }, id)
  assert.equal(changed.entries[4].parent_id, e[0].id)
  assert.equal(changed.entries[5].parent_id, e[4].id)
  assert.deepEqual(changed.entries.map(entry => entry.sources), e.map(entry => entry.sources))
  assert.deepEqual(changed.entries.map(entry => entry.analysis), e.map(entry => entry.analysis))
  assert.deepEqual(changed.relations, state.relations)
  assert.equal(e[4].parent_id, undefined)
  for (const request of [
    { entry_id: e[2].id, end_entry_id: e[2].id, parent_id: null },
    { entry_id: e[4].id, end_entry_id: e[5].id, parent_id: e[4].id },
    { entry_id: e[5].id, end_entry_id: e[1].id, parent_id: null }
  ]) assert.throws(() => changeLearningState(state, sources, { ...base, action: 'outline', ...request }, id))
})

test('拆分继承章节，章节拆分的正文成为子项；合并和改类型不能吞掉子树', () => {
  const { state, sources } = tree(), e = state.entries
  const normal = changeLearningState(state, sources, { ...base, action: 'split', entry_id: e[1].id, position: 2 }, id)
  assert.equal(normal.entries[2].parent_id, e[0].id)
  const section = changeLearningState(state, sources, { ...base, action: 'split', entry_id: e[0].id, position: 2 }, id)
  assert.equal(section.entries[1].parent_id, e[0].id)
  assert.throws(() => changeLearningState(state, sources, { ...base, action: 'edit', entry_id: e[0].id, type: 'narrative', title: '' }, id), /子条目/)
  assert.throws(() => changeLearningState(state, sources, { ...base, action: 'merge', entry_id: e[1].id }, id), /同一父章节/)
  assert.throws(() => changeLearningState(normal, sources, { ...base, action: 'merge', entry_id: normal.entries[2].id }, id), /证明\/解答关联/)
  normal.relations = []
  const merged = changeLearningState(normal, sources, { ...base, action: 'merge', entry_id: normal.entries[2].id }, id)
  assert.equal(merged.entries[1].id, e[1].id)
  assert.equal(entryText(merged.entries[1], new Map(sources.map(source => [source.id, source]))), sources[1].raw_text)
})

test('AI 候选继承同一父章节，拒绝跨父章节或遗失未选中的子项', () => {
  const { state, sources } = tree(), e = state.entries
  state.relations = []
  const document = { state, sources }
  const selected = [e[1].id], fragments = learningFragments(document, selected)
  const output = JSON.stringify({ entries: [{ start: fragments[0].id, end: fragments.at(-1).id, type: 'theorem', title: '候选定理' }], relations: [] })
  const proposal = parseLearningProposal(output, document, selected, fragments, 'local/model', id)
  assert.equal(proposal.entries[0].parent_id, e[0].id)
  assert.throws(() => learningFragments(document, [e[1].id, e[2].id]), /同一父章节/)
  assert.throws(() => learningFragments(document, [e[3].id, e[4].id]), /同一父章节/)
})

test('章节修订持久化，不改旧证据或历史；陈旧和非法请求不发布', async () => {
  const db = getDb(), { state, sources } = fixture(3), material = id(), version = id(), document = id(), revision = id()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?,?,0)').run(material, '章节回归')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document, version)
  for (const s of sources) db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)').run(s.id, document, s.ordinal, s.raw_text, '', s.locator_json, 'native')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
  const concept = ok(await invoke('concepts:save', { name: id(), summary: '', aliases: [], subject_id: null }))
  const evidence = ok(await invoke('evidence:add', { concept_id: concept.id, source: { kind: 'learning', material_id: material, version_id: version, revision_id: revision, entry_id: state.entries[1].id }, role: 'source', memo: '' })).evidence
  let current = ok(await invoke('learning:change', { version_id: version, expected_revision_id: revision, entry_id: state.entries[0].id, action: 'edit', type: 'section', title: '第一章' }))
  const request = { version_id: version, expected_revision_id: current.revision_id, entry_id: state.entries[1].id, action: 'outline', end_entry_id: state.entries[2].id, parent_id: state.entries[0].id }
  current = ok(await invoke('learning:change', request))
  assert.equal((await invoke('learning:change', request)).ok, false)
  assert.equal((await invoke('learning:change', { ...request, expected_revision_id: current.revision_id, parent_id: state.entries[2].id })).ok, false)
  assert.equal((await invoke('learning:change', { ...request, expected_revision_id: current.revision_id, raw_text: '伪造文字' })).ok, false)
  assert.equal(ok(await invoke('learning:get', { version_id: version })).revision_id, current.revision_id)
  assert.equal(ok(await invoke('learning:get', { version_id: version, revision_id: revision })).state.entries[1].parent_id, undefined)
  closeDb()
  assert.equal(ok(await invoke('learning:get', { version_id: version })).state.entries[2].parent_id, state.entries[0].id)
  const pinned = ok(await invoke('evidence:list', { concept_id: concept.id })).items[0]
  assert.equal(pinned.quote_sha256, evidence.quote_sha256); assert.equal(pinned.source.revision_id, revision)
  assert.equal(pinned.source_status, 'historical')
})
