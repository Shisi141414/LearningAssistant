import { saveTaskPlanning } from '../src/main/services/auto-schedule.ts'
import { defaultTaskPlanning } from '../shared/auto-schedule.ts'
import { exerciseTexts } from '../shared/exercises.ts'
import { test as nodeTest, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { DefaultScheduler } from 'ts-fsrs'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import {
  addReview,
  getReview,
  listReviews,
  revealReview,
  gradeReview,
  actOnReview
} from '../src/main/services/reviews.ts'
import { saveConcept } from '../src/main/services/concepts.ts'
import {
  saveExercise,
  getExercise,
  trashExercise
} from '../src/main/services/exercises.ts'
import {
  updateTask,
  removeTask,
  listAllTasks,
  listManualTasks
} from '../src/main/services/projects.ts'
import { saveCalendarTask } from '../src/main/services/calendar.ts'
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
after(() => {
  Date.now = originalNow
  closeDb()
})
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
const addConcept = async () => {
  const c = saveConcept({
    name: '记忆概念' + ++seq,
    summary: '动量定理：合外力的冲量等于动量的变化。',
    subject_id: null,
    aliases: ['动量原理' + seq]
  })
  return {
    c,
    r: await addReview({
      kind: 'concept',
      source_id: c.id,
      expected_source_revision: String(c.revision)
    })
  }
}
const action = (r, action) =>
  actOnReview({ id: r.id, expected_revision: r.revision, action })
const raw = (id) =>
  getDb().prepare('SELECT * FROM review_cards WHERE id=?').get(id)
const grade = async (r, value) =>
  gradeReview({
    token: (await revealReview({ id: r.id, expected_revision: r.revision }))
      .token,
    grade: value
  })
const exercise = () =>
  saveExercise({
    title: '动量练习' + ++seq,
    subject_id: null,
    status: 'wrong',
    question_type: '计算',
    source_label: '教材第2题',
    no_idea: false,
    review_concept_ids: [],
    fields: {
      statement: '质量 $m$ 的物体速度增加 $v$，求冲量。',
      approach: '由动量定理求解。',
      standard_answer: '$mv$',
      user_answer: '$m+v$',
      error_reason: '混淆量纲。'
    }
  })

await test('真实 v31→32 失败回滚、重试，旧复习状态/任务/关联原样保留', () => {
  let old = new Database(join(dataRoot, 'learning-assistant.db'))
  old.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 31)) old.exec(m.sql)
  old.pragma('user_version=31')
  old.exec(`INSERT INTO review_records VALUES('legacy','concept','old','{"unknown":true}',123);
    INSERT INTO tasks(id,title,created_at,updated_at) VALUES('existing','原任务',1,1);
    INSERT INTO calendar_import_receipts VALUES('ics-key','existing',1);
    CREATE TABLE review_logs(id TEXT);`)
  old.close()
  assert.throws(() => getDb(), /already exists/)
  old = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(old.pragma('user_version', { simple: true }), 31)
  assert.equal(
    old
      .prepare("SELECT name FROM sqlite_master WHERE name='review_cards'")
      .get(),
    undefined
  )
  old.exec('DROP TABLE review_logs')
  old.close()
  assert.equal(getDb().pragma('user_version', { simple: true }), 32)
  assert.equal(
    getDb().prepare('SELECT task_id FROM calendar_import_receipts').get()
      .task_id,
    'existing'
  )
  assert.equal(
    getDb().prepare('SELECT fsrs_state_json FROM review_records').get()
      .fsrs_state_json,
    '{"unknown":true}'
  )
  assert.equal(listReviews({ scope: 'today', offset: 0 }).legacy_count, 1)
})
await test('知识点固定版本/别名、幂等加入；拒绝空释义与陈旧来源', async () => {
  const { c, r } = await addConcept()
  assert.equal(r.snapshot.answer, c.summary)
  assert.deepEqual(r.snapshot.aliases, c.aliases)
  assert.equal(
    (
      await addReview({
        kind: 'concept',
        source_id: c.id,
        expected_source_revision: String(c.revision)
      })
    ).id,
    r.id
  )
  await assert.rejects(
    addReview({
      kind: 'concept',
      source_id: c.id,
      expected_source_revision: 'wrong'
    }),
    /来源已修改/
  )
  const empty = saveConcept({
    name: '空' + ++seq,
    summary: '',
    subject_id: null,
    aliases: []
  })
  await assert.rejects(
    addReview({
      kind: 'concept',
      source_id: empty.id,
      expected_source_revision: String(empty.revision)
    }),
    /填写释义/
  )
  assert.equal(
    getDb().prepare('SELECT count(*) AS n FROM tasks WHERE id=?').get(r.task_id)
      .n,
    1
  )
  assert.equal(listAllTasks().find((t) => t.id === r.task_id).review_id, r.id)
  assert.equal(
    listManualTasks().some((t) => t.id === r.task_id),
    false
  )
})
await test('习题沿用完整内置格式；评分不修改用户答案、对错、修订和来源', async () => {
  const e = exercise(),
    r = await addReview({
      kind: 'exercise',
      source_id: e.id,
      expected_source_revision: e.revision_id
    })
  assert.deepEqual(r.snapshot.exercise, e.snapshot)
  const after = await grade(r, 3)
  assert.equal(after.reps, 1)
  assert.deepEqual(getExercise({ id: e.id }), e)
  assert.equal(
    getDb().prepare('SELECT count(*) AS n FROM tasks WHERE id=?').get(r.task_id)
      .n,
    1
  )
  assert.equal(
    getDb().prepare('SELECT due_at FROM tasks WHERE id=?').get(r.task_id)
      .due_at,
    after.due_at
  )
})
await test('四档结果与开源 FSRS-7 逐项一致，保存真实复习时间和算法日志', async () => {
  const s = await DefaultScheduler({
    version: 'FSRS-7',
    desiredRetention: 0.9,
    enableShortTerm: true,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    enableFuzz: false,
    maximumInterval: 36500
  })
  for (const value of [1, 2, 3, 4]) {
    const { r } = await addConcept(),
      before = raw(r.id),
      card = JSON.parse(before.scheduler_json).card
    card.dueAt = new Date(card.dueAt)
    card.lastReviewAt = null
    const expected = s.review({ card, grade: value, now: new Date(now) })
    const shown = await revealReview({
      id: r.id,
      expected_revision: r.revision
    })
    assert.equal(
      shown.choices.find((c) => c.grade === value).due_at,
      expected.card.dueAt.getTime()
    )
    const actual = await gradeReview({ token: shown.token, grade: value })
    assert.deepEqual(
      JSON.parse(raw(r.id).scheduler_json).card,
      JSON.parse(JSON.stringify(expected.card))
    )
    const log = getDb()
      .prepare('SELECT * FROM review_logs WHERE card_id=?')
      .get(r.id)
    assert.deepEqual(
      JSON.parse(log.scheduler_log_json),
      JSON.parse(JSON.stringify(expected.revlog))
    )
    assert.equal(actual.reps, 1)
  }
})
await test('Forgot 为分钟级学习；到期限制、迟到按实际时间评分、重复请求只写一次', async () => {
  let { r } = await addConcept()
  const reveal = await revealReview({ id: r.id, expected_revision: r.revision })
  now += 120000 // actual submission later than preview
  r = await gradeReview({ token: reveal.token, grade: 1 })
  assert.equal(r.due_at, now + 60000)
  assert.equal((await gradeReview({ token: reveal.token, grade: 1 })).reps, 1)
  await assert.rejects(
    gradeReview({ token: reveal.token, grade: 4 }),
    /此轮已评分/
  )
  await assert.rejects(
    revealReview({ id: r.id, expected_revision: r.revision }),
    /尚未到/
  )
  now = r.due_at
  r = await grade(r, 3)
  assert.equal(r.reps, 2)
})
await test('必须显示答案；失效/过期/暂停与来源回收后的旧评分不能发布', async () => {
  const { r } = await addConcept()
  await assert.rejects(
    gradeReview({ token: 'invented', grade: 3 }),
    /先显示答案/
  )
  const first = await revealReview({ id: r.id, expected_revision: r.revision })
  const second = await revealReview({ id: r.id, expected_revision: r.revision })
  await assert.rejects(
    gradeReview({ token: first.token, grade: 3 }),
    /先显示答案/
  )
  now += 31 * 60000
  await assert.rejects(
    gradeReview({ token: second.token, grade: 3 }),
    /三十分钟/
  )
  const third = await revealReview({ id: r.id, expected_revision: r.revision })
  action(r, 'pause')
  await assert.rejects(gradeReview({ token: third.token, grade: 3 }), /已变化/)
  assert.equal(getReview(r.id).reps, 0)
})
await test('评分与日程更新原子发布；任务写入失败回滚状态/日志/评分凭证', async () => {
  const { r } = await addConcept(),
    shown = await revealReview({ id: r.id, expected_revision: r.revision }),
    before = raw(r.id)
  getDb().exec(
    `CREATE TRIGGER review_fault BEFORE UPDATE ON tasks WHEN OLD.id='${r.task_id}' BEGIN SELECT RAISE(ABORT,'injected task failure'); END`
  )
  await assert.rejects(
    gradeReview({ token: shown.token, grade: 3 }),
    /injected task failure/
  )
  assert.deepEqual(raw(r.id), before)
  assert.equal(
    getDb()
      .prepare('SELECT count(*) AS n FROM review_logs WHERE card_id=?')
      .get(r.id).n,
    0
  )
  assert.equal(
    getDb()
      .prepare('SELECT log_id FROM review_attempts WHERE id=?')
      .get(shown.token).log_id,
    null
  )
  getDb().exec('DROP TRIGGER review_fault')
  assert.equal((await gradeReview({ token: shown.token, grade: 3 })).reps, 1)
})
await test('撤销恢复完整模型与原到期时间；后续内容操作使旧撤销失效，旧评分不重放', async () => {
  const { r } = await addConcept(),
    before = raw(r.id),
    shown = await revealReview({ id: r.id, expected_revision: r.revision })
  const after = await gradeReview({ token: shown.token, grade: 4 })
  assert.equal(after.can_undo, true)
  const undone = action(after, 'undo')
  assert.equal(raw(r.id).scheduler_json, before.scheduler_json)
  assert.equal(undone.due_at, r.due_at)
  assert.equal(undone.reps, 0)
  assert.equal(undone.history[1].undone, true)
  assert.equal((await gradeReview({ token: shown.token, grade: 4 })).reps, 0)
  assert.throws(() => action(undone, 'undo'), /最近一次/)
  const learned = await grade(undone, 3),
    paused = action(learned, 'pause')
  assert.equal(paused.can_undo, false)
  assert.throws(() => action(paused, 'undo'), /最近一次/)
})
await test('原题编辑只提示，明确采用新版保留模型与历史固定来源', async () => {
  const e = exercise(),
    r = await addReview({
      kind: 'exercise',
      source_id: e.id,
      expected_source_revision: e.revision_id
    })
  const learned = await grade(r, 3),
    saved = raw(r.id).scheduler_json
  const changed = saveExercise({
    id: e.id,
    expected_revision_id: e.revision_id,
    title: '新版题',
    subject_id: null,
    status: 'correct',
    question_type: '计算',
    source_label: '新版教材',
    no_idea: false,
    review_concept_ids: [],
    fields: { ...exerciseTexts(e.snapshot), standard_answer: '新的答案' }
  })
  assert.equal(getReview(r.id).source_changed, true)
  assert.equal(getReview(r.id).snapshot.title, e.snapshot.title)
  const adopted = action(learned, 'refresh')
  assert.equal(adopted.source_revision, changed.revision_id)
  assert.equal(raw(r.id).scheduler_json, saved)
  assert.equal(
    JSON.parse(
      getDb()
        .prepare(
          "SELECT source_snapshot_json FROM review_logs WHERE card_id=? AND action='grade'"
        )
        .get(r.id).source_snapshot_json
    ).title,
    e.snapshot.title
  )
})
await test('回收/恢复/彻底删除来源同步停用提醒，保留快照、进度及旧凭证保护', async () => {
  const e = exercise(),
    r = await addReview({
      kind: 'exercise',
      source_id: e.id,
      expected_source_revision: e.revision_id
    })
  const reveal = await revealReview({ id: r.id, expected_revision: r.revision })
  trashExercise({ id: e.id, expected_revision_id: e.revision_id })
  assert.equal(getReview(r.id).available, false)
  assert.equal(
    getDb().prepare('SELECT status FROM tasks WHERE id=?').get(r.task_id)
      .status,
    'done'
  )
  await assert.rejects(gradeReview({ token: reveal.token, grade: 3 }), /已变化/)
  getDb().prepare('UPDATE exercises SET deleted_at=NULL WHERE id=?').run(e.id)
  assert.equal(getReview(r.id).available, true)
  assert.equal(
    getDb().prepare('SELECT status FROM tasks WHERE id=?').get(r.task_id)
      .status,
    'open'
  )
  const { c, r: concept } = await addConcept()
  getDb().prepare('DELETE FROM knowledge_points WHERE id=?').run(c.id)
  assert.equal(getReview(concept.id).available, false)
  assert.equal(getReview(concept.id).snapshot.answer, c.summary)
  assert.equal(
    listReviews({ scope: 'paused', offset: 0 }).items.some(
      (x) => x.id === concept.id
    ),
    true
  )
})
await test('通用日程/任务入口不能绕过复习评分，手工任务仍可正常编辑', async () => {
  const { r } = await addConcept()
  assert.throws(() => updateTask(r.task_id, { status: 'done' }), /复习页/)
  assert.throws(() => removeTask(r.task_id), /复习页/)
  assert.throws(
    () =>
      saveCalendarTask({
        id: r.task_id,
        task: { title: '绕过', due_at: now + 1000 }
      }),
    /复习页/
  )
  assert.equal(updateTask('existing', { title: '正常修改' }).title, '正常修改')
  const invalid = await invoke('reviews:grade', { token: 'a', grade: true })
  assert.equal(invalid.ok, false)
  assert.equal(
    (
      await invoke('reviews:add', {
        kind: 'concept',
        source_id: 'x',
        expected_source_revision: 'x',
        now: 0
      })
    ).ok,
    false
  )
  assert.equal(
    (await invoke('reviews:list', { scope: 'all', offset: -1 })).ok,
    false
  )
})
await test('复习日程接入持久提醒：到期可见，暂停使旧提醒失效，恢复保留原到期时间', async () => {
  const { r } = await addConcept()
  reconcileReminders(now)
  assert.ok(
    getDb()
      .prepare(
        "SELECT id FROM reminders WHERE task_id=? AND status!='cancelled'"
      )
      .get(r.task_id)
  )
  const paused = action(r, 'pause')
  reconcileReminders(now)
  assert.equal(
    getDb()
      .prepare(
        "SELECT id FROM reminders WHERE task_id=? AND status!='cancelled'"
      )
      .get(r.task_id),
    undefined
  )
  const resumed = action(paused, 'resume')
  reconcileReminders(now)
  assert.equal(resumed.due_at, r.due_at)
})
await test('关闭重开数据库后复习状态、评分日志和未提交显示答案凭证可恢复', async () => {
  const { r } = await addConcept(),
    reveal = await revealReview({ id: r.id, expected_revision: r.revision }),
    before = raw(r.id)
  closeDb()
  assert.deepEqual(raw(r.id), before)
  const after = await gradeReview({ token: reveal.token, grade: 3 })
  closeDb()
  assert.equal(getReview(r.id).reps, after.reps)
  assert.equal(getReview(r.id).history[0].grade, 3)
  assert.equal(getDb().pragma('foreign_key_check').length, 0)
})

await test('队列按学科/本地日期筛选，分钟内未来条目保留但不能提前评分', async () => {
  const db = getDb(),
    subject = db.prepare('SELECT id FROM subjects LIMIT 1').get().id
  const c = saveConcept({
    name: '学科筛选' + ++seq,
    summary: '测试释义',
    subject_id: subject,
    aliases: []
  })
  let r = await addReview({
    kind: 'concept',
    source_id: c.id,
    expected_source_revision: String(c.revision)
  })
  assert.ok(
    listReviews({ scope: 'today', offset: 0, subject_id: subject }).items.some(
      (i) => i.id === r.id
    )
  )
  assert.equal(
    listReviews({ scope: 'all', offset: 0, subject_id: null }).items.some(
      (i) => i.id === r.id
    ),
    false
  )
  assert.equal(
    listAllTasks().find((t) => t.id === r.task_id).review_subject_id,
    subject
  )
  assert.equal(
    db
      .prepare(
        'SELECT due_lead_minutes FROM task_reminder_options WHERE task_id=?'
      )
      .get(r.task_id).due_lead_minutes,
    0
  )
  r = await grade(r, 1)
  const page = listReviews({ scope: 'today', offset: 0, subject_id: subject })
  assert.ok(page.items.some((i) => i.id === r.id))
  assert.equal(page.due_now, 0)
  await assert.rejects(
    revealReview({ id: r.id, expected_revision: r.revision }),
    /尚未到/
  )
})
await test('模型版本不兼容时不写状态，系统时间倒退不制造负间隔', async () => {
  let { r } = await addConcept()
  const saved = raw(r.id).scheduler_json,
    unknown = JSON.parse(saved)
  unknown.policy.library = 'unknown'
  getDb()
    .prepare('UPDATE review_cards SET scheduler_json=? WHERE id=?')
    .run(JSON.stringify(unknown), r.id)
  await assert.rejects(
    revealReview({ id: r.id, expected_revision: r.revision }),
    /版本不兼容/
  )
  assert.equal(
    getDb()
      .prepare('SELECT count(*) AS n FROM review_logs WHERE card_id=?')
      .get(r.id).n,
    0
  )
  getDb()
    .prepare('UPDATE review_cards SET scheduler_json=? WHERE id=?')
    .run(saved, r.id)
  r = await grade(r, 1)
  const before = raw(r.id)
  now -= 120000
  await assert.rejects(
    revealReview({ id: r.id, expected_revision: r.revision }),
    /尚未到|系统时间/
  )
  assert.deepEqual(raw(r.id), before)
  now += 120000
})

await test('复习不能被一次性时间块或依赖误当完成；学科删除只解除分类，不抹掉快照', async () => {
  const { r } = await addConcept()
  assert.throws(
    () =>
      saveTaskPlanning({ ...defaultTaskPlanning(r.task_id), enabled: true }),
    /复习时间/
  )
  assert.throws(
    () =>
      saveTaskPlanning({
        ...defaultTaskPlanning('existing'),
        dependencies: [r.task_id]
      }),
    /持续循环/
  )
  const db = getDb(),
    subject = 'review-subject-' + ++seq
  db.prepare('INSERT INTO subjects VALUES(?,?,?, ?,?)').run(
    subject,
    '复习分类',
    '#e1f2e9',
    '',
    now
  )
  const c = saveConcept({
    name: '独立学科概念' + ++seq,
    summary: '分类变动保留记忆',
    subject_id: subject,
    aliases: []
  })
  const card = await addReview({
    kind: 'concept',
    source_id: c.id,
    expected_source_revision: String(c.revision)
  })
  db.prepare('DELETE FROM subjects WHERE id=?').run(subject)
  const fresh = getReview(card.id)
  assert.equal(fresh.subject_id, null)
  assert.equal(fresh.snapshot.subject_id, subject)
  assert.equal(fresh.available, true)
  assert.equal(
    listAllTasks().find((t) => t.id === card.task_id).review_subject_id,
    null
  )
})
