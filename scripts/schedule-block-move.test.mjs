import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { createTask, updateTask } from '../src/main/services/projects.ts'
import {
  moveScheduleBlock,
  getPlanningState,
  undoSchedule
} from '../src/main/services/auto-schedule.ts'
import {
  continuousScheduleState,
  saveContinuousSchedule
} from '../src/main/services/continuous-schedule.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { invoke } from './test-support.mjs'
registerAllIpc()
after(closeDb)
const day = () => {
  const d = new Date()
  d.setDate(d.getDate() + 3)
  d.setHours(0, 0, 0, 0)
  return +d
}
const hour = (n) => day() + n * 3600000
let task, block
beforeEach(() => {
  getDb().exec(
    'DELETE FROM schedule_runs; DELETE FROM tasks; DELETE FROM schedule_settings; DELETE FROM schedule_automation;'
  )
  task = createTask({ title: '学习任务', due_at: hour(20) })
  block = {
    id: 'block',
    task_id: task.id,
    start_at: hour(9),
    end_at: hour(10),
    locked: false,
    revision: 'original',
    reason: '自动安排'
  }
  getDb()
    .prepare(
      'INSERT INTO schedule_blocks VALUES(@id,@task_id,@start_at,@end_at,@locked,@revision,@reason)'
    )
    .run({ ...block, locked: 0 })
})
const proposal = (extra = {}) => ({
  id: block.id,
  expected_revision: block.revision,
  start_at: hour(11),
  end_at: hour(12),
  ...extra
})
const inspect = (extra) => moveScheduleBlock(proposal(extra))
const confirm = (extra = {}) => {
  const input = proposal(extra),
    r = moveScheduleBlock(input)
  return moveScheduleBlock({
    ...input,
    confirmation: {
      ignore_conflicts: true,
      conflict_fingerprint: r.report.conflicts.fingerprint
    }
  })
}
test('检查不写入；半开区间相接无冲突，同任务其他块也检查，未同意冲突不保存', () => {
  createTask({
    title: '相接课程',
    planned_at: hour(12),
    planned_end_at: hour(13)
  })
  assert.equal(inspect().report.conflicts.items.length, 0)
  getDb()
    .prepare('INSERT INTO schedule_blocks VALUES(?,?,?,?,?,?,?)')
    .run('other', task.id, hour(11.5), hour(12.5), 0, 'r', '')
  const preview = inspect()
  assert.equal(preview.state, null)
  assert.equal(preview.report.conflicts.items.length, 1)
  assert.deepEqual(
    getPlanningState().blocks.find((b) => b.id === 'block'),
    block
  )
  const rejected = moveScheduleBlock({
    ...proposal(),
    confirmation: {
      ignore_conflicts: false,
      conflict_fingerprint: preview.report.conflicts.fingerprint
    }
  })
  assert.equal(rejected.state, null)
  assert.equal(continuousScheduleState().history.length, 0)
  assert.ok(confirm().state)
})
test('非法时间、过去/已开始时间块、已完成任务被拒绝；原块和任务保留', () => {
  for (const extra of [
    { start_at: NaN },
    { end_at: Infinity },
    { start_at: 0 },
    { end_at: hour(11) },
    { end_at: hour(11) + 1000 },
    { end_at: hour(36) }
  ])
    assert.throws(() => inspect(extra), /有效起止/)
  getDb()
    .prepare('UPDATE schedule_blocks SET start_at=? WHERE id=?')
    .run(Date.now() - 1000, block.id)
  assert.throws(() => inspect(), /已开始/)
  getDb()
    .prepare('UPDATE schedule_blocks SET start_at=? WHERE id=?')
    .run(block.start_at, block.id)
  updateTask(task.id, { status: 'done' })
  assert.throws(() => inspect(), /已完成/)
  assert.deepEqual(getPlanningState().blocks, [block])
})
test('确认绑定完整快照、原块修订和新时间；冲突变化不能沿用同意', () => {
  const preview = inspect(),
    confirmation = {
      ignore_conflicts: true,
      conflict_fingerprint: preview.report.conflicts.fingerprint
    }
  assert.throws(
    () =>
      moveScheduleBlock({ ...proposal({ end_at: hour(13) }), confirmation }),
    /已改变/
  )
  const course = createTask({
    title: '新增冲突课程',
    planned_at: hour(11),
    planned_end_at: hour(12)
  })
  assert.throws(
    () => moveScheduleBlock({ ...proposal(), confirmation }),
    /已改变/
  )
  assert.throws(() => inspect({ expected_revision: 'stale' }), /已变化/)
  assert.equal(getPlanningState().blocks[0].revision, 'original')
  assert.equal(course.planned_at, hour(11))
})
test('移动保留块身份并锁定，历史显示移出和移入；撤销原子恢复并暂停持续排程', () => {
  saveContinuousSchedule({ revision: null, enabled: true, horizon_days: 3 })
  const next = confirm().state
  assert.equal(next.blocks[0].id, block.id)
  assert.equal(next.blocks[0].locked, true)
  assert.equal(next.blocks[0].start_at, hour(11))
  assert.equal(
    getDb().prepare('SELECT due_at FROM tasks WHERE id=?').get(task.id).due_at,
    task.due_at
  )
  const history = continuousScheduleState().history[0]
  assert.equal(history.added.length, 1)
  assert.equal(history.removed.length, 1)
  assert.equal(history.added[0].id, history.removed[0].id)
  assert.equal(history.removed[0].revision, 'original')
  const restored = undoSchedule(next.latest_run.id)
  assert.deepEqual(restored.blocks, [block])
  assert.equal(continuousScheduleState().settings.enabled, false)
})
test('记录故障使块更新、历史与变更序列一同回滚，可重新检查重试', () => {
  const before = getDb()
    .prepare('SELECT seq FROM schedule_change_counter')
    .get().seq
  getDb().exec(
    "CREATE TRIGGER move_failure BEFORE INSERT ON schedule_runs BEGIN SELECT RAISE(ABORT,'move failure'); END;"
  )
  try {
    assert.throws(() => confirm(), /move failure/)
  } finally {
    getDb().exec('DROP TRIGGER move_failure')
  }
  assert.deepEqual(getPlanningState().blocks, [block])
  assert.equal(continuousScheduleState().history.length, 0)
  assert.equal(
    getDb().prepare('SELECT seq FROM schedule_change_counter').get().seq,
    before
  )
  assert.equal(confirm().state.blocks[0].locked, true)
})
test('截止、最早开始、依赖和时长警告可见；检查不修改任务剩余用时', () => {
  const dep = createTask({ title: '前置学习' })
  getDb()
    .prepare('INSERT INTO task_planning VALUES(?,?,?)')
    .run(
      task.id,
      'p',
      JSON.stringify({
        enabled: true,
        remaining_minutes: 60,
        not_before: hour(15),
        priority: 1,
        splittable: true,
        min_minutes: 25,
        max_minutes: 60
      })
    )
  getDb()
    .prepare('INSERT INTO task_dependencies VALUES(?,?)')
    .run(task.id, dep.id)
  const report = inspect({ start_at: hour(14), end_at: hour(21) }).report
  const warnings = report.warnings.join(' ')
  assert.match(warnings, /晚于任务截止/)
  assert.match(warnings, /早于任务最早/)
  assert.match(warnings, /前置任务/)
  assert.match(warnings, /时长已改变/)
  assert.equal(
    JSON.parse(
      getDb().prepare('SELECT options_json FROM task_planning').get()
        .options_json
    ).remaining_minutes,
    60
  )
})
test('同时间确认无变更不生成历史；非法 IPC 不写入', async () => {
  assert.equal(
    confirm({ start_at: block.start_at, end_at: block.end_at }).state
      .latest_run,
    null
  )
  assert.deepEqual(getPlanningState().blocks, [block])
  for (const input of [
    { ...proposal(), unknown: true },
    { ...proposal(), start_at: NaN },
    {
      ...proposal(),
      confirmation: { ignore_conflicts: 'yes', conflict_fingerprint: 'bad' }
    }
  ])
    assert.equal((await invoke('planning:moveBlock', input)).ok, false)
  assert.equal((await invoke('planning:moveBlock', proposal())).ok, true)
  assert.deepEqual(getPlanningState().blocks, [block])
})
