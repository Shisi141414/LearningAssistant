import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { createConceptMatcher } from '../shared/concept-matcher.ts'

registerAllIpc()
after(closeDb)
const ok = r => { assert.equal(r.ok, true, r.error); return r.data }
const concept = (id, name, aliases = [], subject_id = null) => ({ id, name, aliases, subject_id })

test('别名匹配保留 UTF-16 原文位置、处理全角/大小写/英文边界和最长名称', () => {
  const match = createConceptMatcher([concept('a', '热力学第一定律', ['能量守恒定律']), concept('b', '第一定律'), concept('c', 'Fourier method', ['heat'])])
  const text = '😀由能量守恒定律与热力学第一定律，使用ＦＯＵＲＩＥＲ method；heat heater wheat。'
  const result = match(text)
  assert.deepEqual(result.map(m => m.concept_ids[0]), ['a', 'a', 'c', 'c'])
  assert.equal(result[0].start, 3)
  for (const m of result) assert.equal(text.slice(m.start, m.end), m.text)
  assert.equal(match('热力学第一定律').length, 1)
})

test('同名不合并；学科消歧，通用词与未知学科保持候选', () => {
  const points = [concept('a', '欧拉定理', [], 'math'), concept('b', '欧拉定理', [], 'mechanics')]
  assert.deepEqual(createConceptMatcher(points)('欧拉定理')[0].concept_ids, ['a', 'b'])
  assert.equal(createConceptMatcher(points)('欧拉定理')[0].status, 'ambiguous')
  assert.deepEqual(createConceptMatcher(points, 'math')('欧拉定理')[0].concept_ids, ['a'])
  assert.equal(createConceptMatcher([...points, concept('c', '欧拉定理')], 'math')('欧拉定理')[0].status, 'ambiguous')
  assert.deepEqual(createConceptMatcher(points, 'unrelated')('欧拉定理'), [])
})

test('真实迁移 v6→v7 保留概念、原文和课堂引用；失败回滚不留下半次升级', () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'learning-assistant-upgrade-')), 'test.db'))
  try {
    db.pragma('foreign_keys=ON')
    for (const migration of MIGRATIONS.filter(m => m.version <= 6)) db.exec(migration.sql)
    db.prepare("INSERT INTO knowledge_points (id,name,created_at) VALUES ('legacy','旧概念',1)").run()
    db.prepare("INSERT INTO notes (id,title,created_at,updated_at) VALUES ('n','课堂',1,1)").run()
    db.prepare("INSERT INTO note_segments (id,note_id,sort_order,raw_text,created_at,updated_at) VALUES ('s','n',0,'原始转写',1,1)").run()
    db.prepare("INSERT INTO materials (id,title,created_at) VALUES ('m','材料',1)").run()
    db.prepare("INSERT INTO material_versions (id,material_id,file_name,file_path,format,fingerprint,created_at) VALUES ('v','m','x.pdf','materials/v/source.pdf','pdf','hash',1)").run()
    db.prepare("INSERT INTO material_blocks (id,version_id,ordinal,text,locator_json) VALUES ('b','v',0,'教材原文','{}')").run()
    db.prepare("INSERT INTO segment_material_refs VALUES ('s','b')").run()
    const sql = MIGRATIONS.find(m => m.version === 7).sql
    assert.throws(db.transaction(() => db.exec(sql + '; INVALID STATEMENT;')))
    assert.equal(db.prepare("SELECT count(*) n FROM pragma_table_info('knowledge_points') WHERE name='revision'").get().n, 0)
    db.transaction(() => db.exec(sql))()
    assert.equal(db.prepare("SELECT revision FROM knowledge_points WHERE id='legacy'").get().revision, 0)
    assert.equal(db.prepare("SELECT raw_text FROM note_segments WHERE id='s'").get().raw_text, '原始转写')
    assert.equal(db.prepare("SELECT block_id FROM segment_material_refs WHERE segment_id='s'").get().block_id, 'b')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally { db.close() }
})

test('IPC 保存别名去重、陈旧修订拒绝、失败原子回滚及重启保留', async () => {
  const input = { name: '能量守恒', aliases: ['First Law', 'ＦＩＲＳＴ LAW', '能量守恒'], summary: '测试释义', subject_id: null }
  const saved = ok(await invoke('concepts:save', input))
  assert.deepEqual(saved.aliases, ['First Law'])
  assert.equal((await invoke('concepts:save', { ...input, aliases: ['', 'bad'] })).ok, false)
  assert.equal((await invoke('concepts:save', { ...input, unexpected: 'bad' })).ok, false)
  assert.equal((await invoke('concepts:save', { ...input, subject_id: 'missing' })).ok, false)
  const next = ok(await invoke('concepts:save', { ...input, id: saved.id, revision: saved.revision, aliases: ['第一定律'] }))
  assert.equal(next.revision, 1)
  assert.equal((await invoke('concepts:save', { ...input, id: saved.id, revision: 0 })).ok, false)
  closeDb()
  assert.deepEqual(ok(await invoke('concepts:list')).find(c => c.id === saved.id).aliases, ['第一定律'])
})

test('旧材料和笔记无需改写即可回链；变更别名/正文即时生效，歧义不会成为已确认引用', async () => {
  const point = ok(await invoke('concepts:save', { name: '热力学第一定律', aliases: ['能量守恒定律'], summary: '', subject_id: null }))
  const note = ok(await invoke('notes:create', { title: '来源测试' }))
  const segment = ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '由能量守恒定律得结论。', organized_text: '应用热力学第一定律。' }))
  const db = getDb()
  db.prepare("INSERT INTO materials (id,title,created_at) VALUES ('mat','教材',1)").run()
  db.prepare("INSERT INTO material_versions (id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES ('ver','mat','x.pdf','materials/ver/source.pdf','pdf','hash','ready',1)").run()
  db.prepare("INSERT INTO material_blocks (id,version_id,ordinal,text,locator_json) VALUES ('block','ver',0,'证明中提到能量守恒定律。','{\"kind\":\"pdf\",\"page\":1}')").run()
  const refs = ok(await invoke('concepts:references', { id: point.id }))
  assert.equal(refs.items.filter(r => r.id === segment.id).length, 2)
  assert.equal(refs.items.find(r => r.id === 'block').parent_id, 'ver')
  ok(await invoke('concepts:save', { id: point.id, revision: point.revision, name: point.name, aliases: [], summary: '', subject_id: null }))
  const next = ok(await invoke('concepts:references', { id: point.id }))
  assert.equal(next.items.some(r => r.id === 'block'), false)
  assert.equal(next.items.find(r => r.id === segment.id).field, 'organized_text')
  ok(await invoke('concepts:save', { name: '另一个概念', aliases: [point.name], summary: '', subject_id: null }))
  assert.equal(ok(await invoke('concepts:references', { id: point.id })).items.length, 0)
  assert.equal(db.prepare('SELECT raw_text FROM note_segments WHERE id=?').get(segment.id).raw_text, '由能量守恒定律得结论。')
})

test('反向查找显式分页，匹配在第 301 个块仍可找到', async () => {
  const point = ok(await invoke('concepts:save', { name: '稀有概念', aliases: [], summary: '', subject_id: null }))
  const db = getDb()
  const note = ok(await invoke('notes:create', { title: '分页测试' }))
  const insert = db.prepare('INSERT INTO note_segments (id,note_id,sort_order,raw_text,created_at,updated_at) VALUES (?,?,?,?,1,1)')
  db.transaction(() => { for (let i=0; i<305; i++) insert.run(`z-${String(i).padStart(4,'0')}`, note.id, i, i === 304 ? '稀有概念' : '无匹配正文') })()
  let offset, found = false, scanned = 0
  do {
    const page = ok(await invoke('concepts:references', { id: point.id, ...(offset === undefined ? {} : { offset }) }))
    found ||= page.items.length > 0; scanned += page.scanned; offset = page.next_offset
  } while (offset !== null)
  assert.equal(found, true); assert.ok(scanned >= 305)
  assert.equal((await invoke('concepts:references', { id: point.id, offset: -1 })).ok, false)
})
