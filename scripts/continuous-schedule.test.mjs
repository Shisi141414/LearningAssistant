import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { createTask } from '../src/main/services/projects.ts'
import { defaultTaskPlanning } from '../shared/auto-schedule.ts'
import {
  saveTaskPlanning,
  undoSchedule
} from '../src/main/services/auto-schedule.ts'
import {
  continuousScheduleState,
  continuousScheduleStamp,
  needsContinuousSchedule,
  saveContinuousSchedule,
  recoverContinuousSchedule,
  stopContinuousSchedule,
  checkContinuousSchedule
} from '../src/main/services/continuous-schedule.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { invoke } from './test-support.mjs'
registerAllIpc()
after(closeDb)
beforeEach(() => {
  getDb().prepare('DELETE FROM schedule_runs').run()
  getDb().prepare('DELETE FROM tasks').run()
  getDb().prepare('DELETE FROM schedule_automation').run()
  recoverContinuousSchedule()
})

test('27→28 升级中断回滚并重试，旧排程/锁定块/提醒不改变', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 27)) db.exec(m.sql)
  db.pragma('user_version=27')
  db.prepare(
    "INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES('t','manual','旧任务','open',0,0)"
  ).run()
  db.prepare(
    "INSERT INTO schedule_blocks VALUES('b','t',1000,2000,1,'r','原块')"
  ).run()
  db.prepare(
    "INSERT INTO schedule_runs VALUES('run',0,'[]','fp','[]',NULL)"
  ).run()
  const migration = MIGRATIONS.find((m) => m.version === 28)
  assert.throws(() =>
    db.transaction(() => {
      db.exec(migration.sql)
      db.pragma('user_version=28')
      throw Error('中断')
    })()
  )
  assert.equal(db.pragma('user_version', { simple: true }), 27)
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) c FROM pragma_table_info('schedule_runs') WHERE name='origin'"
      )
      .get().c,
    0
  )
  db.transaction(() => {
    db.exec(migration.sql)
    db.pragma('user_version=28')
  })()
  assert.equal(
    db.prepare("SELECT origin FROM schedule_runs WHERE id='run'").get().origin,
    'manual'
  )
  assert.equal(
    db.prepare("SELECT locked FROM schedule_blocks WHERE id='b'").get().locked,
    1
  )
  assert.equal(db.prepare('SELECT COUNT(*) c FROM reminders').get().c, 0)
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO schedule_automation(id,revision,enabled,horizon_days) VALUES(1,'r',1,32)"
        )
        .run(),
    /CHECK/
  )
  db.close()
})
test('默认停用、范围与配置乐观锁；非法 IPC 不修改配置', async () => {
  const initial = continuousScheduleState()
  assert.equal(initial.settings.enabled, false)
  assert.equal(needsContinuousSchedule(), false)
  const enabled = saveContinuousSchedule({
    ...initial.settings,
    enabled: true,
    horizon_days: 7
  })
  assert.equal(needsContinuousSchedule(), true)
  assert.throws(
    () => saveContinuousSchedule({ ...initial.settings, enabled: false }),
    /改变/
  )
  assert.throws(
    () => saveContinuousSchedule({ ...enabled.settings, horizon_days: 0 }),
    /1–31/
  )
  assert.equal(
    (
      await invoke('planning:continuousSave', {
        revision: enabled.settings.revision,
        enabled: true,
        horizon_days: 2,
        extra: 'x'
      })
    ).ok,
    false
  )
  assert.equal(continuousScheduleState().settings.horizon_days, 7)
  saveContinuousSchedule({ ...enabled.settings, enabled: false })
  assert.equal(needsContinuousSchedule(), false)
})
test('同毫秒任务更新、时间块与依赖变更均改变源标记；空闲轮询不改变', () => {
  const n = Date.now(),
    t = createTask({ title: '源变更', due_at: n + 3600000 })
  saveTaskPlanning({ ...defaultTaskPlanning(t.id), enabled: true })
  const a = continuousScheduleStamp(n)
  assert.equal(continuousScheduleStamp(n + 1), a)
  getDb().prepare('UPDATE tasks SET title=? WHERE id=?').run('同毫秒改名', t.id)
  const b = continuousScheduleStamp(n)
  assert.notEqual(b, a)
  getDb()
    .prepare("INSERT INTO schedule_blocks VALUES('b',?,?,?,0,'r','安排')")
    .run(t.id, n + 60000, n + 120000)
  const c = continuousScheduleStamp(n)
  assert.notEqual(c, b)
  const dep = createTask({ title: '前置' })
  getDb().prepare('INSERT INTO task_dependencies VALUES(?,?)').run(t.id, dep.id)
  assert.notEqual(continuousScheduleStamp(n), c)
})
test('跨过时间块结束、截止或自然日期会触发补排，同一时段不空转', () => {
  const d = new Date()
  d.setHours(10, 0, 0, 0)
  const n = d.getTime(),
    t = createTask({ title: '时间边界', due_at: n + 180000 })
  saveTaskPlanning({ ...defaultTaskPlanning(t.id), enabled: true })
  getDb()
    .prepare("INSERT INTO schedule_blocks VALUES('b',?,?,?,0,'r','安排')")
    .run(t.id, n + 60000, n + 120000)
  const before = continuousScheduleStamp(n)
  assert.equal(continuousScheduleStamp(n + 1000), before)
  const ended = continuousScheduleStamp(n + 120000)
  assert.notEqual(ended, before)
  assert.notEqual(continuousScheduleStamp(n + 180000), ended)
  assert.notEqual(
    continuousScheduleStamp(n + 86400000),
    continuousScheduleStamp(n + 180000)
  )
})
test('中断状态恢复后重新检查但不直接改块；退避期间不反复重试', () => {
  saveContinuousSchedule({
    ...continuousScheduleState().settings,
    enabled: true
  })
  getDb()
    .prepare(
      "UPDATE schedule_automation SET state='running',last_stamp='old',retry_at=?"
    )
    .run(Date.now() + 60000)
  recoverContinuousSchedule()
  assert.equal(continuousScheduleState().state, 'waiting')
  assert.equal(needsContinuousSchedule(), true)
  getDb()
    .prepare("UPDATE schedule_automation SET state='error',retry_at=?")
    .run(Date.now() + 60000)
  assert.equal(needsContinuousSchedule(), false)
})
test('输入规模超限也保存可见失败状态与退避，未启动线程或写入半份安排', async () => {
  saveContinuousSchedule({
    ...continuousScheduleState().settings,
    enabled: true
  })
  const insert = getDb().prepare(
    "INSERT INTO tasks(id,kind,title,status,created_at,updated_at) VALUES(?,'manual','规模测试','open',0,0)"
  )
  getDb().transaction(() => {
    for (let i = 0; i < 5001; i++) insert.run('bulk:' + i)
  })()
  const result = await checkContinuousSchedule(true)
  assert.equal(result.state, 'error')
  assert.match(result.error, /五千/)
  assert.equal(needsContinuousSchedule(), false)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) c FROM schedule_blocks').get().c,
    0
  )
})

test('没有源变化的手动强制检查失败或暂缓后，仍可自动重试并恢复状态', () => {
  saveContinuousSchedule({
    ...continuousScheduleState().settings,
    enabled: true
  })
  const stamp = continuousScheduleStamp()
  getDb()
    .prepare("UPDATE schedule_automation SET state='idle',last_stamp=?")
    .run(stamp)
  assert.equal(needsContinuousSchedule(), false)
  getDb()
    .prepare("UPDATE schedule_automation SET state='error',retry_at=?")
    .run(Date.now() + 60000)
  assert.equal(needsContinuousSchedule(), false)
  getDb().prepare('UPDATE schedule_automation SET retry_at=0').run()
  assert.equal(needsContinuousSchedule(), true)
  getDb().prepare("UPDATE schedule_automation SET state='waiting'").run()
  assert.equal(needsContinuousSchedule(), true)
})

test('陈旧撤销失败不会顺带停用自动管理；停止后不再开工作线程', async () => {
  saveContinuousSchedule({
    ...continuousScheduleState().settings,
    enabled: true
  })
  getDb()
    .prepare(
      "INSERT INTO schedule_runs(id,created_at,before_json,after_fingerprint,changed_json) VALUES('bad',0,'[]','wrong','[]')"
    )
    .run()
  assert.throws(() => undoSchedule('bad'), /修改|改动/)
  assert.equal(continuousScheduleState().settings.enabled, true)
  stopContinuousSchedule()
  await assert.rejects(checkContinuousSchedule(), /停止/)
})
