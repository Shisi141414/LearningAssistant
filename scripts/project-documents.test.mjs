import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { initialLearningState } from '../shared/learning-document.ts'
import { learningPdfSnapshot } from '../src/main/services/learning-pdf.ts'
registerAllIpc()
after(closeDb)
const ok = (result) => {
  assert.equal(result.ok, true, result.error)
  return result.data
}
const createProject = async () =>
  ok(await invoke('projects:create', { title: '振动测量项目', goal: '保留旧目标' }))
const save = (value) => invoke('projectDocuments:save', value)
const input = (project) => ({
  project_id: project.id,
  title: '计划书',
  kind: 'plan',
  concept_ids: [],
  body: '目标：验证 $F=ma$。\n😀约束：先定义系统边界。'
})
const action = (doc) => ({ id: doc.id, expected_revision_id: doc.head_revision_id })
let seq = 0
const next = () => `project-doc-fixture-${++seq}`
function materialFixture() {
  const db = getDb(),
    material_id = next(),
    version_id = next(),
    document = next(),
    revision_id = next(),
    source = next(),
    asset = next()
  db.prepare("INSERT INTO materials(id,title,created_at) VALUES (?,'任务书原件',0)").run(
    material_id
  )
  db.prepare(
    "INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'source.pdf','unused.pdf','pdf','hash','ready',0)"
  ).run(version_id, material_id)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version_id, material_id)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(
    document,
    version_id
  )
  const sources = [
    {
      id: source,
      ordinal: 0,
      raw_text: '任务要求 F=ma',
      heading: '任务书',
      locator_json: '{"kind":"pdf","page":2}',
      extraction: 'native'
    }
  ]
  const state = initialLearningState(sources, next)
  state.entries[0].formulas = [{ range: [5, 9], latex: 'F=ma', display: false }]
  state.entries[0].figures = [{ asset_id: asset, caption: '系统示意' }]
  db.prepare(
    'INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,0,?,?,?,?)'
  ).run(
    source,
    document,
    sources[0].raw_text,
    sources[0].heading,
    sources[0].locator_json,
    'native'
  )
  db.prepare(
    'INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)'
  ).run(revision_id, document, JSON.stringify(state))
  db.prepare(
    "INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,'image/png','sha','unused.png',1,1,'{}','图',0)"
  ).run(asset, document)
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(
    revision_id,
    document
  )
  return { material_id, version_id, revision_id, state, sources, document, asset }
}
test('23→24升级失败回滚、重试，保留既有项目任务与知识关系', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const migration of MIGRATIONS.filter((item) => item.version <= 23)) db.exec(migration.sql)
  db.exec(
    "INSERT INTO projects(id,title,created_at,updated_at) VALUES ('p','原项目',1,2);INSERT INTO tasks(id,title,kind,project_id,created_at,updated_at) VALUES ('t','原任务','project_task','p',1,2)"
  )
  const before = db.prepare('SELECT * FROM projects').all(),
    tasks = db.prepare('SELECT * FROM tasks').all(),
    migration = MIGRATIONS.find((item) => item.version === 24)
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec(migration.sql)
        throw Error('中断')
      })(),
    /中断/
  )
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='project_documents'").get(),
    undefined
  )
  db.exec(migration.sql)
  assert.deepEqual(db.prepare('SELECT * FROM projects').all(), before)
  assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), tasks)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})
test('保存内部格式、渲染公式范围与原文，修订不可变，失败不留下空文档', async () => {
  const project = await createProject(),
    value = input(project),
    first = ok(await save(value))
  assert.equal(first.snapshot.sources[0].raw_text, value.body)
  assert.equal(first.snapshot.state.entries[0].formulas[0].latex, 'F=ma')
  assert.equal(value.body.slice(...first.snapshot.state.entries[0].formulas[0].range), '$F=ma$')
  assert.equal(
    (await save({ ...value, id: first.id, expected_revision_id: 'stale', title: '覆盖' })).ok,
    false
  )
  const second = ok(
    await save({
      ...value,
      ...action(first),
      expected_revision_id: first.head_revision_id,
      body: undefined,
      title: '修订计划书'
    })
  )
  assert.deepEqual(second.snapshot.state, first.snapshot.state)
  assert.equal(
    ok(await invoke('projectDocuments:get', { id: first.id, revision_id: first.revision_id }))
      .snapshot.title,
    '计划书'
  )
  const before = ok(await invoke('projectDocuments:list', { project_id: project.id })).length
  assert.equal((await save({ ...value, body: '' })).ok, false)
  assert.equal((await save({ ...value, concept_ids: ['missing'] })).ok, false)
  assert.equal((await save({ ...value, secret: 'unexpected' })).ok, false)
  assert.equal(ok(await invoke('projectDocuments:list', { project_id: project.id })).length, before)
})
test('复用拆分分类章节与公式保护，恢复旧修订新增版本并拒绝跨文档和陈旧恢复', async () => {
  const project = await createProject(),
    first = ok(await save(input(project))),
    entry_id = first.snapshot.state.entries[0].id
  assert.equal(
    (
      await invoke('projectDocuments:change', {
        ...action(first),
        entry_id,
        action: 'split',
        position: 18
      })
    ).ok,
    false
  )
  const removed = ok(
    await invoke('projectDocuments:change', {
      ...action(first),
      entry_id,
      action: 'formula-remove',
      range: first.snapshot.state.entries[0].formulas[0].range
    })
  )
  const split = ok(
    await invoke('projectDocuments:change', {
      ...action(removed),
      entry_id,
      action: 'split',
      position: 18
    })
  )
  assert.equal(split.snapshot.state.entries.length, 2)
  const edited = ok(
    await invoke('projectDocuments:change', {
      ...action(split),
      entry_id,
      action: 'edit',
      type: 'definition',
      title: '系统边界'
    })
  )
  assert.equal(edited.snapshot.state.entries[0].type, 'definition')
  assert.equal(
    (await invoke('projectDocuments:change', { ...action(split), entry_id, action: 'merge' })).ok,
    false
  )
  const other = ok(await save({ ...input(project), title: '另一个文档' }))
  assert.equal(
    (
      await invoke('projectDocuments:revisionRestore', {
        ...action(edited),
        revision_id: other.revision_id
      })
    ).ok,
    false
  )
  const restored = ok(
    await invoke('projectDocuments:revisionRestore', {
      ...action(edited),
      revision_id: first.revision_id
    })
  )
  assert.notEqual(restored.head_revision_id, first.head_revision_id)
  assert.deepEqual(restored.snapshot, first.snapshot)
  assert.equal(restored.history.length, 5)
  assert.equal(
    ok(await invoke('projectDocuments:get', { id: first.id, revision_id: edited.revision_id }))
      .snapshot.state.entries.length,
    2
  )
})
test('固定材料导入保留来源图文公式与旧版本，重复导入不覆盖，项目隔离和错误回滚', async () => {
  const project = await createProject(),
    m = materialFixture(),
    value = {
      project_id: project.id,
      material_id: m.material_id,
      version_id: m.version_id,
      revision_id: m.revision_id,
      kind: 'requirements'
    }
  const first = ok(await invoke('projectDocuments:import', value))
  assert.deepEqual(first.snapshot.sources, m.sources)
  assert.deepEqual(first.snapshot.state, m.state)
  assert.equal(first.snapshot.assets[0].id, m.asset)
  const edited = ok(
    await save({
      project_id: project.id,
      ...action(first),
      title: '人工任务书',
      kind: 'requirements',
      concept_ids: []
    })
  )
  assert.equal(ok(await invoke('projectDocuments:import', value)).revision_id, edited.revision_id)
  getDb()
    .prepare('UPDATE learning_revisions SET snapshot_json=? WHERE id=?')
    .run(JSON.stringify(initialLearningState(m.sources, next)), m.revision_id)
  assert.deepEqual(
    ok(await invoke('projectDocuments:get', { id: first.id })).snapshot.state,
    m.state
  )
  const pdf = learningPdfSnapshot({
    source: { kind: 'project_document', document_id: first.id, revision_id: first.revision_id },
    landscape: false,
    include_original_text: true
  })
  assert.equal(pdf.title, '任务书原件')
  assert.equal(pdf.assets[0].id, m.asset)
  assert.equal(pdf.state.entries[0].formulas[0].latex, 'F=ma')
  const other = await createProject()
  assert.equal(
    (await save({ ...input(other), id: first.id, expected_revision_id: edited.head_revision_id }))
      .ok,
    false
  )
  assert.equal(
    (await invoke('projectDocuments:import', { ...value, version_id: 'missing' })).ok,
    false
  )
})
test('知识回链随文档修订更新，回收站恢复保留历史，旧操作不能覆盖', async () => {
  const project = await createProject(),
    concept = ok(
      await invoke('concepts:save', {
        subject_id: null,
        name: '测量方法',
        summary: '',
        aliases: []
      })
    )
  const first = ok(await save({ ...input(project), concept_ids: [concept.id] }))
  assert.equal(
    ok(await invoke('concepts:usage', { concept_id: concept.id })).items.find(
      (item) => item.id === first.id
    ).kind,
    'project_document'
  )
  const trashed = ok(await invoke('projectDocuments:trash', action(first)))
  assert.equal(ok(await invoke('concepts:usage', { concept_id: concept.id })).total, 0)
  assert.equal(ok(await invoke('projectDocuments:list', { project_id: project.id })).length, 0)
  assert.equal(
    ok(await invoke('projectDocuments:list', { project_id: project.id, trash: true })).length,
    1
  )
  assert.equal((await invoke('projectDocuments:restore', action(first))).ok, false)
  const restored = ok(await invoke('projectDocuments:restore', action(trashed)))
  assert.equal(ok(await invoke('concepts:usage', { concept_id: concept.id })).total, 1)
  closeDb()
  assert.deepEqual(
    ok(await invoke('projectDocuments:get', { id: first.id })).snapshot,
    restored.snapshot
  )
  assert.equal((await invoke('projectDocuments:trash', action(first))).ok, false)
})
test('项目归档保留文档，明确删除项目只级联本人文档与修订', async () => {
  const a = await createProject(),
    b = await createProject(),
    da = ok(await save(input(a))),
    db = ok(await save(input(b)))
  ok(await invoke('projects:update', { id: a.id, status: 'archived' }))
  assert.equal(ok(await invoke('projectDocuments:list', { project_id: a.id }))[0].id, da.id)
  ok(await invoke('projects:remove', a.id))
  assert.equal((await invoke('projectDocuments:get', { id: da.id })).ok, false)
  assert.equal(
    getDb()
      .prepare('SELECT count(*) AS n FROM project_document_revisions WHERE document_id=?')
      .get(da.id).n,
    0
  )
  assert.equal(ok(await invoke('projectDocuments:get', { id: db.id })).id, db.id)
  assert.deepEqual(getDb().pragma('foreign_key_check'), [])
})
