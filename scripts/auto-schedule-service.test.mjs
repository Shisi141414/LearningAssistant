import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { defaultTaskPlanning } from '../shared/auto-schedule.ts'
registerAllIpc()
after(closeDb)
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
const call = async (name, ...args) => ok(await invoke(name, ...args))
test('25→26 原子升级失败回滚后重试，既有任务和日程不变；新外键级联', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 25)) db.exec(m.sql)
  db.pragma('user_version=25')
  db.prepare(
    "INSERT INTO tasks(id,kind,title,status,planned_at,planned_end_at,created_at,updated_at) VALUES('old','manual','旧课程','open',1000,2000,0,0)"
  ).run()
  const migration = MIGRATIONS.find((m) => m.version === 26)
  assert.throws(() =>
    db.transaction(() => {
      db.exec(migration.sql)
      db.pragma('user_version=26')
      db.exec('INSERT INTO nonexistent VALUES(0)')
    })()
  )
  assert.equal(db.pragma('user_version', { simple: true }), 25)
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name='schedule_blocks'")
      .get(),
    undefined
  )
  db.transaction(() => {
    db.exec(migration.sql)
    db.pragma('user_version=26')
  })()
  assert.deepEqual(
    db
      .prepare("SELECT planned_at,planned_end_at FROM tasks WHERE id='old'")
      .get(),
    { planned_at: 1000, planned_end_at: 2000 }
  )
  assert.throws(
    () =>
      db.prepare("INSERT INTO task_planning VALUES('missing','r','{}')").run(),
    /FOREIGN KEY/
  )
  db.prepare("INSERT INTO task_planning VALUES('old','r','{}')").run()
  db.prepare(
    "INSERT INTO schedule_blocks VALUES('b','old',3000,4000,0,'r','test')"
  ).run()
  db.prepare("DELETE FROM tasks WHERE id='old'").run()
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM schedule_blocks').get().c,
    0
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_planning').get().c, 0)
  db.close()
})
test('配置与任务带版本保护，循环依赖被拒绝且事务不留下半份修改', async () => {
  let state = await call('planning:get')
  const original = structuredClone(state.settings.value)
  state = await call('planning:settings', {
    expected_revision: null,
    value: original
  })
  assert.equal(
    (
      await invoke('planning:settings', {
        expected_revision: null,
        value: original
      })
    ).ok,
    false
  )
  const a = await call('tasks:create', { title: '前置练习' }),
    b = await call('tasks:create', { title: '综合任务' })
  state = await call('planning:task', {
    ...defaultTaskPlanning(a.id),
    enabled: true
  })
  await call('planning:task', {
    ...defaultTaskPlanning(b.id),
    enabled: true,
    dependencies: [a.id]
  })
  const p = state.planning.find((p) => p.task_id === a.id),
    { revision, ...value } = p
  assert.equal(
    (
      await invoke('planning:task', {
        ...value,
        expected_revision: revision,
        dependencies: [b.id]
      })
    ).ok,
    false
  )
  assert.deepEqual(
    (await call('planning:get')).planning.find((p) => p.task_id === a.id)
      .dependencies,
    []
  )
  assert.equal(
    (
      await invoke('planning:task', {
        ...defaultTaskPlanning(a.id),
        enabled: true
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('planning:settings', {
        expected_revision: state.settings.revision,
        value: { ...original, buffer_minutes: 1000 }
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('planning:task', {
        ...defaultTaskPlanning(b.id),
        injected: true
      })
    ).ok,
    false
  )
})
test('自动块参与新建/课表冲突检查，拒绝冲突不会写入；完成后不阻塞', async () => {
  const a = await call('tasks:create', { title: '分段学习' }),
    start = Date.now() + 86400000,
    end = start + 3600000
  getDb()
    .prepare(
      "INSERT INTO schedule_blocks VALUES('conflict-block',?,?,?,0,'r','测试')"
    )
    .run(a.id, start, end)
  const before = (await call('tasks:listAll')).length
  const conflict = await call('calendar:save', {
    task: { title: '新课程', planned_at: start + 1000, planned_end_at: end }
  })
  assert.equal(conflict.task, null)
  assert.equal(conflict.conflicts.items[0].other.key, 'block:conflict-block')
  assert.equal((await call('tasks:listAll')).length, before)
  assert.equal(
    (
      await invoke('tasks:update', {
        id: a.id,
        planned_at: start,
        planned_end_at: end
      })
    ).ok,
    false
  )
  await call('planning:block', {
    id: 'conflict-block',
    expected_revision: 'r',
    action: 'lock'
  })
  assert.equal(
    (
      await invoke('planning:block', {
        id: 'conflict-block',
        expected_revision: 'r',
        action: 'remove'
      })
    ).ok,
    false
  )
  await call('tasks:update', { id: a.id, status: 'done' })
  assert.ok(
    (
      await call('calendar:save', {
        task: { title: '新课程', planned_at: start + 1000, planned_end_at: end }
      })
    ).task
  )
})
