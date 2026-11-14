import { nanoid } from 'nanoid'
import type { TaskPlanning } from '@shared/auto-schedule'
import type { ReviewPlanningSave, ReviewPlanningState } from '@shared/reviews'
import { getDb } from './db'
interface Policy {
  card_id: string
  revision: string
  enabled: number
  duration_minutes: number
  priority: number
  cycle: string
}
function card(id: string) {
  const c = getDb()
    .prepare(
      'SELECT c.*,t.status AS task_status FROM review_cards c JOIN tasks t ON t.id=c.task_id WHERE c.id=?'
    )
    .get(id) as
    | {
        id: string
        revision: string
        task_status: string
        active: number
        due_at: number
      }
    | undefined
  if (!c) throw Error('复习条目不存在')
  return c
}
export function reviewPlanningState(id: string): ReviewPlanningState {
  const c = card(id),
    p = getDb()
      .prepare('SELECT * FROM review_planning WHERE card_id=?')
      .get(id) as Policy | undefined
  const blocks = getDb()
    .prepare(
      'SELECT b.*,c.cycle AS review_cycle FROM schedule_blocks b JOIN review_block_cycles c ON c.block_id=b.id WHERE c.card_id=? ORDER BY b.start_at,b.id'
    )
    .all(id) as Array<
    Omit<ReviewPlanningState['blocks'][number], 'locked'> & { locked: number }
  >
  const history = getDb()
    .prepare(
      'SELECT id,reason,blocks_json,created_at FROM review_block_history WHERE card_id=? ORDER BY rowid DESC LIMIT 20'
    )
    .all(id) as {
    id: string
    reason: string
    blocks_json: string
    created_at: number
  }[]
  return {
    id,
    card_revision: c.revision,
    revision: p?.revision ?? null,
    enabled: !!p?.enabled,
    duration_minutes: p?.duration_minutes ?? 10,
    priority: p?.priority ?? 1,
    cycle: p?.cycle ?? null,
    active: !!c.active && c.task_status !== 'done',
    due_at: c.due_at,
    blocks: blocks.map((b) => ({ ...b, locked: !!b.locked })),
    history: history.map(({ blocks_json, ...h }) => ({
      ...h,
      blocks: JSON.parse(blocks_json).map(
        (b: ReviewPlanningState['blocks'][number]) => ({
          ...b,
          locked: !!b.locked
        })
      )
    }))
  }
}
export function saveReviewPlanning(
  input: ReviewPlanningSave
): ReviewPlanningState {
  if (
    !Number.isSafeInteger(input.duration_minutes) ||
    input.duration_minutes < 5 ||
    input.duration_minutes > 120 ||
    input.duration_minutes % 5 ||
    !Number.isSafeInteger(input.priority) ||
    input.priority < 0 ||
    input.priority > 3 ||
    typeof input.enabled !== 'boolean'
  )
    throw Error('每轮预计用时为 5–120 分钟且为 5 的倍数，优先级为 0–3')
  return getDb().transaction(() => {
    const current = reviewPlanningState(input.id)
    if (
      current.revision !== input.expected_revision ||
      current.card_revision !== input.expected_card_revision
    )
      throw Error('复习轮次或安排已变化，请重新载入；输入仍保留')
    if (input.enabled && !current.enabled) {
      const n = getDb()
        .prepare(
          'SELECT (SELECT count(*) FROM task_planning)+(SELECT count(*) FROM review_planning WHERE enabled=1) AS n'
        )
        .get() as { n: number }
      if (n.n >= 500) throw Error('最多五百项自动排程配置，请先整理')
    }
    if (current.revision === null) {
      getDb()
        .prepare('INSERT INTO review_planning VALUES(?,?,?,?,?,?)')
        .run(
          input.id,
          nanoid(),
          Number(input.enabled),
          input.duration_minutes,
          input.priority,
          nanoid()
        )
    } else
      getDb()
        .prepare(
          'UPDATE review_planning SET revision=?,enabled=?,duration_minutes=?,priority=? WHERE card_id=?'
        )
        .run(
          nanoid(),
          Number(input.enabled),
          input.duration_minutes,
          input.priority,
          input.id
        )
    return reviewPlanningState(input.id)
  })()
}
/** Virtual normal-form planning options keep one policy owner; no parallel task/deadline system. */
export function reviewPlanningProjection(): TaskPlanning[] {
  const rows = getDb()
    .prepare(
      'SELECT p.*,c.task_id,c.due_at FROM review_planning p JOIN review_cards c ON c.id=p.card_id WHERE p.enabled=1 ORDER BY c.id LIMIT 501'
    )
    .all() as Array<Policy & { task_id: string; due_at: number }>
  return rows.map((p) => ({
    task_id: p.task_id,
    revision: p.revision,
    enabled: !!p.enabled,
    remaining_minutes: p.duration_minutes,
    priority: p.priority,
    not_before: p.due_at,
    splittable: false,
    min_minutes: p.duration_minutes,
    max_minutes: p.duration_minutes,
    dependencies: []
  }))
}
