import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { conceptLayout } from '../src/renderer/src/utils/concept-layout.ts'
registerAllIpc()
after(() => closeDb())
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
let sequence = 0
const concept = async (subject) =>
  ok(
    await invoke('concepts:save', {
      name: '图谱知识 ' + ++sequence,
      subject_id: subject ?? null,
      summary: '释义不被图谱改写',
      aliases: ['唯一别名 ' + sequence]
    })
  )
const connect = (a, b, extra = {}) =>
  invoke('concepts:relationSave', {
    from_id: a.id,
    to_id: b.id,
    relation: 'prerequisite',
    memo: '解释学习顺序',
    ...extra
  })
const graph = async () => ok(await invoke('concepts:graph'))

test('升级22→23保留旧概念、别名、任意旧关系与反向边；中断回滚后可重试', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 22)) db.exec(m.sql)
  db.pragma('user_version=22')
  db.exec(
    "INSERT INTO knowledge_points(id,name,created_at) VALUES ('a','原知识A',1),('b','原知识B',2); INSERT INTO concept_aliases(concept_id,name,normalized) VALUES ('a','别称','别称'); INSERT INTO knowledge_edges VALUES ('a','b','historical-special'),('b','a','related')"
  )
  const before = db.prepare('SELECT * FROM knowledge_points ORDER BY id').all(),
    aliases = db.prepare('SELECT * FROM concept_aliases').all(),
    edges = db.prepare('SELECT * FROM knowledge_edges ORDER BY from_id').all(),
    migration = MIGRATIONS.find((m) => m.version === 23)
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec(migration.sql)
        db.pragma('user_version=23')
        throw Error('升级中断')
      })(),
    /升级中断/
  )
  assert.equal(db.pragma('user_version', { simple: true }), 22)
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='concept_graph_positions'").get(),
    undefined
  )
  db.transaction(() => {
    db.exec(migration.sql)
    db.pragma('user_version=23')
  })()
  assert.deepEqual(db.prepare('SELECT * FROM knowledge_points ORDER BY id').all(), before)
  assert.deepEqual(db.prepare('SELECT * FROM concept_aliases').all(), aliases)
  const after = db.prepare('SELECT * FROM knowledge_edges ORDER BY from_id').all()
  for (let index = 0; index < edges.length; index++)
    for (const key of Object.keys(edges[index])) assert.equal(after[index][key], edges[index][key])
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.close()
})

test('前置环路和自关联在主进程拒绝，修改已有边也不能绕过；相关和推广不推断前置', async () => {
  const [a, b, c, d] = await Promise.all([concept(), concept(), concept(), concept()])
  ok(await connect(a, b))
  ok(await connect(b, c))
  const related = ok(await connect(c, a, { relation: 'related' }))
  assert.equal((await connect(a, a)).ok, false)
  assert.equal((await connect(c, a, { expected_revision: related.revision })).ok, false)
  assert.equal((await connect(c, d, { relation: 'extends' })).ok, true)
  assert.equal((await connect(d, a)).ok, true, '非前置关系不进入学习顺序循环')
  const before = await graph()
  assert.equal(
    before.relations.find((edge) => edge.from_id === c.id && edge.to_id === a.id).relation,
    'related'
  )
  assert.deepEqual(before.concepts.find((item) => item.id === a.id).aliases, a.aliases)
})

test('编辑/删除有修订保护，重复或删除重建不能覆盖旧说明；反向相关重复被拒绝', async () => {
  const a = await concept(),
    b = await concept(),
    first = ok(await connect(a, b, { relation: 'related' }))
  assert.equal((await connect(a, b, { memo: '不能覆盖' })).ok, false)
  assert.equal((await connect(b, a, { relation: 'related' })).ok, false)
  const second = ok(
    await connect(a, b, {
      relation: 'related',
      expected_revision: first.revision,
      memo: '人工新说明'
    })
  )
  assert.notEqual(first.revision, second.revision)
  assert.equal(
    (
      await invoke('concepts:relationRemove', {
        from_id: a.id,
        to_id: b.id,
        expected_revision: first.revision
      })
    ).ok,
    false
  )
  ok(
    await invoke('concepts:relationRemove', {
      from_id: a.id,
      to_id: b.id,
      expected_revision: second.revision
    })
  )
  const recreated = ok(await connect(a, b, { relation: 'related' }))
  assert.notEqual(recreated.revision, first.revision)
  assert.equal((await connect(a, b, { expected_revision: second.revision })).ok, false)
  assert.equal(
    (
      await invoke('concepts:relationRemove', {
        from_id: a.id,
        to_id: b.id,
        expected_revision: second.revision
      })
    ).ok,
    false
  )
})

test('图谱允许跨学科，布局按知识ID独立保存、事务回滚并随知识删除清理', async () => {
  const subjects = ok(await invoke('subjects:list')),
    a = await concept(subjects[0].id),
    b = await concept(subjects[1].id)
  ok(await connect(a, b, { relation: 'extends' }))
  const positions = [
    { concept_id: a.id, x: 123.25, y: -52 },
    { concept_id: b.id, x: 543, y: 98 }
  ]
  ok(await invoke('concepts:positions', positions))
  assert.deepEqual(
    (await graph()).positions.filter((item) => [a.id, b.id].includes(item.concept_id)),
    positions.sort((a, b) =>
      a.concept_id < b.concept_id ? -1 : a.concept_id > b.concept_id ? 1 : 0
    )
  )
  assert.equal(
    (
      await invoke('concepts:positions', [
        { concept_id: a.id, x: 999, y: 888 },
        { concept_id: 'missing', x: 0, y: 0 }
      ])
    ).ok,
    false
  )
  assert.equal((await graph()).positions.find((item) => item.concept_id === a.id).x, 123.25)
  assert.equal((await invoke('concepts:positions', [positions[0], positions[0]])).ok, false)
  for (const bad of [NaN, Infinity, 1_000_001])
    assert.equal(
      (await invoke('concepts:positions', [{ concept_id: a.id, x: bad, y: 0 }])).ok,
      false
    )
  closeDb()
  assert.equal((await graph()).positions.find((item) => item.concept_id === a.id).y, -52)
  getDb().prepare('DELETE FROM knowledge_points WHERE id=?').run(a.id)
  assert.ok(!(await graph()).positions.some((item) => item.concept_id === a.id))
  assert.ok(!(await graph()).relations.some((item) => item.from_id === a.id))
})

test('显式习题复习知识与任务用途反向查找，删除恢复和应用删除不会产生虚假回链', async () => {
  const c = await concept(),
    other = await concept(),
    project = ok(await invoke('projects:create', { title: '跨学科振动项目' }))
  const task = ok(
    await invoke('tasks:create', {
      project_id: project.id,
      title: '校验模型',
      knowledge_refs: [{ concept_id: c.id, why: '校验频率响应' }]
    })
  )
  const manual = ok(
    await invoke('tasks:create', {
      title: '补学概念',
      knowledge_refs: [{ concept_id: c.id, why: '先复习再计算' }]
    })
  )
  const value = {
    title: '图谱习题',
    subject_id: null,
    status: 'wrong',
    question_type: '计算',
    source_label: '来源',
    no_idea: false,
    review_concept_ids: [c.id],
    fields: {
      statement: '题面',
      approach: '',
      standard_answer: '',
      user_answer: '',
      error_reason: ''
    }
  }
  const exercise = ok(await invoke('exercises:save', value))
  const first = ok(await invoke('concepts:usage', { concept_id: c.id }))
  assert.equal(first.total, 3)
  const use = first.items.find((item) => item.id === task.id)
  assert.equal(use.project_id, project.id)
  assert.equal(use.why, '校验频率响应')
  assert.equal(first.items.find((item) => item.id === manual.id).project_id, null)
  assert.equal(ok(await invoke('concepts:usage', { concept_id: other.id })).total, 0)
  const trashed = ok(
    await invoke('exercises:trash', { id: exercise.id, expected_revision_id: exercise.revision_id })
  )
  assert.equal(ok(await invoke('concepts:usage', { concept_id: c.id })).total, 2)
  ok(
    await invoke('exercises:restore', {
      id: exercise.id,
      expected_revision_id: trashed.revision_id
    })
  )
  assert.equal(ok(await invoke('concepts:usage', { concept_id: c.id })).total, 3)
  ok(await invoke('projects:remove', project.id))
  assert.equal(ok(await invoke('concepts:usage', { concept_id: c.id })).total, 2)
  assert.deepEqual(getDb().pragma('foreign_key_check'), [])
})

test('应用回链分页完整、不重复；Dagre支持多父、交叉和孤立知识点', async () => {
  const c = await concept()
  for (let n = 0; n < 53; n++)
    ok(
      await invoke('tasks:create', {
        title: `分页用途 ${n}`,
        knowledge_refs: [{ concept_id: c.id, why: '引用' }]
      })
    )
  const first = ok(await invoke('concepts:usage', { concept_id: c.id })),
    second = ok(await invoke('concepts:usage', { concept_id: c.id, offset: first.next_offset }))
  assert.equal(first.items.length, 50)
  assert.equal(second.items.length, 3)
  assert.equal(second.next_offset, null)
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 53)
  const ids = ['a', 'b', 'c', 'd', 'isolated'],
    edges = [
      ['a', 'c'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'a']
    ].map(([from_id, to_id]) => ({ from_id, to_id, relation: 'related' }))
  const positions = conceptLayout(ids, edges)
  assert.equal(positions.length, 5)
  assert.ok(positions.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
  assert.equal(new Set(positions.map((point) => `${point.x},${point.y}`)).size, 5)
})
