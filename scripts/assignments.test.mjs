import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import {
  archiveAssignment,
  getAssignment,
  listAssignments,
  saveAssignment
} from '../src/main/services/assignments.ts'
import {
  createTask,
  listAllTasks,
  listManualTasks,
  removeTask,
  updateTask
} from '../src/main/services/projects.ts'
import { saveCalendarTask } from '../src/main/services/calendar.ts'
import {
  getPlanningState,
  saveTaskPlanning
} from '../src/main/services/auto-schedule.ts'
import { defaultTaskPlanning } from '../shared/auto-schedule.ts'
import {
  reconcileReminders,
  taskReminderOptions,
  saveTaskReminderOptions
} from '../src/main/services/reminders.ts'
import { scheduleCategory } from '../shared/schedule-colors.ts'

registerAllIpc()
after(() => closeDb())
let seq = 0
const input = (patch = {}) => ({
  title: '力学习题' + ++seq,
  subject_id: null,
  detail: '求解并说明采用的守恒律。',
  due_at: Date.now() + 86400000,
  status: 'open',
  blocked_reason: '',
  ...patch
})
const save = (a, patch = {}) =>
  saveAssignment(
    input({
      id: a.id,
      expected_revision: a.revision,
      title: a.task.title,
      subject_id: a.subject_id,
      detail: a.task.detail,
      due_at: a.task.due_at,
      status: a.task.status,
      blocked_reason: a.task.blocked_reason,
      ...patch
    })
  )
const archive = (a, archived = true) =>
  archiveAssignment({ id: a.id, expected_revision: a.revision, archived })
const list = (patch = {}) =>
  listAssignments({ query: '', scope: 'all', offset: 0, ...patch })

await test('v33 真实升级失败原子回滚、修复重试；原作业与其他任务/关联完整保留', () => {
  let old = new Database(join(dataRoot, 'learning-assistant.db'))
  old.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 33)) old.exec(m.sql)
  old.pragma('user_version=33')
  old.exec(`INSERT INTO subjects VALUES('old-subject','旧学科','#123456','',1);
    INSERT INTO assignments VALUES('old-assignment','old-subject','  原作业  ',123,'unknown-import',456,'unknown-status');
    INSERT INTO assignments VALUES('invalid',NULL,'',-5,'manual',-10,'blocked');
    INSERT INTO tasks(id,title,created_at,updated_at) VALUES('existing-task','其他日程',1,2);
    INSERT INTO calendar_import_receipts VALUES('existing-ics','existing-task',1);
    CREATE TABLE assignment_history(id TEXT);`)
  const original = old.prepare('SELECT * FROM assignments ORDER BY id').all()
  old.close()
  assert.throws(() => getDb(), /already exists/)
  old = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(old.pragma('user_version', { simple: true }), 33)
  assert.equal(
    old
      .prepare("SELECT name FROM sqlite_master WHERE name='assignment_links'")
      .get(),
    undefined
  )
  assert.deepEqual(
    old.prepare('SELECT * FROM assignments ORDER BY id').all(),
    original
  )
  old.exec('DROP TABLE assignment_history')
  old.close()
  const db = getDb()
  assert.equal(
    db.pragma('user_version', { simple: true }),
    MIGRATIONS.at(-1).version
  )
  assert.deepEqual(
    db.prepare('SELECT * FROM assignments ORDER BY id').all(),
    original
  )
  const a = getAssignment('old-assignment')
  assert.deepEqual(
    JSON.parse(a.legacy_snapshot_json),
    original.find((a) => a.id === 'old-assignment')
  )
  assert.equal(a.task.title, '原作业')
  assert.equal(a.task.status, 'open')
  assert.equal(a.task.due_at, 123)
  assert.equal(a.task.planned_at, 456)
  assert.equal(getAssignment('invalid').task.due_at, null)
  assert.equal(getAssignment('invalid').task.title, '未命名作业')
  assert.equal(
    db.prepare('SELECT task_id FROM calendar_import_receipts').get().task_id,
    'existing-task'
  )
  assert.equal(db.pragma('foreign_key_check').length, 0)
  closeDb()
  assert.equal(getAssignment('old-assignment').task.id, a.task.id)
  assert.equal(getAssignment('old-assignment').history_total, 1)
})

await test('创建/保存只对应一条统一任务，日程与科目配色、提醒/排程可直接复用', () => {
  const a = saveAssignment(input({ subject_id: 'old-subject' }))
  const task = listAllTasks().find((t) => t.id === a.task.id)
  assert.equal(task.assignment_id, a.id)
  assert.equal(task.assignment_subject_id, 'old-subject')
  assert.equal(task.assignment_revision, a.revision)
  assert.equal(
    scheduleCategory(task, [{ id: 'old-subject', name: '旧学科' }]),
    '学科：旧学科'
  )
  assert.equal(
    listManualTasks().some((t) => t.id === a.task.id),
    false
  )
  saveTaskPlanning({
    ...defaultTaskPlanning(a.task.id),
    expected_revision: null,
    enabled: true,
    remaining_minutes: 30
  })
  assert.equal(
    getPlanningState().planning.some((p) => p.task_id === a.task.id),
    true
  )
  const options = taskReminderOptions(a.task.id)
  saveTaskReminderOptions({ ...options, enabled: true, due_lead_minutes: 30 })
  assert.equal(taskReminderOptions(a.task.id).due_lead_minutes, 30)
  const changed = save(a, { title: '新的标题', due_at: a.task.due_at + 60000 })
  assert.notEqual(changed.revision, a.revision)
  assert.equal(changed.task.id, a.task.id)
  assert.equal(
    getDb()
      .prepare(
        'SELECT count(*) AS n FROM assignment_links WHERE assignment_id=?'
      )
      .get(a.id).n,
    1
  )
  assert.equal(
    getDb().prepare('SELECT title FROM tasks WHERE id=?').get(a.task.id).title,
    '新的标题'
  )
  assert.equal(changed.history_total, 2)
})

await test('日程和提醒共用的任务编辑反向留历史、镜像旧表并使旧作业草稿失效', () => {
  const a = saveAssignment(input())
  const saved = saveCalendarTask({
    id: a.task.id,
    expected_assignment_revision: a.revision,
    task: {
      title: '日程里改名',
      detail: '保留来源',
      due_at: a.task.due_at + 3600000,
      status: 'doing',
      planned_at: null,
      planned_end_at: null,
      all_day: false,
      location: ''
    }
  })
  assert.ok(saved.task)
  const latest = getAssignment(a.id)
  assert.equal(latest.task.title, '日程里改名')
  assert.equal(latest.task.status, 'doing')
  assert.notEqual(latest.revision, a.revision)
  assert.equal(latest.history[0].action, 'task-edit')
  assert.equal(JSON.parse(latest.history[0].before_json).title, a.task.title)
  assert.equal(
    getDb().prepare('SELECT title FROM assignments WHERE id=?').get(a.id).title,
    '日程里改名'
  )
  assert.throws(() => save(a), /已变化/)
  assert.throws(() => archive(a), /已变化/)
  assert.throws(
    () =>
      saveCalendarTask({
        id: a.task.id,
        expected_assignment_revision: a.revision,
        task: { title: '旧日程修改' }
      }),
    /作业已变化/
  )
  updateTask(a.task.id, { status: 'done' })
  assert.equal(getAssignment(a.id).task.status, 'done')
  assert.equal(
    list({ scope: 'open' }).items.some((x) => x.id === a.id),
    false
  )
})

await test('回收清除固定时间、锁定时间块和有效提醒；恢复相同任务与要求但不复活原时间块', () => {
  let a = saveAssignment(input({ due_at: Date.now() + 1800000 }))
  const db = getDb(),
    start = Date.now() + 3600000
  db.prepare('INSERT INTO schedule_blocks VALUES(?,?,?,?,?,?,?)').run(
    'assignment-block',
    a.task.id,
    start,
    start + 600000,
    1,
    'block-revision',
    '手工锁定'
  )
  reconcileReminders()
  assert.ok(
    db
      .prepare('SELECT count(*) AS n FROM reminders WHERE task_id=?')
      .get(a.task.id).n > 0
  )
  const oldId = a.task.id
  a = archive(a)
  assert.ok(a.deleted_at !== null)
  assert.equal(a.task.status, 'done')
  assert.equal(a.task.planned_at, null)
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM schedule_blocks WHERE task_id=?')
      .get(oldId).n,
    0
  )
  assert.equal(
    listAllTasks().some((t) => t.id === oldId),
    false
  )
  assert.equal(
    list({ scope: 'trash' }).items.some((t) => t.id === a.id),
    true
  )
  const history = a.history.find((h) => h.action === 'trash')
  assert.equal(JSON.parse(history.before_json).blocks[0].locked, 1)
  assert.throws(() => updateTask(oldId, { status: 'open' }), /回收站/)
  assert.throws(
    () => db.prepare("UPDATE tasks SET title='stale' WHERE id=?").run(oldId),
    /回收站/
  )
  assert.throws(() => save(a), /回收站/)
  assert.throws(() => removeTask(oldId), /回收站/)
  assert.throws(
    () => db.prepare('DELETE FROM tasks WHERE id=?').run(oldId),
    /不能直接删除/
  )
  reconcileReminders()
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM reminders WHERE task_id=? AND status IN ('pending','published','snoozed')"
      )
      .get(oldId).n,
    0
  )
  a = archive(a, false)
  assert.equal(a.task.id, oldId)
  assert.equal(a.deleted_at, null)
  assert.equal(a.task.status, 'open')
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM schedule_blocks WHERE task_id=?')
      .get(oldId).n,
    0
  )
  assert.ok(listAllTasks().some((t) => t.id === oldId))
  updateTask(oldId, { planned_at: start, planned_end_at: start + 600000 })
  a = getAssignment(a.id)
  a = archive(archive(a), false)
  assert.equal(a.task.planned_at, null)
  assert.equal(a.task.planned_end_at, null)
})

await test('保存/回收过程中故障，任务、历史、学科、锁和内部写入标志一同回滚，可重试', () => {
  const a = saveAssignment(input()),
    db = getDb(),
    before = getAssignment(a.id)
  db.exec(
    "CREATE TRIGGER fail_assignment_history BEFORE INSERT ON assignment_history BEGIN SELECT RAISE(ABORT,'injected assignment failure'); END"
  )
  try {
    assert.throws(() => save(a, { title: '不应保存' }), /injected/)
    assert.throws(() => archive(a), /injected/)
    assert.deepEqual(getAssignment(a.id), before)
    assert.equal(
      db
        .prepare('SELECT writing FROM assignment_links WHERE assignment_id=?')
        .get(a.id).writing,
      0
    )
    const count = db.prepare('SELECT count(*) AS n FROM tasks').get().n
    assert.throws(() => saveAssignment(input()), /injected/)
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, count)
  } finally {
    db.exec('DROP TRIGGER fail_assignment_history')
  }
  assert.equal(save(a, { title: '重试成功' }).task.title, '重试成功')
})

await test('学科删除不丢作业、来源与历史，并拒绝未获知变化的草稿；重启版本稳定', () => {
  const db = getDb()
  db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?)').run(
    'remove-subject',
    '待删科目',
    '#123456',
    '',
    Date.now()
  )
  const a = saveAssignment(input({ subject_id: 'remove-subject' }))
  db.prepare('DELETE FROM subjects WHERE id=?').run('remove-subject')
  const updated = getAssignment(a.id)
  assert.equal(updated.subject_id, null)
  assert.notEqual(updated.revision, a.revision)
  assert.equal(updated.history[0].action, 'subject-edit')
  assert.throws(() => save(a), /已变化|学科不存在/)
  closeDb()
  assert.deepEqual(getAssignment(a.id), updated)
  assert.equal(getDb().pragma('foreign_key_check').length, 0)
})

await test('筛选/搜索与50项分页互补，截止排序优先；过期按真实时刻而非日期判断', () => {
  const now = Date.now()
  for (let i = 0; i < 53; i++)
    saveAssignment(
      input({
        title: '分页作业 ' + i,
        due_at: i ? now + i * 60000 : now - 1000,
        detail: '检索短语%',
        status: i === 52 ? 'done' : 'open'
      })
    )
  const first = list({ query: '分页作业' }),
    second = list({ query: '分页作业', offset: 50 })
  assert.equal(first.total, 53)
  assert.equal(first.items.length, 50)
  assert.equal(second.items.length, 3)
  assert.equal(
    new Set([...first.items, ...second.items].map((a) => a.id)).size,
    53
  )
  assert.equal(list({ query: '分页作业', scope: 'overdue' }).total, 1)
  assert.equal(list({ query: '分页作业', scope: 'open' }).total, 52)
  assert.equal(list({ query: '检索短语%' }).total, 53)
  assert.equal(list({ query: '分页作业', subject_id: 'old-subject' }).total, 0)
})

await test('IPC 严格拒绝额外来源/身份字段、无版本编辑、坏时间和空名称，普通任务行为不受影响', async () => {
  for (const patch of [
    { title: '' },
    { due_at: -1 },
    { source: 'learn' },
    { task_id: 'other' },
    { status: 'unknown' }
  ]) {
    assert.equal((await invoke('assignments:save', input(patch))).ok, false)
  }
  const a = saveAssignment(input())
  assert.equal(
    (await invoke('assignments:save', input({ id: a.id }))).ok,
    false
  )
  assert.equal(
    (
      await invoke('assignments:archive', {
        id: a.id,
        expected_revision: a.revision,
        archived: true,
        extra: true
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('assignments:list', {
        scope: 'all',
        query: '',
        offset: 0,
        extra: true
      })
    ).ok,
    false
  )
  assert.throws(
    () => saveAssignment(input({ due_at: 8640000000000001 })),
    /时间无效/
  )
  assert.throws(
    () => saveAssignment(input({ subject_id: 'absent' })),
    /学科不存在/
  )
  assert.throws(() => saveAssignment(input({ status: 'blocked' })), /困难/)
  const task = createTask({ title: '独立手动任务' })
  assert.ok(listManualTasks().some((t) => t.id === task.id))
  removeTask(task.id)
  assert.equal(
    listAllTasks().some((t) => t.id === task.id),
    false
  )
})
