import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { organizeSegment } from '../src/main/services/organizer.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { noteLearningBlock } from '../shared/note-learning.ts'
import { entryText, validateLearningState } from '../shared/learning-document.ts'

registerAllIpc()
after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
const createNote = async () => ok(await invoke('notes:create', { title: '课堂统一格式', source: 'class' }))
const read = async (note_id, revision_id) => ok(await invoke('notes:learningGet', { note_id, ...(revision_id ? { revision_id } : {}) }))
const text = doc => doc.state.entries.map(entry => entryText(entry, new Map(doc.sources.map(source => [source.id, source]))))

test('迁移 16 失败可回滚，再升级保留原文、标注和既有表', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON')
  for (const migration of MIGRATIONS.filter(m => m.version <= 15)) db.exec(migration.sql)
  db.pragma('user_version=15')
  db.exec("INSERT INTO notes(id,title,source,created_at,updated_at) VALUES('n','旧笔记','class',1,1); INSERT INTO note_segments(id,note_id,sort_order,seg_type,raw_text,organized_text,created_at,updated_at) VALUES('s','n',0,'proof','旧原文','旧证明',1,1); INSERT INTO annotations(id,segment_id,kind,comment,created_at) VALUES('a','s','keypoint','重点',1)")
  const note = db.prepare('SELECT * FROM notes').get(), segment = db.prepare('SELECT * FROM note_segments').get(), annotations = db.prepare('SELECT * FROM annotations').all()
  const sql = MIGRATIONS.find(m => m.version === 16).sql
  assert.throws(() => db.transaction(() => { db.exec(sql); throw Error('中断') })(), /中断/)
  assert.equal(db.pragma('user_version', { simple: true }), 15)
  assert.equal(db.prepare("SELECT count(*) AS c FROM pragma_table_info('note_segments') WHERE name='organized_model'").get().c, 0)
  db.transaction(() => { db.exec(sql); db.pragma('user_version=16') })()
  assert.deepEqual(db.prepare('SELECT * FROM notes').get(), note)
  assert.deepEqual(db.prepare('SELECT * FROM note_segments').get(), { ...segment, organized_model: null })
  assert.deepEqual(db.prepare('SELECT * FROM annotations').all(), annotations)
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close()
})

test('同一语义模型保留 Unicode、空整理稿及未知旧模型，不伪造原文', () => {
  const segment = { id: 's', note_id: 'n', seg_type: 'proof', raw_text: '原口述😀\nΔU', organized_text: '', revision: 2, organized_by: 'ai', created_at: 1, updated_at: 2 }
  let id = 0
  const block = noteLearningBlock(segment, () => String(++id))
  validateLearningState(block.state, [block.source])
  assert.equal(block.source.raw_text, '')
  assert.equal(block.origin.raw_text, segment.raw_text)
  assert.equal(block.origin.model, null)
  assert.equal(block.state.entries[0].analysis.method, 'extracted')
  const ai = noteLearningBlock({ ...segment, organized_model: '真实模型' }, () => String(++id))
  assert.deepEqual(ai.state.entries[0].analysis, { method: 'ai', model: '真实模型', review_status: 'unreviewed' })
})

test('段落保存立即生成来源版本；全文修订按需固定，旧修订跨重开保留', async () => {
  const n = await createNote(), s = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '教师原话', organized_text: '初始整理稿', seg_type: 'definition' }))
  const count = () => getDb().prepare('SELECT count(*) AS c FROM note_learning_blocks WHERE segment_id=?').get(s.id).c
  assert.equal(count(), 1)
  const first = await read(n.id)
  assert.deepEqual(text(first), ['初始整理稿'])
  assert.equal((await read(n.id)).revision_id, first.revision_id, '重复阅读不生成新修订')
  const updated = ok(await invoke('notes:updateSegment', { id: s.id, organized_text: '人工修订', seg_type: 'proposition' }))
  assert.equal(updated.revision, 1); assert.equal(count(), 2)
  const second = await read(n.id)
  assert.notEqual(second.revision_id, first.revision_id)
  assert.deepEqual(text(await read(n.id, first.revision_id)), ['初始整理稿'])
  assert.equal(second.origins[second.sources[0].id].raw_text, '教师原话')
  assert.equal(second.state.entries[0].analysis.method, 'manual')
  closeDb()
  assert.deepEqual(text(await read(n.id, first.revision_id)), ['初始整理稿'])
  const other = await createNote()
  assert.equal((await invoke('notes:learningGet', { note_id: other.id, revision_id: first.revision_id })).ok, false)
  assert.equal((await invoke('notes:learningGet', { note_id: n.id, file_path: 'anything' })).ok, false)
  ok(await invoke('notes:removeSegment', s.id))
  assert.deepEqual(text(await read(n.id)), [])
  assert.deepEqual(text(await read(n.id, second.revision_id)), ['人工修订'])
})

test('旧笔记按需转换保留原段落和标注，记录教材锚点快照', async () => {
  const db = getDb(), n = await createNote()
  db.prepare("INSERT INTO materials(id,title,created_at) VALUES('nl-m','教材',1)").run()
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('nl-v','nl-m','书.pdf','pdf','private.pdf','hash','ready',1)").run()
  db.prepare("INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES('nl-b','nl-v',0,'教材内容',?)").run(JSON.stringify({ kind: 'pdf', page: 8 }))
  db.prepare("INSERT INTO note_segments(id,note_id,sort_order,seg_type,raw_text,organized_text,created_at,updated_at) VALUES('nl-old',?,0,'proof','旧原文','旧证明',1,1)").run(n.id)
  db.prepare("INSERT INTO segment_material_refs(segment_id,block_id) VALUES('nl-old','nl-b')").run()
  const before = db.prepare("SELECT * FROM note_segments WHERE id='nl-old'").get()
  const ann = ok(await invoke('annotations:add', { segment_id: 'nl-old', kind: 'question', comment: '待核对' }))
  const doc = await read(n.id), origin = doc.origins[doc.sources[0].id]
  assert.equal(origin.material_ref.id, 'nl-b'); assert.equal(origin.material_ref.locator_json, JSON.stringify({ kind: 'pdf', page: 8 }))
  assert.deepEqual(db.prepare("SELECT * FROM note_segments WHERE id='nl-old'").get(), before)
  assert.equal(db.prepare('SELECT comment FROM annotations WHERE id=?').get(ann.id).comment, '待核对')
})

test('语义来源写入失败与人工段落保存一起回滚，AI 成功保存真实模型及原始转写', async () => {
  const n = await createNote(), s = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '原转写' })), db = getDb()
  db.exec("CREATE TRIGGER reject_note_learning BEFORE INSERT ON note_learning_blocks BEGIN SELECT RAISE(ABORT,'模拟保存失败'); END")
  assert.equal((await invoke('notes:updateSegment', { id: s.id, organized_text: '不应保存' })).ok, false)
  assert.equal(db.prepare('SELECT organized_text FROM note_segments WHERE id=?').get(s.id).organized_text, '原转写')
  db.exec('DROP TRIGGER reject_note_learning')
  const p = ok(await invoke('providers:save', { name: 'note-test', base_url: 'https://example.invalid', api_format: 'anthropic', api_key: 'dummy' }))
  ok(await invoke('models:save', { provider_id: p.id, model_id: 'classroom-model' }))
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: JSON.stringify({ seg_type: 'definition', organized_text: '模型整理稿' }) } }) + '\n\n')
    db.exec("CREATE TRIGGER reject_note_learning BEFORE INSERT ON note_learning_blocks BEGIN SELECT RAISE(ABORT,'模拟保存失败'); END")
    await assert.rejects(organizeSegment(s.id), /模拟保存失败/)
    assert.equal(db.prepare('SELECT organized_text FROM note_segments WHERE id=?').get(s.id).organized_text, '原转写')
    db.exec('DROP TRIGGER reject_note_learning')
    await organizeSegment(s.id)
    const doc = await read(n.id), origin = doc.origins[doc.sources[0].id]
    assert.deepEqual(text(doc), ['模型整理稿']); assert.equal(origin.raw_text, '原转写')
    assert.equal(origin.model, 'classroom-model'); assert.equal(doc.state.entries[0].analysis.method, 'ai')
    assert.equal(doc.state.entries[0].analysis.review_status, 'unreviewed')
  } finally { globalThis.fetch = original; db.exec('DROP TRIGGER IF EXISTS reject_note_learning') }
})
