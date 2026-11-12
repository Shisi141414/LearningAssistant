import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { changeLearningState, initialLearningState, validateLearningState, entryText } from '../shared/learning-document.ts'
import { formulaPreview, learningContent, validateLearningFormulas } from '../shared/learning-formulas.ts'
import { learningFragments } from '../shared/learning-suggestions.ts'

registerAllIpc()
after(() => closeDb())
let sequence = 0
const id = () => `formula-test-${++sequence}`
const base = { version_id: 'version', expected_revision_id: 'revision' }
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
function fixture() {
  const sources = ['前😀 F=ma；后 v=at。', '另一段文字。'].map((raw_text, ordinal) => ({ id: id(), ordinal, raw_text, heading: '', locator_json: '{"kind":"pdf","page":1}', extraction: 'ocr' }))
  return { sources, state: initialLearningState(sources, id) }
}
const formula = { range: [4, 8], latex: 'F=ma', display: false }

test('公式和文本节点由来源生成，保留前后文字、emoji 与跨来源分隔', () => {
  const { sources, state } = fixture(), text = sources[0].raw_text
  assert.deepEqual(learningContent(text), [{ type: 'text', text }])
  const nodes = learningContent(text, [formula])
  assert.equal(nodes[0].text, '前😀 '); assert.equal(nodes[1].source_text, 'F=ma')
  assert.equal(nodes.map(node => node.type === 'text' ? node.text : node.source_text).join(''), text)
  const merged = changeLearningState(state, sources, { ...base, action: 'merge', entry_id: state.entries[1].id }, id)
  const joined = entryText(merged.entries[0], new Map(sources.map(source => [source.id, source])))
  assert.equal(joined, sources.map(source => source.raw_text).join('\n'))
  assert.equal(learningContent(joined, [formula]).at(-1).text, joined.slice(8))
})

test('拒绝公式字段伪造、越界、重叠、乱序、空白范围、字符截断和数量上限', () => {
  const { sources } = fixture(), text = sources[0].raw_text
  validateLearningFormulas(undefined, text)
  for (const invalid of [null, {}, [null], [{ ...formula, extra: '伪造' }], [{ ...formula, range: [4, 100] }], [{ ...formula, range: [4, 4] }], [{ ...formula, range: [2, 4] }], [{ ...formula, range: [3, 4] }], [{ ...formula, range: [4.5, 8] }], [{ ...formula, display: 'yes' }], [{ ...formula, latex: ' ' }], [{ ...formula, latex: 'a'.repeat(2001) }], [formula, { ...formula, range: [7, 9] }], [{ ...formula, range: [9, 10] }, formula], Array.from({ length: 21 }, () => formula)]) assert.throws(() => validateLearningFormulas(invalid, text))
})

test('KaTeX 复用支持力学公式、中文与 MathML，坏公式退回错误而不生成外链或图片', () => {
  const valid = formulaPreview(String.raw`\text{动量定理}\quad F=m\frac{\mathrm{d}v}{\mathrm{d}t}`, true)
  assert.equal(valid.error, ''); assert.match(valid.html, /katex-display/); assert.match(valid.html, /<math/)
  assert.ok(formulaPreview(String.raw`\frac{a}`, false).error)
  assert.ok(formulaPreview('a'.repeat(2001), false).error)
  assert.ok(formulaPreview(String.raw`\def\a{\a}\a`, false).error)
  for (const input of [String.raw`\href{https://example.com}{x}`, String.raw`\includegraphics{https://example.com/a.png}`, String.raw`\htmlClass{test}{x}`]) {
    const result = formulaPreview(input, false)
    assert.doesNotMatch(result.html, /href=|<img|class="test"/)
  }
})

test('保存/精确替换/移除只发布公式表达，来源、章节和证明关系不变', () => {
  const { sources, state } = fixture(), entry = state.entries[0], sourceSnapshot = structuredClone(sources)
  const saved = changeLearningState(state, sources, { ...base, action: 'formula', entry_id: entry.id, formula }, id)
  assert.deepEqual(saved.entries[0].formulas, [formula]); assert.equal(entry.formulas, undefined)
  assert.deepEqual(saved.entries[0].analysis, { method: 'manual', review_status: 'confirmed' })
  const replaced = changeLearningState(saved, sources, { ...base, action: 'formula', entry_id: entry.id, formula: { ...formula, latex: 'F=m a', display: true } }, id)
  assert.equal(replaced.entries[0].formulas.length, 1); assert.equal(replaced.entries[0].formulas[0].display, true)
  const titled = changeLearningState(replaced, sources, { ...base, action: 'edit', entry_id: entry.id, type: 'theorem', title: '动量定理' }, id)
  assert.deepEqual(titled.entries[0].formulas, replaced.entries[0].formulas)
  assert.deepEqual(titled.entries[0].sources, entry.sources); assert.deepEqual(titled.relations, state.relations); assert.deepEqual(sources, sourceSnapshot)
  const removed = changeLearningState(titled, sources, { ...base, action: 'formula-remove', entry_id: entry.id, range: formula.range }, id)
  assert.equal(removed.entries[0].formulas, undefined)
  assert.throws(() => changeLearningState(removed, sources, { ...base, action: 'formula-remove', entry_id: entry.id, range: formula.range }, id), /不存在/)
  assert.throws(() => changeLearningState(saved, sources, { ...base, action: 'formula', entry_id: entry.id, formula: { ...formula, range: [6, 9] } }, id), /重叠/)
  assert.throws(() => changeLearningState(saved, sources, { ...base, action: 'formula', entry_id: entry.id, formula: { ...formula, latex: String.raw`\frac{a}` } }, id), /无法排版/)
})

test('公式校正保护拆分、任一侧合并和 AI 替换，移除后可继续整理', () => {
  const { sources, state } = fixture(), entry = state.entries[0]
  const saved = changeLearningState(state, sources, { ...base, action: 'formula', entry_id: entry.id, formula }, id)
  assert.throws(() => changeLearningState(saved, sources, { ...base, action: 'split', entry_id: entry.id, position: 4 }, id), /公式校正/)
  assert.throws(() => changeLearningState(saved, sources, { ...base, action: 'merge', entry_id: state.entries[1].id }, id), /公式校正/)
  const second = changeLearningState(state, sources, { ...base, action: 'formula', entry_id: state.entries[1].id, formula: { range: [0, 1], latex: 'x', display: false } }, id)
  assert.throws(() => changeLearningState(second, sources, { ...base, action: 'merge', entry_id: state.entries[1].id }, id), /公式校正/)
  saved.entries[0].analysis = { method: 'extracted', review_status: 'unreviewed' }
  assert.throws(() => learningFragments({ state: saved, sources }, [entry.id]), /公式校正/)
  const removed = changeLearningState(saved, sources, { ...base, action: 'formula-remove', entry_id: entry.id, range: formula.range }, id)
  const split = changeLearningState(removed, sources, { ...base, action: 'split', entry_id: entry.id, position: 4 }, id)
  assert.equal(split.entries.length, 3)
})

test('全篇公式数量受限，已存在的来源覆盖与章节规则仍有效', () => {
  const sources = Array.from({ length: 201 }, (_, ordinal) => ({ id: id(), ordinal, raw_text: 'x', heading: '', locator_json: '{}', extraction: 'native' }))
  const state = initialLearningState(sources, id)
  state.entries.forEach(entry => { entry.formulas = [{ range: [0, 1], latex: 'x', display: false }] })
  assert.throws(() => validateLearningState(state, sources), /200 个公式/)
  delete state.entries[200].formulas; validateLearningState(state, sources)
  state.entries[200].parent_id = state.entries[0].id
  assert.throws(() => validateLearningState(state, sources), /章节/)
})

test('严格 IPC 拒绝伪造、陈旧与坏公式；应用重开保留校正和旧证据', async () => {
  const db = getDb(), { sources, state } = fixture(), material = id(), version = id(), document = id(), revision = id()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?,?,0)').run(material, '公式校正回归')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document, version)
  for (const s of sources) db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)').run(s.id, document, s.ordinal, s.raw_text, '', s.locator_json, 'ocr')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
  const concept = ok(await invoke('concepts:save', { name: id(), summary: '', aliases: [], subject_id: null }))
  const evidence = ok(await invoke('evidence:add', { concept_id: concept.id, source: { kind: 'learning', material_id: material, version_id: version, revision_id: revision, entry_id: state.entries[0].id }, role: 'source', memo: '' })).evidence
  const request = { version_id: version, expected_revision_id: revision, entry_id: state.entries[0].id, action: 'formula', formula }
  for (const invalid of [{ ...request, formula: { ...formula, latex: String.raw`\frac{a}` } }, { ...request, formula: { ...formula, range: [2, 5] } }, { ...request, raw_text: '篡改' }, { ...request, formula: { ...formula, source_text: '篡改' } }]) assert.equal((await invoke('learning:change', invalid)).ok, false)
  assert.equal(ok(await invoke('learning:get', { version_id: version })).revision_id, revision)
  const saved = ok(await invoke('learning:change', request))
  assert.equal((await invoke('learning:change', request)).ok, false)
  closeDb()
  const resumed = ok(await invoke('learning:get', { version_id: version }))
  assert.deepEqual(resumed.state.entries[0].formulas, [formula]); assert.deepEqual(resumed.sources, sources)
  assert.equal(ok(await invoke('learning:get', { version_id: version, revision_id: revision })).state.entries[0].formulas, undefined)
  const pinned = ok(await invoke('evidence:list', { concept_id: concept.id })).items[0]
  assert.equal(pinned.quote, sources[0].raw_text); assert.equal(pinned.quote_sha256, evidence.quote_sha256); assert.equal(pinned.source_status, 'historical')
  assert.equal(saved.revision_id, resumed.revision_id)
})
