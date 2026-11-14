import { DefaultScheduler, type DefaultSchedulerCard } from 'ts-fsrs'
import { nanoid } from 'nanoid'
import type {
  ReviewAction,
  ReviewDetail,
  ReviewGrade,
  ReviewKind,
  ReviewListInput,
  ReviewPage,
  ReviewReveal,
  ReviewSnapshot,
  ReviewSource,
  ReviewSummary
} from '@shared/reviews'
import { exerciseTexts } from '@shared/exercises'
import { getDb } from './db'
import { getExercise } from './exercises'
import { createTask } from './projects'

// Persist model + exact policy together; a library update must not silently reinterpret learned cards.
const options = {
  version: 'FSRS-7',
  desiredRetention: 0.9,
  enableShortTerm: true,
  learningSteps: ['1m', '10m'],
  relearningSteps: ['10m'],
  enableFuzz: false,
  maximumInterval: 36500
} as const
const policy = { schema: 1, library: 'ts-fsrs@6.0.0', options }
let pending: ReturnType<typeof DefaultScheduler<'FSRS-7'>> | undefined
function scheduler() {
  return (pending ??= DefaultScheduler({
    ...options,
    learningSteps: [...options.learningSteps],
    relearningSteps: [...options.relearningSteps]
  }).catch((error) => {
    pending = undefined
    throw error
  }))
}
interface Row {
  id: string
  kind: ReviewKind
  source_id: string
  source_revision: string
  snapshot_json: string
  title: string
  subject_id: string | null
  revision: string
  active: number
  scheduler_json: string
  due_at: number
  task_id: string
  created_at: number
  updated_at: number
}
function row(id: string): Row {
  const value = getDb()
    .prepare('SELECT * FROM review_cards WHERE id=?')
    .get(id) as Row | undefined
  if (!value) throw Error('复习条目不存在')
  return value
}
function sourceStatus(r: Pick<Row, 'kind' | 'source_id' | 'source_revision'>) {
  const source =
    r.kind === 'concept'
      ? getDb()
          .prepare(
            'SELECT CAST(revision AS TEXT) AS revision,NULL AS deleted FROM knowledge_points WHERE id=?'
          )
          .get(r.source_id)
      : getDb()
          .prepare(
            'SELECT head_revision_id AS revision,deleted_at AS deleted FROM exercises WHERE id=?'
          )
          .get(r.source_id)
  const value = source as
    | { revision: string; deleted: number | null }
    | undefined
  return {
    available: !!value && value.deleted === null,
    source_changed: !!value && value.revision !== r.source_revision
  }
}
function readCard(r: Pick<Row, 'scheduler_json'>): DefaultSchedulerCard {
  const saved = JSON.parse(r.scheduler_json)
  if (JSON.stringify(saved.policy) !== JSON.stringify(policy))
    throw Error('复习算法版本不兼容，已保留原数据，请勿重置')
  return {
    ...saved.card,
    dueAt: new Date(saved.card.dueAt),
    lastReviewAt:
      saved.card.lastReviewAt === null
        ? null
        : new Date(saved.card.lastReviewAt)
  }
}
const encode = (card: DefaultSchedulerCard): string =>
  JSON.stringify({ policy, card })
function summary(
  r: Omit<Row, 'snapshot_json' | 'created_at' | 'updated_at'>
): ReviewSummary {
  const card = readCard(r)
  return {
    id: r.id,
    kind: r.kind,
    source_id: r.source_id,
    source_revision: r.source_revision,
    revision: r.revision,
    task_id: r.task_id,
    title: r.title,
    subject_id: r.subject_id,
    active: !!r.active,
    ...sourceStatus(r),
    due_at: r.due_at,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state
  }
}
function checked(id: string, revision: string): Row {
  const r = row(id)
  if (r.revision !== revision)
    throw Error('复习条目已变化，请重新打开；本次没有重复评分')
  return r
}
function snapshotSource(
  kind: ReviewKind,
  id: string
): { revision: string; snapshot: ReviewSnapshot } {
  if (kind === 'concept') {
    const c = getDb()
      .prepare(
        'SELECT name,summary,subject_id,revision FROM knowledge_points WHERE id=?'
      )
      .get(id) as
      | {
          name: string
          summary: string | null
          subject_id: string | null
          revision: number
        }
      | undefined
    if (!c) throw Error('知识点不存在')
    if (!c.summary?.trim()) throw Error('请先为知识点填写释义，再加入复习')
    const aliases = getDb()
      .prepare(
        'SELECT name FROM concept_aliases WHERE concept_id=? ORDER BY normalized'
      )
      .all(id) as { name: string }[]
    return {
      revision: String(c.revision),
      snapshot: {
        title: c.name,
        subject_id: c.subject_id,
        prompt: `请回忆“${c.name}”的含义、条件与应用。`,
        answer: c.summary,
        aliases: aliases.map((a) => a.name)
      }
    }
  }
  const e = getExercise({ id }),
    fields = exerciseTexts(e.snapshot)
  if (e.deleted_at !== null) throw Error('回收站中的习题不能加入复习')
  if (!fields.standard_answer.trim() && !fields.approach.trim())
    throw Error('请先为习题填写标准答案或解题思路，再加入复习')
  return {
    revision: e.revision_id,
    snapshot: {
      title: e.snapshot.title,
      subject_id: e.snapshot.subject_id,
      prompt: fields.statement,
      answer: fields.standard_answer,
      aliases: [],
      exercise: e.snapshot
    }
  }
}
function syncTask(r: Row): void {
  const snapshot = JSON.parse(r.snapshot_json) as ReviewSnapshot
  getDb()
    .prepare(
      'UPDATE tasks SET title=?,detail=?,due_at=?,status=?,updated_at=? WHERE id=?'
    )
    .run(
      `复习 · ${snapshot.title}`.slice(0, 500),
      '记忆复习：请在复习页显示答案并评分。此时间为建议复习时间。',
      r.due_at,
      r.active && sourceStatus(r).available ? 'open' : 'done',
      Date.now(),
      r.task_id
    )
}
function log(
  before: Row,
  after: Row,
  action: ReviewAction['action'] | 'grade',
  grade: ReviewGrade | null = null,
  schedulerLog: unknown = null
): string {
  const id = nanoid()
  getDb()
    .prepare(
      'INSERT INTO review_logs(id,card_id,action,grade,before_json,after_revision,due_at,source_revision,source_snapshot_json,scheduler_log_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      before.id,
      action,
      grade,
      JSON.stringify(before),
      after.revision,
      after.due_at,
      before.source_revision,
      before.snapshot_json,
      schedulerLog === null ? null : JSON.stringify(schedulerLog),
      Date.now()
    )
  return id
}
export function getReview(id: string): ReviewDetail {
  const r = row(id)
  const history = getDb()
    .prepare(
      'SELECT id,action,grade,created_at,due_at,source_revision,undone,after_revision FROM review_logs WHERE card_id=? ORDER BY rowid DESC LIMIT 20'
    )
    .all(id) as Array<
    ReviewDetail['history'][number] & { after_revision: string }
  >
  return {
    ...summary(r),
    snapshot: JSON.parse(r.snapshot_json),
    history: history.map(({ after_revision: _, ...item }) => ({
      ...item,
      undone: !!item.undone
    })),
    can_undo:
      history[0]?.action === 'grade' &&
      !history[0].undone &&
      history[0].after_revision === r.revision
  }
}
export async function addReview(input: ReviewSource): Promise<ReviewDetail> {
  const s = await scheduler()
  return getDb().transaction(() => {
    const source = snapshotSource(input.kind, input.source_id)
    if (source.revision !== input.expected_source_revision)
      throw Error('来源已修改，请保存并刷新后再加入复习')
    const duplicate = getDb()
      .prepare('SELECT id FROM review_cards WHERE kind=? AND source_id=?')
      .get(input.kind, input.source_id) as { id: string } | undefined
    if (duplicate) return getReview(duplicate.id)
    const count = (
      getDb().prepare('SELECT count(*) AS n FROM review_cards').get() as {
        n: number
      }
    ).n
    if (count >= 10000) throw Error('复习条目超过一万项，请先整理复习库')
    const now = Date.now(),
      id = nanoid(),
      card = s.newCard({ cardId: id, now: new Date(now) })
    const task = createTask({
      title: `复习 · ${source.snapshot.title}`.slice(0, 500),
      due_at: now
    })
    getDb()
      .prepare(
        'INSERT INTO review_cards(id,kind,source_id,source_revision,snapshot_json,title,subject_id,revision,active,scheduler_json,due_at,task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?)'
      )
      .run(
        id,
        input.kind,
        input.source_id,
        source.revision,
        JSON.stringify(source.snapshot),
        source.snapshot.title,
        source.snapshot.subject_id,
        nanoid(),
        encode(card),
        card.dueAt.getTime(),
        task.id,
        now,
        now
      )
    getDb()
      .prepare('INSERT INTO task_reminder_options VALUES(?,?,1,0,0)')
      .run(task.id, nanoid())
    syncTask(row(id))
    return getReview(id)
  })()
}
export function listReviews(input: ReviewListInput): ReviewPage {
  const now = Date.now(),
    tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  const available =
    "((r.kind='concept' AND k.id IS NOT NULL) OR (r.kind='exercise' AND e.id IS NOT NULL AND e.deleted_at IS NULL))"
  const filter = input.subject_id === undefined ? '1=1' : 'r.subject_id IS ?'
  const scope =
    input.scope === 'paused'
      ? `(r.active=0 OR NOT ${available})`
      : input.scope === 'all'
        ? '1=1'
        : `r.active=1 AND ${available} AND r.due_at < ${tomorrow.getTime()}`
  const from = `FROM review_cards r LEFT JOIN knowledge_points k ON r.kind='concept' AND k.id=r.source_id LEFT JOIN exercises e ON r.kind='exercise' AND e.id=r.source_id WHERE ${filter}`
  const args = input.subject_id === undefined ? [] : [input.subject_id]
  const total = (
    getDb()
      .prepare(`SELECT count(*) AS n ${from} AND ${scope}`)
      .get(...args) as { n: number }
  ).n
  const rows = getDb()
    .prepare(
      `SELECT r.id,r.kind,r.source_id,r.source_revision,r.title,r.subject_id,r.revision,r.active,r.scheduler_json,r.due_at,r.task_id ${from} AND ${scope} ORDER BY r.due_at,r.id LIMIT 50 OFFSET ?`
    )
    .all(...args, input.offset) as Array<
    Omit<Row, 'snapshot_json' | 'created_at' | 'updated_at'>
  >
  const due = (
    getDb()
      .prepare(
        `SELECT count(*) AS n ${from} AND r.active=1 AND ${available} AND r.due_at<=?`
      )
      .get(...args, now) as { n: number }
  ).n
  const legacy = (
    getDb().prepare('SELECT count(*) AS n FROM review_records').get() as {
      n: number
    }
  ).n
  return {
    items: rows.map(summary),
    total,
    due_now: due,
    now,
    next_offset:
      input.offset + rows.length < total ? input.offset + rows.length : null,
    legacy_count: legacy
  }
}
export async function revealReview(input: {
  id: string
  expected_revision: string
}): Promise<ReviewReveal> {
  const s = await scheduler()
  return getDb().transaction(() => {
    const r = checked(input.id, input.expected_revision),
      now = Date.now()
    if (!r.active || !sourceStatus(r).available)
      throw Error('复习已暂停或来源不可用')
    if (r.due_at > now) throw Error('尚未到建议复习时间，请到期后再练习')
    const card = readCard(r)
    if (card.lastReviewAt && card.lastReviewAt.getTime() > now)
      throw Error('系统时间早于上次复习，请校准电脑时间')
    const choices = [...s.preview({ card, now: new Date(now) })].map((c) => ({
      grade: c.grade as ReviewGrade,
      due_at: c.card.dueAt.getTime()
    }))
    getDb()
      .prepare(
        'DELETE FROM review_attempts WHERE log_id IS NULL AND expires_at<?'
      )
      .run(now)
    // One pending reveal per card; reopening invalidates an older page rather than accumulating unbounded tokens.
    getDb()
      .prepare('DELETE FROM review_attempts WHERE card_id=? AND log_id IS NULL')
      .run(r.id)
    const token = nanoid(),
      expires_at = now + 30 * 60_000
    getDb()
      .prepare(
        'INSERT INTO review_attempts(id,card_id,revision,expires_at) VALUES(?,?,?,?)'
      )
      .run(token, r.id, r.revision, expires_at)
    return { token, expires_at, detail: getReview(r.id), choices }
  })()
}
export async function gradeReview(input: {
  token: string
  grade: ReviewGrade
}): Promise<ReviewDetail> {
  const s = await scheduler()
  return getDb().transaction(() => {
    const attempt = getDb()
      .prepare('SELECT * FROM review_attempts WHERE id=?')
      .get(input.token) as
      | {
          card_id: string
          revision: string
          expires_at: number
          log_id: string | null
          grade: number | null
        }
      | undefined
    if (!attempt) throw Error('请先显示答案，再按实际记忆情况评分')
    if (attempt.log_id) {
      if (attempt.grade !== input.grade)
        throw Error('此轮已评分，请勿重复提交不同评分')
      return getReview(attempt.card_id)
    }
    const r = checked(attempt.card_id, attempt.revision),
      now = Date.now()
    if (now > attempt.expires_at)
      throw Error('本次练习已超过三十分钟，请重新显示答案后评分')
    if (!r.active || !sourceStatus(r).available || r.due_at > now)
      throw Error('复习已暂停、来源不可用或尚未到期')
    const card = readCard(r)
    if (card.lastReviewAt && now < card.lastReviewAt.getTime())
      throw Error('系统时间早于上次复习，请校准电脑时间')
    const result = s.review({ card, grade: input.grade, now: new Date(now) })
    const after = {
      ...r,
      revision: nanoid(),
      scheduler_json: encode(result.card),
      due_at: result.card.dueAt.getTime(),
      updated_at: now
    }
    getDb()
      .prepare(
        'UPDATE review_cards SET revision=?,scheduler_json=?,due_at=?,updated_at=? WHERE id=?'
      )
      .run(after.revision, after.scheduler_json, after.due_at, now, r.id)
    const id = log(r, after, 'grade', input.grade, result.revlog)
    getDb()
      .prepare('UPDATE review_attempts SET log_id=?,grade=? WHERE id=?')
      .run(id, input.grade, input.token)
    syncTask(after)
    return getReview(r.id)
  })()
}
export function actOnReview(input: ReviewAction): ReviewDetail {
  return getDb().transaction(() => {
    const r = checked(input.id, input.expected_revision)
    let after = { ...r, revision: nanoid(), updated_at: Date.now() }
    if (input.action === 'undo') {
      const last = getDb()
        .prepare(
          'SELECT * FROM review_logs WHERE card_id=? ORDER BY rowid DESC LIMIT 1'
        )
        .get(r.id) as
        | {
            id: string
            action: string
            undone: number
            after_revision: string
            before_json: string
          }
        | undefined
      if (
        !last ||
        last.action !== 'grade' ||
        last.undone ||
        last.after_revision !== r.revision
      )
        throw Error('只能撤销未经后续修改的最近一次评分')
      const old = JSON.parse(last.before_json) as Row
      after = { ...old, revision: after.revision, updated_at: after.updated_at }
      getDb().prepare('UPDATE review_logs SET undone=1 WHERE id=?').run(last.id)
    } else if (input.action === 'refresh') {
      const source = snapshotSource(r.kind, r.source_id)
      after.source_revision = source.revision
      after.snapshot_json = JSON.stringify(source.snapshot)
      after.title = source.snapshot.title
      after.subject_id = source.snapshot.subject_id
    } else {
      if (input.action === 'resume' && !sourceStatus(r).available)
        throw Error('来源不可用，请先恢复原题或知识点')
      after.active = input.action === 'resume' ? 1 : 0
    }
    getDb()
      .prepare(
        'UPDATE review_cards SET source_revision=?,snapshot_json=?,title=?,subject_id=?,revision=?,active=?,scheduler_json=?,due_at=?,updated_at=? WHERE id=?'
      )
      .run(
        after.source_revision,
        after.snapshot_json,
        after.title,
        after.subject_id,
        after.revision,
        after.active,
        after.scheduler_json,
        after.due_at,
        after.updated_at,
        r.id
      )
    log(r, after, input.action)
    syncTask(after)
    return getReview(r.id)
  })()
}
