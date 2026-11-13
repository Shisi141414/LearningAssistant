import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { exerciseTexts } from '../shared/exercises.ts'
import { initialLearningState, validateLearningState } from '../shared/learning-document.ts'
import { learningPdfSnapshot } from '../src/main/services/learning-pdf.ts'
registerAllIpc()
after(() => closeDb())
const ok = (result) => {
  assert.equal(result.ok, true, result.error)
  return result.data
}
const fields = () => ({
  statement: '求 $x^2$ 的导数。😀',
  approach: '使用幂函数求导法则',
  standard_answer: '$2x$',
  user_answer: '$x$',
  error_reason: '漏乘指数，需复习幂函数导数'
})
const input = () => ({
  title: '导数计算',
  subject_id: null,
  status: 'wrong',
  question_type: '计算',
  source_label: '教材 P.10 第 2 题',
  no_idea: false,
  review_concept_ids: [],
  fields: fields()
})
const save = (value) => invoke('exercises:save', value)
let seq = 0
const next = () => `exercise-fixture-${++seq}`
function fixture() {
  const db = getDb(),
    material = next(),
    version = next(),
    document = next(),
    revision = next()
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?, ?, 0)').run(
    material,
    '真实教材格式'
  )
  db.prepare(
    "INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'test.pdf','unused.pdf','pdf','hash','ready',0)"
  ).run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(
    document,
    version
  )
  const sources = ['例题 求 x2 的导数', '解答结果 2x'].map((raw_text, ordinal) => ({
    id: next(),
    ordinal,
    raw_text,
    heading: '',
    locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 }),
    extraction: 'native'
  }))
  const state = initialLearningState(sources, next)
  state.entries[0].type = 'exercise'
  state.entries[0].title = '例题 1'
  state.entries[0].formulas = [{ range: [5, 7], latex: 'x^2', display: false }]
  state.entries[1].type = 'solution'
  state.relations = [
    {
      from: state.entries[1].id,
      to: state.entries[0].id,
      type: 'solves',
      review_status: 'confirmed'
    }
  ]
  const asset = next()
  db.prepare(
    "INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,'image/png','sha','unused.png',1,1,'{\"kind\":\"pdf\",\"page\":1}','题目图',0)"
  ).run(asset, document)
  state.entries[0].figures = [{ asset_id: asset, caption: '图示' }]
  validateLearningState(state, sources)
  for (const s of sources)
    db.prepare(
      'INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)'
    ).run(s.id, document, s.ordinal, s.raw_text, s.heading, s.locator_json, s.extraction)
  db.prepare(
    'INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)'
  ).run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(
    revision,
    document
  )
  return {
    material,
    version,
    document,
    revision,
    sources,
    state,
    asset,
    source: {
      material_id: material,
      version_id: version,
      revision_id: revision,
      entry_id: state.entries[0].id
    }
  }
}

test('迁移21升级习题时保留全部旧列、原题及关联；中途失败回滚后可重试', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 21)) db.exec(m.sql)
  db.pragma('user_version=21')
  db.exec(
    `INSERT INTO exercises(id,statement,user_solution,std_answer,approach_json,error_points_json,related_json,created_at,updated_at) VALUES ('old','原题','作答','标准','["步骤"]','["错因"]','["旧引用"]',1,2)`
  )
  const before = db.prepare('SELECT * FROM exercises').get(),
    migration = MIGRATIONS.find((m) => m.version === 22)
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec(migration.sql)
        db.pragma('user_version=22')
        throw Error('升级中断')
      })(),
    /升级中断/
  )
  assert.equal(db.pragma('user_version', { simple: true }), 21)
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='exercise_revisions'").get(),
    undefined
  )
  db.transaction(() => {
    db.exec(migration.sql)
    db.pragma('user_version=22')
  })()
  const after = db.prepare('SELECT * FROM exercises').get()
  for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})

test('旧习题首次读取只建立内置修订，不覆盖原始 JSON；重启后仍可读取并编辑', async () => {
  const db = getDb(),
    id = next()
  db.prepare(
    'INSERT INTO exercises(id,statement,user_solution,std_answer,approach_json,error_points_json,no_idea,related_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, '旧题', '旧作答', '旧标准', '[ "步骤一" ]', '原始错因', 1, '["old-ref"]', 10, 20)
  const before = db.prepare('SELECT * FROM exercises WHERE id=?').get(id)
  const detail = ok(await invoke('exercises:get', { id })),
    snapshot = detail.snapshot
  assert.equal(snapshot.legacy.approach_json, '[ "步骤一" ]')
  assert.equal(snapshot.legacy.related_json, '["old-ref"]')
  assert.equal(exerciseTexts(snapshot).user_answer, '旧作答')
  assert.equal(exerciseTexts(snapshot).error_reason, '原始错因')
  const after = db.prepare('SELECT * FROM exercises WHERE id=?').get(id)
  for (const key of Object.keys(before).filter((key) => key !== 'head_revision_id'))
    assert.deepEqual(after[key], before[key])
  closeDb()
  assert.equal(ok(await invoke('exercises:get', { id })).revision_id, detail.revision_id)
  const updated = ok(await save({ ...input(), id, expected_revision_id: detail.revision_id }))
  assert.deepEqual(updated.snapshot.legacy, snapshot.legacy)
})

test('独立字段保存、知识引用、全文检索、历史修订与陈旧窗口保护', async () => {
  const concept = ok(
      await invoke('concepts:save', {
        subject_id: null,
        name: '幂函数导数',
        summary: '导数规则',
        aliases: []
      })
    ),
    value = { ...input(), review_concept_ids: [concept.id] }
  const first = ok(await save(value))
  assert.deepEqual(exerciseTexts(first.snapshot), value.fields)
  validateLearningState(first.snapshot.document.state, first.snapshot.document.sources)
  assert.equal(first.snapshot.document.state.relations.length, 3)
  const edited = {
    ...value,
    id: first.id,
    expected_revision_id: first.revision_id,
    status: 'correct',
    fields: { ...value.fields, user_answer: '$2x$' }
  }
  const second = ok(await save(edited))
  assert.equal(second.history.length, 2)
  assert.equal((await save(edited)).ok, false)
  assert.equal(
    exerciseTexts(
      ok(await invoke('exercises:get', { id: first.id, revision_id: first.revision_id })).snapshot
    ).user_answer,
    '$x$'
  )
  assert.equal(
    ok(
      await invoke('exercises:list', {
        status: 'correct',
        concept_id: concept.id,
        query: '漏乘指数',
        question_type: '计算'
      })
    ).items.some((item) => item.id === first.id),
    true
  )
  assert.equal(
    (
      await invoke('exercises:get', {
        id: first.id,
        revision_id: ok(await save(input())).revision_id
      })
    ).ok,
    false
  )
  const revisionCount = getDb().prepare('SELECT count(*) AS n FROM exercise_revisions').get().n
  for (const bad of [
    { ...edited, review_concept_ids: ['missing'] },
    { ...edited, review_concept_ids: [concept.id, concept.id] },
    { ...edited, subject_id: 'missing' },
    { ...value, status: 'auto-correct' },
    { ...value, fields: { ...value.fields, statement: '' } },
    { ...value, origin: { raw_text: '伪造' } }
  ])
    assert.equal((await save(bad)).ok, false)
  assert.equal(
    getDb().prepare('SELECT count(*) AS n FROM exercise_revisions').get().n,
    revisionCount
  )
})

test('保存失败事务回滚，不产生孤立修订或半更新', async () => {
  const first = ok(await save(input())),
    db = getDb(),
    count = db.prepare('SELECT count(*) AS n FROM exercise_revisions').get().n
  db.exec(
    "CREATE TRIGGER fail_exercise BEFORE UPDATE ON exercises BEGIN SELECT RAISE(ABORT,'模拟保存失败'); END"
  )
  assert.equal(
    (
      await save({
        ...input(),
        id: first.id,
        expected_revision_id: first.revision_id,
        title: '不能保存'
      })
    ).ok,
    false
  )
  assert.equal((await save({ ...input(), title: '新题也不能半建' })).ok, false)
  db.exec('DROP TRIGGER fail_exercise')
  assert.equal(db.prepare('SELECT count(*) AS n FROM exercise_revisions').get().n, count)
  assert.equal(ok(await invoke('exercises:get', { id: first.id })).revision_id, first.revision_id)
})

test('教材转入固定来源、公式与配图，解答按关系带入；重复导入不覆盖答案', async () => {
  const doc = fixture(),
    first = ok(await invoke('exercises:import', doc.source)),
    texts = exerciseTexts(first.snapshot)
  assert.equal(texts.statement, '例题 求 $x^2$ 的导数')
  assert.equal(texts.standard_answer, '解答结果 2x')
  assert.equal(first.snapshot.origin.raw_text, doc.sources[0].raw_text)
  assert.equal(first.snapshot.origin.assets[0].id, doc.asset)
  assert.deepEqual(first.snapshot.origin.entry, doc.state.entries[0])
  assert.equal(first.snapshot.document.state.entries[0].figures[0].asset_id, doc.asset)
  const updated = ok(
    await save({
      ...input(),
      id: first.id,
      expected_revision_id: first.revision_id,
      fields: { ...texts, user_answer: '用户已完成' }
    })
  )
  getDb().prepare('UPDATE materials SET archived=1,title=? WHERE id=?').run('改名', doc.material)
  const duplicate = ok(await invoke('exercises:import', doc.source))
  assert.equal(duplicate.id, first.id)
  assert.equal(duplicate.revision_id, updated.revision_id)
  assert.equal(exerciseTexts(duplicate.snapshot).user_answer, '用户已完成')
  assert.equal(duplicate.snapshot.origin.label, first.snapshot.origin.label)
  for (const bad of [
    { ...doc.source, material_id: fixture().material },
    { ...doc.source, revision_id: fixture().revision },
    { ...doc.source, entry_id: doc.state.entries[1].id },
    { ...doc.source, entry_id: 'missing' }
  ])
    assert.equal((await invoke('exercises:import', bad)).ok, false)
  const print = learningPdfSnapshot({
    source: { kind: 'exercise', exercise_id: first.id, revision_id: first.revision_id },
    landscape: false,
    include_original_text: true
  })
  assert.equal(print.exercise_origin.raw_text, doc.sources[0].raw_text)
  assert.equal(print.assets[0].id, doc.asset)
  assert.match(print.source_name, /未完成/)
  const trashed = ok(
    await invoke('exercises:trash', { id: first.id, expected_revision_id: updated.revision_id })
  )
  assert.notEqual(trashed.revision_id, updated.revision_id)
  assert.equal((await invoke('exercises:import', doc.source)).ok, false)
  assert.equal(
    (await save({ ...input(), id: first.id, expected_revision_id: trashed.revision_id })).ok,
    false
  )
  assert.ok(
    ok(await invoke('exercises:list', { trash: true })).items.some((item) => item.id === first.id)
  )
  assert.ok(!ok(await invoke('exercises:list', {})).items.some((item) => item.id === first.id))
  assert.equal(
    (await invoke('exercises:restore', { id: first.id, expected_revision_id: updated.revision_id }))
      .ok,
    false
  )
  const restored = ok(
    await invoke('exercises:restore', { id: first.id, expected_revision_id: trashed.revision_id })
  )
  assert.equal(restored.deleted_at, null)
  assert.equal(exerciseTexts(restored.snapshot).user_answer, '用户已完成')
  assert.equal(
    (await save({ ...input(), id: first.id, expected_revision_id: updated.revision_id })).ok,
    false,
    '删除恢复后旧窗口不能覆盖'
  )
  assert.deepEqual(getDb().pragma('foreign_key_check'), [])
})

test('分页无重叠；搜索按字面匹配百分号和下划线', async () => {
  for (let n = 0; n < 56; n++)
    ok(await save({ ...input(), title: `分页 ${n}`, source_label: '分页独立组' }))
  const first = ok(await invoke('exercises:list', { query: '分页独立组' })),
    second = ok(await invoke('exercises:list', { query: '分页独立组', offset: first.next_offset }))
  assert.equal(first.items.length, 50)
  assert.equal(second.items.length, 6)
  assert.equal(second.next_offset, null)
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 56)
  const special = ok(await save({ ...input(), source_label: '100%_literal' }))
  assert.deepEqual(
    ok(await invoke('exercises:list', { query: '100%_literal' })).items.map((item) => item.id),
    [special.id]
  )
})
