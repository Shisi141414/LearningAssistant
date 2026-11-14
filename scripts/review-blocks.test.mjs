import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { saveConcept } from '../src/main/services/concepts.ts'
import {
  addReview,
  gradeReview,
  revealReview,
  actOnReview,
  getReview
} from '../src/main/services/reviews.ts'
import {
  reviewPlanningState,
  saveReviewPlanning,
  reviewPlanningProjection
} from '../src/main/services/review-planning.ts'
import {
  getPlanningState,
  moveScheduleBlock
} from '../src/main/services/auto-schedule.ts'
import { planSchedule, defaultTaskPlanning } from '../shared/auto-schedule.ts'
import { reconcileReminders } from '../src/main/services/reminders.ts'
let now = Date.now(),
  seq = 0
const originalNow = Date.now
const test = (name, fn) =>
  nodeTest(name, async () => {
    Date.now = () => now
    try {
      await fn()
    } finally {
      Date.now = originalNow
    }
  })
registerAllIpc()
const fixture = async () => {
  const c = saveConcept({
    name: '复习安排' + ++seq,
    summary: '冲量等于动量的变化',
    subject_id: null,
    aliases: []
  })
  const r = await addReview({
    kind: 'concept',
    source_id: c.id,
    expected_source_revision: String(c.revision)
  })
  return { c, r }
}
const save = (r, patch = {}) => {
  const p = reviewPlanningState(r.id)
  return saveReviewPlanning({
    id: r.id,
    expected_revision: p.revision,
    expected_card_revision: p.card_revision,
    enabled: true,
    duration_minutes: 10,
    priority: 1,
    ...patch
  })
}
const reserve = (r, { locked = true, start = now + 3600000 } = {}) => {
  const p = reviewPlanningState(r.id),
    id = 'review-block-' + ++seq
  getDb()
    .prepare('INSERT INTO schedule_blocks VALUES(?,?,?,?,?,?,?)')
    .run(
      id,
      r.task_id,
      start,
      start + 600000,
      Number(locked),
      'rev-' + seq,
      '原安排'
    )
  getDb()
    .prepare('INSERT INTO review_block_cycles VALUES(?,?,?)')
    .run(id, r.id, p.cycle)
  return id
}
const rate = async (r) =>
  gradeReview({
    token: (await revealReview({ id: r.id, expected_revision: r.revision }))
      .token,
    grade: 3
  })
await test('v32→33 故障回滚、修复重试，既有复习与任务记录原样保留', () => {
  let db = new Database(join(dataRoot, 'learning-assistant.db'))
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 32)) db.exec(m.sql)
  db.pragma('user_version=32')
  db.exec(
    `INSERT INTO tasks(id,title,created_at,updated_at) VALUES('old-task','原任务',1,1);INSERT INTO review_records VALUES('old-record','concept','old-source','{"legacy":true}',123);CREATE TABLE review_block_history(id TEXT);`
  )
  db.exec(`
    INSERT INTO review_cards VALUES('v32-card','concept','old-source','source-revision','{"answer":"保留固定答案"}','旧卡片',NULL,'old-revision',1,'{"model":"preserve-opaque-state"}',123,'old-task',1,2);
    INSERT INTO review_logs VALUES('v32-log','v32-card','grade',3,'{"before":true}','old-revision',123,'source-revision','{"answer":"评分当时的答案"}','{"elapsed":2}',2,0);
    INSERT INTO review_attempts VALUES('v32-attempt','v32-card','previous-revision',200,'v32-log',3);
  `)
  const retained = [
    'tasks',
    'review_cards',
    'review_logs',
    'review_attempts',
    'review_records'
  ]
  const before = Object.fromEntries(
    retained.map((table) => [table, db.prepare('SELECT * FROM ' + table).all()])
  )
  db.close()
  assert.throws(() => getDb(), /already exists/)
  db = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(db.pragma('user_version', { simple: true }), 32)
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name='review_planning'")
      .get(),
    undefined
  )
  db.exec('DROP TABLE review_block_history')
  db.close()
  assert.equal(getDb().pragma('user_version', { simple: true }), 33)
  for (const table of retained)
    assert.deepEqual(
      getDb()
        .prepare('SELECT * FROM ' + table)
        .all(),
      before[table]
    )
  assert.equal(reviewPlanningState('v32-card').enabled, false)
  assert.equal(getDb().pragma('foreign_key_check').length, 0)
  assert.equal(
    getDb().prepare('SELECT fsrs_state_json FROM review_records').get()
      .fsrs_state_json,
    '{"legacy":true}'
  )
  assert.equal(getDb().prepare('SELECT title FROM tasks').get().title, '原任务')
})
await test('明确启用，单一复习配置投影为统一规划选项；陈旧/非法配置拒绝', async () => {
  const { r } = await fixture(),
    empty = reviewPlanningState(r.id)
  assert.equal(empty.enabled, false)
  assert.equal(empty.revision, null)
  const p = save(r)
  assert.ok(p.cycle)
  assert.equal(
    reviewPlanningProjection().find((x) => x.task_id === r.task_id).not_before,
    r.due_at
  )
  assert.equal(
    getPlanningState().planning.find((x) => x.task_id === r.task_id).splittable,
    false
  )
  assert.equal(
    getDb()
      .prepare('SELECT count(*) AS n FROM task_planning WHERE task_id=?')
      .get(r.task_id).n,
    0
  )
  assert.throws(
    () =>
      saveReviewPlanning({
        id: r.id,
        expected_revision: null,
        expected_card_revision: r.revision,
        enabled: true,
        duration_minutes: 10,
        priority: 1
      }),
    /已变化/
  )
  assert.equal(
    (
      await invoke('reviews:planning-save', {
        id: r.id,
        expected_revision: p.revision,
        expected_card_revision: r.revision,
        enabled: true,
        duration_minutes: 7,
        priority: 1
      })
    ).ok,
    false
  )
})
const settings = {
  timezone: 'Asia/Shanghai',
  availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    start: '08:00',
    end: '22:00'
  })),
  daily_minutes: 120,
  buffer_minutes: 0
}
const day = Date.parse('2026-11-16T00:00:00+08:00'),
  at = (h) => day + h * 3600000
const task = (id, extra = {}) => ({
  id,
  title: id,
  status: 'open',
  project_status: null,
  due_at: at(10),
  planned_at: null,
  planned_end_at: null,
  all_day: false,
  ...extra
})
const p = (id, extra = {}) => ({
  ...defaultTaskPlanning(id),
  revision: 'p',
  enabled: true,
  remaining_minutes: 10,
  min_minutes: 10,
  max_minutes: 10,
  splittable: false,
  ...extra
})
await test('复习建议时间是硬最早开始、软排序；普通任务仍须截止前完成并避让课程', () => {
  const input = {
    settings,
    tasks: [
      task('review', {
        due_at: at(14),
        review_due_at: at(14),
        review_cycle: 'cycle'
      }),
      task('deadline'),
      task('course', { planned_at: at(8), planned_end_at: at(9) })
    ],
    planning: [p('review', { not_before: at(14) }), p('deadline')],
    blocks: [],
    from: day,
    to: day + 86400000,
    now: day
  }
  const result = planSchedule(input)
  assert.equal(result.unplaced.length, 0)
  assert.ok(result.added.find((b) => b.task_id === 'review').start_at >= at(14))
  assert.equal(
    result.added.find((b) => b.task_id === 'review').review_cycle,
    'cycle'
  )
  const hard = result.added.find((b) => b.task_id === 'deadline')
  assert.ok(hard.start_at >= at(9) && hard.end_at <= at(10))
  assert.equal(
    planSchedule({
      ...input,
      settings: { ...settings, availability: [] }
    }).unplaced.some((x) => x.task_id === 'review'),
    true
  )
})
await test('已到期复习不能抢占硬截止任务唯一的可用时段', () => {
  const result = planSchedule({
    settings,
    tasks: [
      task('review', {
        due_at: at(8),
        review_due_at: at(8),
        review_cycle: 'round'
      }),
      task('deadline')
    ],
    planning: [
      p('review', { not_before: at(8) }),
      p('deadline', { remaining_minutes: 60, min_minutes: 60, max_minutes: 60 })
    ],
    blocks: [],
    from: at(9),
    to: day + 86400000,
    now: day
  })
  assert.equal(result.unplaced.length, 0)
  assert.equal(
    result.added.find((b) => b.task_id === 'deadline').start_at,
    at(9)
  )
  assert.ok(result.added.find((b) => b.task_id === 'review').start_at >= at(10))
})
await test('时间块已过不算评分，也不逐轮重复生成；锁定块保持，未锁定块可重排', () => {
  const block = {
    id: 'b',
    task_id: 'r',
    start_at: at(9),
    end_at: at(9) + 600000,
    locked: true,
    revision: 'b',
    reason: 'test',
    review_cycle: 'cycle'
  }
  const input = {
    settings,
    tasks: [
      task('r', { due_at: at(8), review_due_at: at(8), review_cycle: 'cycle' })
    ],
    planning: [p('r')],
    blocks: [block],
    from: day,
    to: day + 86400000,
    now: at(11)
  }
  const out = planSchedule(input)
  assert.equal(out.added.length, 0)
  assert.equal(out.removed.length, 0)
  const future = { ...block, start_at: at(14), end_at: at(14) + 600000 }
  assert.equal(planSchedule({ ...input, blocks: [future] }).added.length, 0)
  const outside = planSchedule({
    ...input,
    blocks: [
      {
        ...future,
        start_at: at(14) + 2 * 86400000,
        end_at: at(14) + 2 * 86400000 + 600000
      }
    ]
  })
  assert.equal(outside.added.length, 0)
  assert.equal(outside.removed.length, 0)
  assert.equal(
    outside.unplaced.length,
    0,
    '滚动范围不是复习截止；范围外的同轮锁定块仍有效'
  )
  const unlocked = planSchedule({
    ...input,
    blocks: [{ ...future, locked: false }]
  })
  assert.equal(unlocked.removed.length, 1)
  assert.equal(unlocked.added.length, 1)
})
await test('评分原子结束锁定/未锁定旧轮次并留历史，下一轮继承用时；撤销不复活旧锁', async () => {
  let { r } = await fixture()
  const initial = save(r, { duration_minutes: 15 })
  const b = reserve(r)
  const after = await rate(r),
    next = reviewPlanningState(r.id)
  assert.notEqual(next.cycle, initial.cycle)
  assert.equal(next.blocks.length, 0)
  assert.equal(next.duration_minutes, 15)
  assert.equal(next.history[0].blocks[0].id, b)
  assert.equal(next.history[0].blocks[0].locked, true)
  assert.equal(
    reviewPlanningProjection().find((p) => p.task_id === r.task_id).not_before,
    after.due_at
  )
  const undone = actOnReview({
    id: r.id,
    expected_revision: after.revision,
    action: 'undo'
  })
  assert.equal(undone.reps, 0)
  assert.equal(reviewPlanningState(r.id).blocks.length, 0)
  assert.equal(reviewPlanningState(r.id).history.length, 1)
  assert.equal(
    getDb()
      .prepare('SELECT count(*) AS n FROM review_block_cycles WHERE block_id=?')
      .get(b).n,
    0
  )
})
await test('归档故障连同模型评分/任务/旧锁完整回滚，不发布半轮次', async () => {
  const { r } = await fixture(),
    p = save(r),
    b = reserve(r)
  const reveal = await revealReview({ id: r.id, expected_revision: r.revision })
  getDb().exec(
    "CREATE TRIGGER review_archive_fault BEFORE INSERT ON review_block_history BEGIN SELECT RAISE(ABORT,'archive fault'); END"
  )
  await assert.rejects(
    gradeReview({ token: reveal.token, grade: 3 }),
    /archive fault/
  )
  assert.equal(getReview(r.id).reps, 0)
  assert.equal(reviewPlanningState(r.id).cycle, p.cycle)
  assert.equal(reviewPlanningState(r.id).blocks[0].id, b)
  getDb().exec('DROP TRIGGER review_archive_fault')
  assert.equal((await gradeReview({ token: reveal.token, grade: 3 })).reps, 1)
})
await test('暂停、禁用配置、删除来源均关闭本轮并使持久块提醒失效；恢复不造已完成记录', async () => {
  const { c, r } = await fixture()
  save(r)
  reserve(r)
  const paused = actOnReview({
    id: r.id,
    expected_revision: r.revision,
    action: 'pause'
  })
  assert.equal(reviewPlanningState(r.id).blocks.length, 0)
  const restored = actOnReview({
    id: r.id,
    expected_revision: paused.revision,
    action: 'resume'
  })
  reserve(restored)
  save(restored, { enabled: false })
  assert.equal(reviewPlanningState(r.id).blocks.length, 0)
  assert.equal(reviewPlanningState(r.id).history.length, 2)
  save(restored)
  const b = reserve(restored)
  reconcileReminders(now)
  getDb().prepare('DELETE FROM knowledge_points WHERE id=?').run(c.id)
  reconcileReminders(now)
  assert.equal(reviewPlanningState(r.id).active, false)
  assert.equal(reviewPlanningState(r.id).blocks.length, 0)
  assert.equal(
    getDb()
      .prepare(
        "SELECT id FROM reminders WHERE source_id=? AND status NOT IN ('cancelled','expired')"
      )
      .get(b),
    undefined
  )
  assert.equal(getReview(r.id).reps, 0)
})
await test('人工移动不能早于复习时间，即使尝试忽略冲突；历史和当前轮次重启保留', async () => {
  const { r } = await fixture(),
    learned = await rate(r)
  save(learned)
  const b = reserve(learned, { start: learned.due_at + 3600000 }),
    before = reviewPlanningState(r.id)
  assert.throws(
    () =>
      moveScheduleBlock({
        id: b,
        expected_revision: before.blocks[0].revision,
        start_at: now + 3600000,
        end_at: now + 4200000,
        confirmation: { ignore_conflicts: true, conflict_fingerprint: 'forged' }
      }),
    /不能把复习/
  )
  closeDb()
  assert.deepEqual(reviewPlanningState(r.id), before)
  assert.equal(getDb().pragma('foreign_key_check').length, 0)
})
