import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { noteLearningBlock } from '../shared/note-learning.ts'
import { reconcileNoteLearning } from '../shared/note-learning-sync.ts'
import { changeLearningState, entryText, validateLearningState } from '../shared/learning-document.ts'

registerAllIpc(); after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
const read = async note_id => ok(await invoke('notes:learningGet', { note_id }))
const edit = async (doc, index, operation) => ok(await invoke('notes:learningChange', { note_id: doc.note_id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[index].id, ...operation }))
const texts = doc => doc.state.entries.map(entry => entryText(entry, new Map(doc.sources.map(source => [source.id, source]))))
async function fixture() {
  const note = ok(await invoke('notes:create', { title: '动量定理', source: 'manual' }))
  const segments = []
  for (const [seg_type, raw_text] of [['other', '第一章 动量'], ['other', 'p=mv'], ['proof', '由牛顿第二定律积分。']]) segments.push(ok(await invoke('notes:addSegment', { note_id: note.id, seg_type, raw_text })))
  let doc = await read(note.id)
  doc = await edit(doc, 0, { action: 'edit', type: 'section', title: '动量章节' })
  doc = await edit(doc, 1, { action: 'edit', type: 'theorem', title: '动量关系' })
  doc = await edit(doc, 1, { action: 'outline', end_entry_id: doc.state.entries[2].id, parent_id: doc.state.entries[0].id })
  doc = await edit(doc, 2, { action: 'relate', target_id: doc.state.entries[1].id })
  doc = await edit(doc, 1, { action: 'formula', formula: { range: [0, 4], latex: 'p = mv', display: true } })
  return { note, segments, doc }
}

test('迁移 17 失败可回滚，旧全文清单/来源保持原样并以 NULL 兼容读取', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter(m => m.version <= 16)) db.exec(m.sql)
  db.pragma('user_version=16')
  db.exec("INSERT INTO notes(id,title,source,created_at,updated_at) VALUES('n','旧笔记','class',1,1); INSERT INTO note_learning_documents(id,note_id,created_at) VALUES('d','n',1); INSERT INTO note_learning_blocks(id,document_id,segment_id,fingerprint,snapshot_json,created_at) VALUES('b','d','s','hash','{}',1); INSERT INTO note_learning_revisions(id,document_id,title,block_ids_json,created_at) VALUES('r','d','旧笔记','[\"b\"]',1)")
  const old = db.prepare('SELECT * FROM note_learning_revisions').get(), blocks = db.prepare('SELECT * FROM note_learning_blocks').all()
  const sql = MIGRATIONS.find(m => m.version === 17).sql
  assert.throws(() => db.transaction(() => { db.exec(sql); throw Error('中断') })(), /中断/)
  assert.equal(db.pragma('user_version', { simple: true }), 16)
  assert.deepEqual(db.prepare('SELECT * FROM note_learning_revisions').get(), old)
  db.transaction(() => { db.exec(sql); db.pragma('user_version=17') })()
  assert.deepEqual(db.prepare('SELECT * FROM note_learning_revisions').get(), { ...old, state_json: null })
  assert.deepEqual(db.prepare('SELECT * FROM note_learning_blocks').all(), blocks); assert.deepEqual(db.pragma('foreign_key_check'), []); db.close()
})

test('笔记支持章节/定理/证明/公式；陈旧和非法修改拒绝且旧来源不改写', async () => {
  const { note, segments, doc } = await fixture(), db = getDb()
  validateLearningState(doc.state, doc.sources)
  assert.equal(doc.state.relations[0].to, doc.state.entries[1].id)
  const count = db.prepare('SELECT count(*) AS c FROM note_learning_revisions').get().c
  const base = { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[1].id }
  for (const operation of [{ action: 'split', position: 0 }, { action: 'outline', parent_id: doc.state.entries[1].id, end_entry_id: doc.state.entries[2].id }, { action: 'figure', figure: { asset_id: 'fake', caption: '' } }, { action: 'edit', type: 'theorem', title: 'bad', raw_text: 'forged' }]) assert.equal((await invoke('notes:learningChange', { ...base, ...operation })).ok, false)
  assert.equal((await invoke('notes:learningChange', { ...base, expected_revision_id: 'stale', action: 'edit', type: 'note', title: '' })).ok, false)
  assert.equal(db.prepare('SELECT count(*) AS c FROM note_learning_revisions').get().c, count)
  const before = db.prepare('SELECT * FROM note_segments WHERE id=?').get(segments[1].id)
  const split = await edit(doc, 2, { action: 'split', position: 3 })
  assert.equal(split.state.entries.length, 4)
  const merged = await edit(split, 3, { action: 'merge' }).catch(error => error)
  assert.ok(merged instanceof Error, '有关联的证明不能直接合并')
  let unlinked = await edit(split, 2, { action: 'relate', target_id: null })
  unlinked = await edit(unlinked, 3, { action: 'merge' })
  assert.deepEqual(texts(unlinked), texts(doc)); assert.deepEqual(db.prepare('SELECT * FROM note_segments WHERE id=?').get(segments[1].id), before)
  const old = ok(await invoke('notes:learningGet', { note_id: note.id, revision_id: doc.revision_id }))
  assert.deepEqual(old.state, doc.state)
})

test('追加、标题变化与仅原转写变化自动同步，人工结构和公式及归属保持', async () => {
  const { note, segments, doc } = await fixture()
  ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '下一段：能量关系' }))
  ok(await invoke('notes:update', { id: note.id, title: '修改标题' }))
  ok(await invoke('notes:updateSegment', { id: segments[1].id, raw_text: '原口述更正，整理稿未改' }))
  const next = await read(note.id)
  assert.equal(next.pending_sync, undefined); assert.equal(next.title, '修改标题'); assert.equal(next.state.entries.length, 4)
  assert.equal(next.state.entries[1].id, doc.state.entries[1].id)
  assert.deepEqual(next.state.entries[1].formulas, doc.state.entries[1].formulas)
  assert.deepEqual(next.state.relations, doc.state.relations)
  assert.equal(next.state.entries[3].parent_id, doc.state.entries[0].id)
  assert.equal(next.origins[next.sources[1].id].raw_text, '原口述更正，整理稿未改')
})

test('正文变化先预览，保留未受影响条目；双版本检查拒绝预览后的新变化', async () => {
  const { note, segments, doc } = await fixture()
  ok(await invoke('notes:updateSegment', { id: segments[1].id, organized_text: '新的动量公式说明' }))
  const pending = await read(note.id)
  assert.equal(pending.revision_id, doc.revision_id); assert.ok(pending.pending_sync)
  assert.deepEqual(pending.state, doc.state)
  assert.equal((await invoke('notes:learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[2].id, action: 'edit', type: 'proof', title: '应先同步' })).ok, false)
  const first = ok(await invoke('notes:learningPreview', note.id))
  assert.equal(first.summary.removed_relations, 1); assert.equal(first.summary.retained_entries, 2)
  assert.equal(first.summary.removed_formulas, 1)
  assert.equal(first.state.entries[1].formulas, undefined)
  assert.deepEqual(first.state.entries[2], doc.state.entries[2], '未变化证明保留自身结构，但旧归属显式解除')
  ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '预览后又来一段' }))
  assert.equal((await invoke('notes:learningSync', { note_id: note.id, expected_revision_id: first.base_revision_id, fingerprint: first.fingerprint })).ok, false)
  const fresh = ok(await invoke('notes:learningPreview', note.id)), before = (await read(note.id)).revision_id
  assert.equal(before, doc.revision_id)
  const synced = ok(await invoke('notes:learningSync', { note_id: note.id, expected_revision_id: fresh.base_revision_id, fingerprint: fresh.fingerprint }))
  assert.deepEqual(synced.state, fresh.state, '确认发布和预览使用相同条目 ID 与语义内容')
  assert.equal(synced.pending_sync, undefined); assert.equal(synced.state.relations.length, 0)
  assert.deepEqual(texts(synced), ['第一章 动量', '新的动量公式说明', '由牛顿第二定律积分。', '预览后又来一段'])
  assert.deepEqual((ok(await invoke('notes:learningGet', { note_id: note.id, revision_id: doc.revision_id }))).state, doc.state)
  closeDb(); assert.deepEqual((await read(note.id)).state, synced.state)
})

test('删除章节需明确核对父节点变化；语义写入失败保持原修订，确认失败可重试', async () => {
  const { note, segments, doc } = await fixture(), db = getDb()
  db.exec("CREATE TRIGGER reject_note_semantics BEFORE INSERT ON note_learning_revisions BEGIN SELECT RAISE(ABORT,'模拟修订失败'); END")
  assert.equal((await invoke('notes:learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[1].id, action: 'edit', type: 'theorem', title: '不可保存' })).ok, false)
  assert.deepEqual((await read(note.id)).state, doc.state)
  db.exec('DROP TRIGGER reject_note_semantics')
  ok(await invoke('notes:removeSegment', segments[0].id))
  const pending = await read(note.id), preview = ok(await invoke('notes:learningPreview', note.id))
  assert.equal(pending.revision_id, doc.revision_id); assert.equal(preview.summary.reparented_entries, 2)
  assert.equal(preview.state.entries[0].title, '动量关系'); assert.deepEqual(preview.state.entries[0].formulas, doc.state.entries[1].formulas)
  db.exec("CREATE TRIGGER reject_note_semantics BEFORE INSERT ON note_learning_revisions BEGIN SELECT RAISE(ABORT,'模拟修订失败'); END")
  const input = { note_id: note.id, expected_revision_id: preview.base_revision_id, fingerprint: preview.fingerprint }
  assert.equal((await invoke('notes:learningSync', input)).ok, false)
  assert.equal((await read(note.id)).revision_id, doc.revision_id)
  db.exec('DROP TRIGGER reject_note_semantics')
  const result = ok(await invoke('notes:learningSync', input))
  assert.equal(result.state.entries[0].parent_id, null); assert.equal(result.state.relations.length, 1)
})

let seq = 0
const id = () => `sync-${++seq}`
function block(segment, value) { return noteLearningBlock({ id: segment, note_id: 'n', sort_order: 0, seg_type: 'other', raw_text: value, organized_text: value, revision: 0, created_at: 1, updated_at: 1 }, id) }
const sources = blocks => blocks.map((item, ordinal) => ({ ...item.source, ordinal }))
const initial = blocks => ({ entries: blocks.flatMap(item => structuredClone(item.state.entries)), relations: [] })

test('跨段合并后中间插入/移除/重排或共享来源变化，完整重建受影响范围且不错误保留旧关联', () => {
  const old = [block('a', '甲内容'), block('c', '丙内容'), block('proof', '证明尾段')]
  let state = changeLearningState(initial(old), sources(old), { entry_id: old[1].state.entries[0].id, action: 'merge' }, id)
  state = changeLearningState(state, sources(old), { entry_id: state.entries[0].id, action: 'edit', type: 'theorem', title: '合并定理' }, id)
  state = changeLearningState(state, sources(old), { entry_id: state.entries[1].id, action: 'edit', type: 'proof', title: '证明' }, id)
  state = changeLearningState(state, sources(old), { entry_id: state.entries[1].id, action: 'relate', target_id: state.entries[0].id }, id)
  for (const next of [[old[0], block('b', '乙插入'), old[1], old[2]], [old[1], old[0], old[2]], [old[0], old[2]]]) {
    const result = reconcileNoteLearning(state, old, next, id)
    assert.ok(result.summary.requires_review); validateLearningState(result.state, sources(next))
    assert.equal(result.state.relations.length, 0)
    assert.ok(!result.state.entries.some(entry => entry.id === state.entries[0].id), '重建不得冒用旧定理 ID')
    assert.equal(result.state.entries.at(-1).id, state.entries.at(-1).id)
  }
  const split = changeLearningState(initial(old), sources(old), { entry_id: old[0].state.entries[0].id, action: 'split', position: 1 }, id)
  const interleaved = reconcileNoteLearning(state, old, [old[0], old[2], old[1]], id)
  validateLearningState(interleaved.state, sources([old[0], old[2], old[1]]))
  assert.equal(interleaved.state.relations.length, 0)
  assert.ok(interleaved.state.entries.some(entry => entry.id === state.entries.at(-1).id), '移到中间的未变化证明仍保留自身 ID')
  const reset = reconcileNoteLearning(split, old, [block('a', '全新甲内容'), old[1], old[2]], id)
  assert.equal(reset.summary.affected_entry_ids.length, 2); assert.equal(reset.summary.requires_review, true)
})

test('随机拆分/合并与来源插入、更新、删除、重排后，覆盖始终完整且旧状态不变', () => {
  let seed = 20261112
  const rand = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
  for (let run = 0; run < 160; run++) {
    const old = Array.from({ length: 3 + rand(6) }, (_, index) => block(String(index), `段落${index}😀正文。`))
    let state = initial(old)
    for (let step = 0; step < 5; step++) {
      const index = rand(state.entries.length), entry = state.entries[index], value = entryText(entry, new Map(sources(old).map(source => [source.id, source])))
      try { state = changeLearningState(state, sources(old), rand(2) && index ? { entry_id: entry.id, action: 'merge' } : { entry_id: entry.id, action: 'split', position: 1 + rand(value.length - 1) }, id) } catch { /* 拒绝代理对中间切分属于预期。 */ }
    }
    const before = structuredClone(state)
    let next = old.filter(() => rand(4) > 0).map(item => rand(4) ? item : block(item.origin.segment_id, '替换内容'))
    if (rand(2)) next.splice(rand(next.length + 1), 0, block('added', '新增'))
    if (rand(2)) next.reverse()
    if (rand(2)) for (let index = next.length - 1; index > 0; index--) { const to = rand(index + 1); [next[index], next[to]] = [next[to], next[index]] }
    const result = reconcileNoteLearning(state, old, next, id)
    if (next.length) validateLearningState(result.state, sources(next))
    else assert.deepEqual(result.state, { entries: [], relations: [] })
    assert.deepEqual(state, before)
  }
})
