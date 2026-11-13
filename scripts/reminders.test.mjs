import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { getDb, closeDb } from '../src/main/services/db.ts'
import {
  createTask,
  updateTask,
  removeTask,
  createProject,
  updateProject
} from '../src/main/services/projects.ts'
import {
  reminderSettings,
  saveReminderSettings,
  saveTaskReminderOptions,
  taskReminderOptions,
  reconcileReminders,
  publishDueReminders,
  listReminders,
  claimSystemReminders,
  finishSystemDelivery,
  recoverReminderDeliveries,
  actOnReminder
} from '../src/main/services/reminders.ts'
import {
  quietUntil,
  defaultReminderSettings,
  allDayReminderEvent
} from '../shared/reminders.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { invoke } from './test-support.mjs'
registerAllIpc()
after(closeDb)
const now = () => Date.now(),
  minute = 60000
beforeEach(() => {
  getDb().prepare('DELETE FROM tasks').run()
  getDb().prepare('DELETE FROM reminder_settings').run()
  recoverReminderDeliveries()
})
const settings = (value = {}) =>
  saveReminderSettings({
    expected_revision: reminderSettings().revision,
    value: {
      ...defaultReminderSettings(),
      start_lead_minutes: 0,
      due_lead_minutes: 0,
      ...value
    }
  })
const list = (view, n) => listReminders({ view }, n).items
const action = (r, type, n, extra = {}) =>
  actOnReminder(
    { id: r.id, expected_revision: r.revision, action: type, ...extra },
    n
  )
test('26→27 故障回滚、重试及外键，保留原任务和锁定时间块', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 26)) db.exec(m.sql)
  db.pragma('user_version=26')
  db.prepare(
    "INSERT INTO tasks(id,kind,title,status,planned_at,created_at,updated_at) VALUES('old','manual','课程','open',1000,0,0)"
  ).run()
  db.prepare(
    "INSERT INTO schedule_blocks VALUES('b','old',1000,2000,1,'rev','旧块')"
  ).run()
  const m = MIGRATIONS.find((m) => m.version === 27)
  assert.throws(() =>
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma('user_version=27')
      throw Error('interrupted')
    })()
  )
  assert.equal(db.pragma('user_version', { simple: true }), 26)
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='reminders'").get(),
    undefined
  )
  db.transaction(() => {
    db.exec(m.sql)
    db.pragma('user_version=27')
  })()
  assert.equal(
    db.prepare("SELECT locked FROM schedule_blocks WHERE id='b'").get().locked,
    1
  )
  assert.equal(
    db.prepare("SELECT planned_at FROM tasks WHERE id='old'").get().planned_at,
    1000
  )
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO task_reminder_options VALUES('absent','r',1,NULL,NULL)"
        )
        .run(),
    /FOREIGN KEY/
  )
  db.close()
})
test('到点保存应用内提醒，重复检查和重启不重复发布；默认系统通知关闭', () => {
  settings()
  const n = now(),
    t = createTask({ title: '课程', planned_at: n + minute, location: '六教' })
  assert.equal(publishDueReminders(n), 0)
  assert.equal(publishDueReminders(n + minute), 1)
  const r = list('attention', n + minute)[0]
  assert.equal(r.task_id, t.id)
  assert.equal(r.system_status, 'skipped')
  recoverReminderDeliveries()
  assert.equal(publishDueReminders(n + 2 * minute), 0)
  assert.equal(list('attention', n + 2 * minute).length, 1)
})
test('改期即使不改 updated_at 也使旧提醒失效；完成和删除不会留下可投递提醒', () => {
  settings({ system_enabled: true })
  const n = now(),
    t = createTask({ title: '截止', due_at: n })
  publishDueReminders(n)
  const old = list('attention', n)[0]
  getDb()
    .prepare('UPDATE tasks SET due_at=? WHERE id=?')
    .run(n + 10 * minute, t.id)
  reconcileReminders(n)
  assert.equal(list('attention', n).length, 0)
  assert.equal(list('upcoming', n).length, 1)
  assert.equal(
    getDb().prepare('SELECT status FROM reminders WHERE id=?').get(old.id)
      .status,
    'cancelled'
  )
  assert.equal(claimSystemReminders(n), null)
  updateTask(t.id, { status: 'done' })
  reconcileReminders(n)
  assert.equal(list('upcoming', n).length, 0)
  removeTask(t.id)
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM reminders').get().c, 0)
})
test('补发窗口内合并系统批次，超出窗口进入历史，半开边界只投递一次', () => {
  settings({ system_enabled: true, catchup_minutes: 30 })
  const n = now()
  createTask({ title: '过期', due_at: n - 31 * minute })
  createTask({ title: '赶上', due_at: n - 30 * minute })
  createTask({ title: '到点', planned_at: n })
  assert.equal(publishDueReminders(n), 2)
  assert.equal(
    list('history', n).filter((r) => r.status === 'expired').length,
    1
  )
  const b = claimSystemReminders(n)
  assert.equal(b.items.length, 2)
  assert.equal(claimSystemReminders(n), null)
  finishSystemDelivery(b, 'shown')
  finishSystemDelivery(b, 'uncertain', '迟到的清理回调')
  assert.ok(list('attention', n).every((r) => r.system_status === 'shown'))
})
test('免打扰保留应用内记录，结束后只合并未处理且仍有效的提醒', () => {
  settings({
    system_enabled: true,
    quiet_enabled: true,
    quiet_start: '22:00',
    quiet_end: '07:00'
  })
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(23, 0, 0, 0)
  const n = d.getTime()
  const a = createTask({ title: '静音一', due_at: n }),
    b = createTask({ title: '静音二', due_at: n })
  publishDueReminders(n)
  assert.equal(list('attention', n).length, 2)
  assert.equal(claimSystemReminders(n), null)
  action(
    list('attention', n).find((r) => r.task_id === a.id),
    'dismiss',
    n
  )
  const end = new Date(n)
  end.setHours(31, 0, 0, 0)
  const batch = claimSystemReminders(end.getTime())
  assert.equal(batch.items.length, 1)
  assert.equal(batch.items[0].task_id, b.id)
})
test('关闭或提前结束免打扰立即释放待发送项，不使用旧免打扰结束时间', () => {
  settings({
    system_enabled: true,
    quiet_enabled: true,
    quiet_start: '22:00',
    quiet_end: '07:00'
  })
  const d = new Date()
  d.setHours(23, 0, 0, 0)
  const n = d.getTime()
  createTask({ title: '调整免打扰', due_at: n })
  publishDueReminders(n)
  assert.equal(claimSystemReminders(n), null)
  settings({ system_enabled: true, quiet_enabled: false })
  assert.equal(claimSystemReminders(n)?.items.length, 1)
})

test('稍后提醒有独立持久身份、陈旧操作不复制，改期会连同稍后提醒失效', () => {
  settings()
  const n = now(),
    t = createTask({ title: '稍后', due_at: n })
  publishDueReminders(n)
  const r = list('attention', n)[0]
  action(r, 'snooze', n, { minutes: 10 })
  assert.throws(() => action(r, 'snooze', n, { minutes: 10 }), /改变|失效/)
  assert.equal(list('attention', n + 9 * minute).length, 0)
  assert.equal(list('attention', n + 10 * minute).length, 1)
  assert.equal(
    getDb()
      .prepare('SELECT COUNT(*) c FROM reminders WHERE task_id=?')
      .get(t.id).c,
    2
  )
  updateTask(t.id, { due_at: n + 60 * minute })
  reconcileReminders(n + 11 * minute)
  assert.equal(list('attention', n + 11 * minute).length, 0)
  assert.equal(list('upcoming', n + 11 * minute).length, 1)
})
test('发送中断标记不确定不自动重发；手动重试使用新 attempt，旧回调不污染', () => {
  settings({ system_enabled: true })
  const n = now()
  createTask({ title: '系统', due_at: n })
  const first = claimSystemReminders(n)
  recoverReminderDeliveries()
  assert.equal(claimSystemReminders(n + minute), null)
  const r = list('attention', n + minute)[0]
  assert.equal(r.system_status, 'uncertain')
  action(r, 'retry', n + minute)
  const retry = claimSystemReminders(n + minute)
  assert.notEqual(retry.attempt, first.attempt)
  finishSystemDelivery(first, 'shown')
  assert.equal(list('attention', n + minute)[0].system_status, 'claimed')
  finishSystemDelivery(retry, 'failed', '测试拒绝')
  assert.equal(list('attention', n + minute)[0].system_status, 'failed')
})

test('发送中停用系统通知不会永久留在领取中；晚到回调不能恢复已停用通知', () => {
  settings({ system_enabled: true })
  const n = now()
  createTask({ title: '停用发送中', due_at: n })
  const batch = claimSystemReminders(n)
  settings({ system_enabled: false })
  finishSystemDelivery(batch, 'shown')
  assert.equal(list('attention', n)[0].system_status, 'skipped')
})
test('任务覆盖提前量、停用、阻塞与项目暂停，状态恢复也不重复已发布提醒', () => {
  settings()
  const n = now(),
    t = createTask({
      title: '覆盖',
      planned_at: n + 5 * minute,
      due_at: n + 10 * minute
    })
  saveTaskReminderOptions({
    ...taskReminderOptions(t.id),
    start_lead_minutes: 5,
    due_lead_minutes: 10
  })
  assert.equal(publishDueReminders(n), 2)
  const options = taskReminderOptions(t.id)
  saveTaskReminderOptions({ ...options, enabled: false })
  assert.equal(list('attention', n).length, 0)
  assert.throws(
    () => saveTaskReminderOptions({ ...options, enabled: true }),
    /改变/
  )
  saveTaskReminderOptions({ ...taskReminderOptions(t.id), enabled: true })
  assert.equal(publishDueReminders(n), 0)
  const project = createProject({ title: '暂停项目' }),
    p = createTask({
      title: '项目任务',
      project_id: project.id,
      planned_at: n,
      due_at: n
    })
  updateProject(project.id, { status: 'paused' })
  assert.ok(!list('attention', n).some((r) => r.task_id === p.id))
  updateTask(p.id, { status: 'blocked', blocked_reason: '等待资料' })
  updateProject(project.id, { status: 'active' })
  assert.deepEqual(
    list('attention', n)
      .filter((r) => r.task_id === p.id)
      .map((r) => r.kind),
    ['due']
  )
})
test('学习时间块按真实起点生成提醒，锁定不重复，移动/移除使旧块提醒失效', () => {
  settings()
  const n = now(),
    t = createTask({ title: '分段' })
  getDb()
    .prepare("INSERT INTO schedule_blocks VALUES('part',?,?,?,0,'r','分段')")
    .run(t.id, n, n + minute)
  assert.equal(publishDueReminders(n), 1)
  const r = list('attention', n)[0]
  assert.equal(r.kind, 'block')
  getDb()
    .prepare(
      "UPDATE schedule_blocks SET locked=1,revision='r2' WHERE id='part'"
    )
    .run()
  assert.equal(publishDueReminders(n), 0)
  getDb()
    .prepare("UPDATE schedule_blocks SET start_at=?,end_at=? WHERE id='part'")
    .run(n + 10 * minute, n + 11 * minute)
  assert.equal(list('attention', n).length, 0)
  assert.equal(list('upcoming', n).length, 1)
  getDb().prepare("DELETE FROM schedule_blocks WHERE id='part'").run()
  assert.equal(list('upcoming', n).length, 0)
})
test('完成任务动作、停用系统待发送、IPC 载荷与乐观修订保护', async () => {
  const s = settings({ system_enabled: true }),
    n = now(),
    t = createTask({ title: '完成动作', due_at: n })
  publishDueReminders(n)
  settings({ system_enabled: false })
  assert.equal(list('attention', n)[0].system_status, 'skipped')
  action(list('attention', n)[0], 'complete', n)
  assert.equal(
    getDb().prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status,
    'done'
  )
  assert.equal(claimSystemReminders(n), null)
  assert.throws(
    () =>
      saveReminderSettings({ expected_revision: s.revision, value: s.value }),
    /改变/
  )
  assert.equal(
    (
      await invoke('reminders:saveSettings', {
        expected_revision: null,
        value: { ...defaultReminderSettings(), extra: true }
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('reminders:action', {
        id: 'x',
        expected_revision: 'r',
        action: 'snooze',
        minutes: -1
      })
    ).ok,
    false
  )
})
test('全天提醒与跨午夜/夏令时免打扰使用真实日期，结束边界不再免打扰', () => {
  const s = { ...defaultReminderSettings(), quiet_enabled: true }
  assert.equal(
    quietUntil(Date.parse('2026-11-13T23:00:00+08:00'), s, 'Asia/Shanghai'),
    Date.parse('2026-11-14T07:00:00+08:00')
  )
  assert.equal(
    quietUntil(Date.parse('2026-11-14T07:00:00+08:00'), s, 'Asia/Shanghai'),
    null
  )
  assert.equal(
    quietUntil(Date.parse('2026-10-31T23:00:00-04:00'), s, 'America/New_York'),
    Date.parse('2026-11-01T07:00:00-05:00')
  )
  assert.equal(
    allDayReminderEvent(
      Date.parse('2026-11-13T00:00:00+08:00'),
      s,
      'Asia/Shanghai'
    ),
    Date.parse('2026-11-13T09:00:00+08:00')
  )
})
