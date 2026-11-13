import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { initialLearningState } from '../shared/learning-document.ts'
import { taskResourceHref } from '../shared/task-resources.ts'

registerAllIpc()
after(closeDb)
const ok = (result) => {
  assert.equal(result.ok, true, result.error)
  return result.data
}
const call = async (name, ...args) => ok(await invoke(name, ...args))
const fields = {
  role: 'apply',
  concept_id: null,
  why: '用受力模型计算，并说明适用条件',
  verification: '独立复算并比较实验值'
}
let seq = 0
const next = () => `resource-fixture-${++seq}`
const task = () =>
  call('tasks:create', {
    title: '验证振动模型',
    planned_at: 2000,
    planned_end_at: 3000,
    due_at: 4000
  })
function material(count = 1, body = '定义：F=ma。') {
  const db = getDb(),
    material_id = next(),
    version_id = next(),
    document = next(),
    revision_id = next()
  db.prepare(
    "INSERT INTO materials(id,title,created_at) VALUES (?,'力学教材',0)"
  ).run(material_id)
  db.prepare(
    "INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'source.pdf','unused.pdf','pdf','hash','ready',0)"
  ).run(version_id, material_id)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(
    version_id,
    material_id
  )
  db.prepare(
    'INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)'
  ).run(document, version_id)
  const sources = Array.from({ length: count }, (_, ordinal) => ({
    id: next(),
    ordinal,
    raw_text: body,
    heading: '',
    locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 }),
    extraction: 'native'
  }))
  for (const source of sources)
    db.prepare(
      'INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)'
    ).run(
      source.id,
      document,
      source.ordinal,
      source.raw_text,
      '',
      source.locator_json,
      'native'
    )
  const state = initialLearningState(sources, next)
  if (body === '定义：F=ma。')
    state.entries[0].formulas = [
      { range: [3, 7], latex: 'F=ma', display: false }
    ]
  db.prepare(
    'INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)'
  ).run(revision_id, document, JSON.stringify(state))
  db.prepare(
    'UPDATE learning_documents SET current_revision_id=? WHERE id=?'
  ).run(revision_id, document)
  return {
    source: {
      kind: 'material',
      material_id,
      version_id,
      revision_id,
      entry_id: state.entries[0].id
    },
    state,
    document
  }
}
async function fourSources() {
  const m = material(),
    n = await call('notes:create', { title: '课堂记录', source: 'class' })
  const segment = await call('notes:addSegment', {
    note_id: n.id,
    raw_text: '教师原话：先确定系统。',
    organized_text: '系统边界决定受力分析',
    seg_type: 'definition'
  })
  const note = await call('notes:learningGet', { note_id: n.id })
  const exercise = await call('exercises:save', {
    title: '计算题',
    subject_id: null,
    status: 'unfinished',
    question_type: '计算',
    source_label: '教材P2',
    no_idea: true,
    review_concept_ids: [],
    fields: {
      statement: '求 $F$。',
      approach: '',
      standard_answer: '$ma$',
      user_answer: '',
      error_reason: ''
    }
  })
  const project = await call('projects:create', { title: '实验项目' })
  const doc = await call('projectDocuments:save', {
    project_id: project.id,
    title: '成果报告',
    kind: 'report',
    body: '结论 $F=ma$，含条件。',
    concept_ids: []
  })
  return {
    m,
    note,
    segment,
    exercise,
    doc,
    project,
    sources: [
      m.source,
      {
        kind: 'note',
        note_id: n.id,
        revision_id: note.revision_id,
        entry_id: note.state.entries[0].id
      },
      {
        kind: 'exercise',
        exercise_id: exercise.id,
        revision_id: exercise.revision_id,
        entry_id: exercise.snapshot.document.fields.standard_answer
      },
      {
        kind: 'project_document',
        document_id: doc.id,
        revision_id: doc.revision_id,
        entry_id: doc.snapshot.state.entries[0].id
      }
    ]
  }
}
const add = (t, source, override = {}) =>
  call('taskResources:add', { ...fields, task_id: t.id, source, ...override })
const list = (t) => call('taskResources:list', { task_id: t.id })

test('24→25迁移中断回滚、重试，保留既有项目任务、时间和外键', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 24)) db.exec(m.sql)
  db.pragma('user_version=24')
  db.exec(
    "INSERT INTO projects(id,title,created_at,updated_at) VALUES('p','旧项目',1,2);INSERT INTO tasks(id,title,kind,project_id,planned_at,planned_end_at,created_at,updated_at) VALUES('t','旧任务','project_task','p',1000,2000,1,2)"
  )
  const before = db.prepare('SELECT * FROM tasks').all(),
    migration = MIGRATIONS.find((m) => m.version === 25)
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec(migration.sql)
        db.pragma('user_version=25')
        throw Error('模拟中断')
      })(),
    /模拟中断/
  )
  assert.equal(db.pragma('user_version', { simple: true }), 24)
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='task_resource_links'"
      )
      .get(),
    undefined
  )
  db.transaction(() => {
    db.exec(migration.sql)
    db.pragma('user_version=25')
  })()
  assert.deepEqual(db.prepare('SELECT * FROM tasks').all(), before)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})

test('四类条目保存固定摘录/公式/原转写、正确跳转；重复不覆盖用途和任务时间', async () => {
  const t = await task(),
    fixture = await fourSources(),
    before = getDb().prepare('SELECT * FROM tasks WHERE id=?').get(t.id)
  for (const source of fixture.sources) {
    const added = await add(t, source),
      duplicate = await add(t, source, { why: '不应覆盖' })
    assert.equal(added.created, true)
    assert.equal(duplicate.created, false)
    assert.deepEqual(duplicate.resource, added.resource)
    assert.deepEqual(added.resource.snapshot.source, source)
    assert.equal(added.resource.available, true)
    const url = new URL(
      taskResourceHref(added.resource),
      'https://local.invalid'
    )
    assert.equal(url.searchParams.get('revision'), source.revision_id)
    assert.equal(url.searchParams.get('entry'), source.entry_id)
    if (source.kind === 'project_document')
      assert.ok(url.pathname.includes(fixture.project.id))
    if (source.kind === 'note')
      assert.equal(
        added.resource.snapshot.original_text,
        '教师原话：先确定系统。'
      )
    if (source.kind === 'material')
      assert.equal(added.resource.snapshot.formulas[0].latex, 'F=ma')
    assert.equal(
      (await call('taskResources:backlinks', { source })).items[0].task_id,
      t.id
    )
  }
  assert.equal((await list(t)).total, 4)
  assert.deepEqual(
    getDb().prepare('SELECT * FROM tasks WHERE id=?').get(t.id),
    before
  )
  assert.deepEqual(getDb().pragma('foreign_key_check'), [])
})

test('拒绝跨实体/修订/条目、未知字段、无效分页和过长摘录，不留下关联', async () => {
  const t = await task(),
    a = await fourSources(),
    b = await fourSources()
  const wrong = a.sources.map((source, i) => ({
    ...source,
    revision_id: b.sources[i].revision_id
  }))
  wrong.push(
    { ...a.m.source, material_id: b.m.source.material_id },
    { ...a.m.source, entry_id: 'missing' }
  )
  for (const source of wrong)
    assert.equal(
      (await invoke('taskResources:add', { ...fields, task_id: t.id, source }))
        .ok,
      false
    )
  for (const override of [
    { role: 'unknown' },
    { why: 'a'.repeat(4001) },
    { concept_id: 'missing' },
    { extra: true },
    { source: { ...a.m.source, extra: true } },
    { task_id: 'missing' }
  ])
    assert.equal(
      (
        await invoke('taskResources:add', {
          ...fields,
          task_id: t.id,
          source: a.m.source,
          ...override
        })
      ).ok,
      false
    )
  for (const offset of [-1, 0.5, 10_000_001])
    assert.equal(
      (await invoke('taskResources:list', { task_id: t.id, offset })).ok,
      false
    )
  assert.equal(
    (
      await invoke('taskResources:add', {
        ...fields,
        task_id: t.id,
        source: material(1, 'a'.repeat(40001)).source
      })
    ).ok,
    false
  )
  assert.equal((await list(t)).total, 0)
})

test('编辑/移除的陈旧修订被拒绝，知识点应用回链去重且不改任务JSON', async () => {
  const t = await task(),
    m = material(),
    c = await call('concepts:save', {
      subject_id: null,
      name: '建模边界',
      aliases: [],
      summary: ''
    })
  const { resource } = await add(t, m.source, { concept_id: c.id })
  const edit = {
    ...fields,
    id: resource.id,
    expected_revision: resource.revision,
    concept_id: c.id,
    why: '改为独立建模'
  }
  const changed = await call('taskResources:edit', edit)
  assert.notEqual(changed.revision, resource.revision)
  assert.equal((await invoke('taskResources:edit', edit)).ok, false)
  assert.equal(
    (
      await invoke('taskResources:remove', {
        id: resource.id,
        expected_revision: resource.revision
      })
    ).ok,
    false
  )
  assert.equal((await list(t)).items[0].why, edit.why)
  let usage = await call('concepts:usage', { concept_id: c.id })
  assert.deepEqual(
    usage.items.filter((item) => item.kind === 'task').map((item) => item.id),
    [t.id]
  )
  assert.equal(usage.items[0].why, edit.why)
  assert.equal(
    getDb()
      .prepare('SELECT knowledge_refs_json FROM tasks WHERE id=?')
      .get(t.id).knowledge_refs_json,
    '[]'
  )
  await call('tasks:update', {
    id: t.id,
    knowledge_refs: [{ concept_id: c.id, why: '原知识关联' }]
  })
  usage = await call('concepts:usage', { concept_id: c.id })
  assert.equal(usage.total, 1)
  await call('taskResources:remove', {
    id: changed.id,
    expected_revision: changed.revision
  })
  assert.equal((await list(t)).total, 0)
  assert.equal((await call('concepts:usage', { concept_id: c.id })).total, 1)
})

test('来源更新和删除不重定向，四种来源均保留快照且旧链接不再可用', async () => {
  const fixture = await fourSources(),
    t = await task(),
    db = getDb()
  const originals = []
  for (const source of fixture.sources)
    originals.push((await add(t, source)).resource)
  await call('notes:updateSegment', {
    id: fixture.segment.id,
    raw_text: '修改后的原话',
    organized_text: '新版整理'
  })
  await call('notes:learningGet', { note_id: fixture.note.note_id })
  await call('projectDocuments:save', {
    project_id: fixture.project.id,
    id: fixture.doc.id,
    expected_revision_id: fixture.doc.head_revision_id,
    title: '新标题',
    kind: 'report',
    concept_ids: [],
    body: '全新正文'
  })
  assert.deepEqual(
    (await list(t)).items
      .map((r) => r.snapshot)
      .sort((a, b) => a.source.kind.localeCompare(b.source.kind)),
    originals
      .map((r) => r.snapshot)
      .sort((a, b) => a.source.kind.localeCompare(b.source.kind))
  )
  // Material deletion normally uses the recoverable archive; simulate a deliberate full purge
  // in dependency order rather than disabling foreign keys.
  db.prepare(
    'UPDATE learning_documents SET current_revision_id=NULL WHERE id=?'
  ).run(fixture.m.document)
  db.prepare('DELETE FROM learning_revisions WHERE document_id=?').run(
    fixture.m.document
  )
  db.prepare('DELETE FROM learning_sources WHERE document_id=?').run(
    fixture.m.document
  )
  db.prepare('DELETE FROM learning_documents WHERE id=?').run(
    fixture.m.document
  )
  db.prepare('DELETE FROM materials WHERE id=?').run(
    fixture.m.source.material_id
  )
  db.prepare('DELETE FROM notes WHERE id=?').run(fixture.note.note_id)
  db.prepare('DELETE FROM exercise_revisions WHERE exercise_id=?').run(
    fixture.exercise.id
  )
  db.prepare('DELETE FROM exercises WHERE id=?').run(fixture.exercise.id)
  db.prepare('DELETE FROM projects WHERE id=?').run(fixture.project.id)
  const after = await list(t)
  assert.equal(after.total, 4)
  for (const r of after.items) {
    assert.equal(r.available, false)
    assert.equal(taskResourceHref(r), null)
    assert.deepEqual(
      r.snapshot,
      originals.find((item) => item.id === r.id).snapshot
    )
  }
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('50项分页、单任务64项上限、任务删除级联只清自身关联', async () => {
  const m = material(65),
    t = await task(),
    other = await task()
  for (let i = 0; i < 64; i++)
    await add(t, { ...m.source, entry_id: m.state.entries[i].id })
  assert.equal(
    (
      await invoke('taskResources:add', {
        ...fields,
        task_id: t.id,
        source: { ...m.source, entry_id: m.state.entries[64].id }
      })
    ).ok,
    false
  )
  const first = await list(t),
    second = await call('taskResources:list', {
      task_id: t.id,
      offset: first.next_offset
    })
  assert.equal(first.items.length, 50)
  assert.equal(second.items.length, 14)
  assert.equal(second.next_offset, null)
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r.id)).size,
    64
  )
  await add(other, m.source)
  await call('tasks:remove', t.id)
  assert.equal((await list(other)).total, 1)
  assert.equal(
    (await call('taskResources:backlinks', { source: m.source })).total,
    1
  )
})

test('保存失败原子回滚且可重试；归档和知识点移除不丢用途、公式与配图信息', async () => {
  const t = await task(),
    m = material(),
    db = getDb(),
    asset = next()
  const c = await call('concepts:save', {
    subject_id: null,
    name: '配图应用知识',
    aliases: [],
    summary: ''
  })
  db.prepare(
    "INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,'image/png','sha','unused.png',20,30,'{}','系统示意',0)"
  ).run(asset, m.document)
  m.state.entries[0].figures = [{ asset_id: asset, caption: '选择系统边界' }]
  db.prepare('UPDATE learning_revisions SET snapshot_json=? WHERE id=?').run(
    JSON.stringify(m.state),
    m.source.revision_id
  )
  db.exec(
    "CREATE TRIGGER fail_resource BEFORE INSERT ON task_resource_links BEGIN SELECT RAISE(ABORT,'模拟失败'); END"
  )
  assert.equal(
    (
      await invoke('taskResources:add', {
        ...fields,
        task_id: t.id,
        source: m.source,
        concept_id: c.id
      })
    ).ok,
    false
  )
  assert.equal((await list(t)).total, 0)
  db.exec('DROP TRIGGER fail_resource')
  const { resource } = await add(t, m.source, { concept_id: c.id })
  assert.deepEqual(resource.snapshot.figures, m.state.entries[0].figures)
  assert.equal(resource.snapshot.assets[0].alt_text, '系统示意')
  // Archiving is recoverable and does not remove historical navigation.
  db.prepare('UPDATE materials SET archived=1 WHERE id=?').run(
    m.source.material_id
  )
  db.prepare('DELETE FROM knowledge_points WHERE id=?').run(c.id)
  const kept = (await list(t)).items[0]
  assert.equal(kept.concept_id, null)
  assert.equal(kept.available, true)
  assert.ok(taskResourceHref(kept))
  assert.equal(kept.why, fields.why)
  assert.deepEqual(kept.snapshot, resource.snapshot)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})
