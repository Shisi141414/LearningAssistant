import { nanoid } from 'nanoid'
import { Temporal } from '@js-temporal/polyfill'
import type {
  ContinuousSettings,
  ContinuousState,
  ScheduleHistory
} from '@shared/continuous-schedule'
import {
  planningDateRange,
  defaultScheduleSettings,
  scheduleDateInZone,
  type ScheduleBlock
} from '@shared/auto-schedule'
import { dbFilePath, getDb } from './db'
import {
  applySchedule,
  discardSchedulePreview,
  getPlanningState,
  hasInteractiveScheduleWork,
  previewSchedule
} from './auto-schedule'
import { withWork } from './work'

const OWNER = -71
interface Row {
  revision: string
  enabled: number
  horizon_days: number
  state: ContinuousState['state']
  last_stamp: string
  checked_at: number | null
  retry_at: number
  error: string
  outcome_json: string
}
let stopped = false,
  active: Promise<ContinuousState> | undefined,
  refreshRuntime: (() => void) | undefined
const row = (): Row | undefined =>
  getDb().prepare('SELECT * FROM schedule_automation WHERE id=1').get() as
    | Row
    | undefined
export function continuousScheduleState(): ContinuousState {
  const r = row()
  const history = getDb()
    .prepare('SELECT * FROM schedule_runs ORDER BY rowid DESC LIMIT 20')
    .all() as Array<{
    id: string
    created_at: number
    origin: ScheduleHistory['origin']
    reason: string
    undone_at: number | null
    before_json: string
    changed_json: string
    outcome_json: string
  }>
  return {
    settings: {
      revision: r?.revision ?? null,
      enabled: !!r?.enabled,
      horizon_days: r?.horizon_days ?? 14
    },
    state: r?.state ?? 'paused',
    checked_at: r?.checked_at ?? null,
    error: r?.error ?? '',
    outcome: JSON.parse(r?.outcome_json ?? '{}'),
    history: history.map((h) => {
      const before = new Set(
          (JSON.parse(h.before_json) as ScheduleBlock[]).map((b) => `${b.id}:${b.revision}`)
        ),
        changed = JSON.parse(h.changed_json) as ScheduleBlock[],
        outcome = JSON.parse(h.outcome_json),
        added = changed.filter((b) => !before.has(`${b.id}:${b.revision}`)),
        removed = changed.filter((b) => before.has(`${b.id}:${b.revision}`))
      return {
        id: h.id,
        created_at: h.created_at,
        origin: h.origin,
        reason: h.reason,
        undone_at: h.undone_at,
        added: added.slice(0, 100),
        removed: removed.slice(0, 100),
        added_total: added.length,
        removed_total: removed.length,
        unplaced: outcome.unplaced ?? [],
        warnings: outcome.warnings ?? []
      }
    })
  }
}
export function saveContinuousSchedule(
  input: ContinuousSettings
): ContinuousState {
  if (stopped) throw Error('持续排程已停止')
  if (
    !Number.isSafeInteger(input.horizon_days) ||
    input.horizon_days < 1 ||
    input.horizon_days > 31
  )
    throw Error('持续排程范围为 1–31 天')
  getDb().transaction(() => {
    if ((row()?.revision ?? null) !== input.revision)
      throw Error('持续排程设置已改变，请刷新后重试；输入仍保留')
    getDb()
      .prepare(
        "INSERT INTO schedule_automation(id,revision,enabled,horizon_days,state) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,horizon_days=excluded.horizon_days,state=excluded.state,last_stamp='',retry_at=0,error=''"
      )
      .run(
        nanoid(),
        Number(input.enabled),
        input.horizon_days,
        input.enabled ? 'waiting' : 'paused'
      )
  })()
  if (!input.enabled) discardSchedulePreview(OWNER)
  refreshRuntime?.()
  return continuousScheduleState()
}
/** Changes in data, local planning date, expired blocks and deadlines are meaningful triggers. */
export function continuousScheduleStamp(now = Date.now()): string {
  const db = getDb(),
    stored = db
      .prepare('SELECT value_json FROM schedule_settings WHERE id=1')
      .get() as { value_json: string } | undefined,
    timezone = stored
      ? (JSON.parse(stored.value_json).timezone as string)
      : defaultScheduleSettings().timezone,
    r = row()
  const seq = (
    db.prepare('SELECT seq FROM schedule_change_counter WHERE id=1').get() as {
      seq: number
    }
  ).seq
  const clock = db
    .prepare(
      "SELECT (SELECT MAX(b.end_at) FROM schedule_blocks b JOIN tasks t ON t.id=b.task_id JOIN task_planning p ON p.task_id=t.id WHERE b.end_at<=? AND t.status!='done' AND json_extract(p.options_json,'$.enabled')=1) AS ended,(SELECT MAX(due_at) FROM tasks WHERE due_at<=? AND status!='done') AS due"
    )
    .get(now, now)
  return JSON.stringify([
    dbFilePath(),
    r?.revision ?? null,
    seq,
    scheduleDateInZone(now, timezone),
    clock
  ])
}
export function needsContinuousSchedule(now = Date.now()): boolean {
  const r = row()
  return (
    !!r?.enabled &&
    now >= r.retry_at &&
    (r.state === 'error' ||
      r.state === 'waiting' ||
      r.last_stamp !== continuousScheduleStamp(now))
  )
}
export function checkContinuousSchedule(
  force = false
): Promise<ContinuousState> {
  if (active) return active
  active = withWork('持续自动排程', async () => {
    if (stopped) throw Error('持续排程已停止')
    const r = row()
    if (!r?.enabled || (!force && !needsContinuousSchedule()))
      return continuousScheduleState()
    if (hasInteractiveScheduleWork()) {
      getDb()
        .prepare("UPDATE schedule_automation SET state='waiting' WHERE id=1")
        .run()
      return continuousScheduleState()
    }
    const file = dbFilePath()
    try {
      const stamp = continuousScheduleStamp(),
        now = Date.now(),
        settings = getPlanningState().settings.value,
        from = scheduleDateInZone(now, settings.timezone),
        through = Temporal.PlainDate.from(from)
          .add({ days: r.horizon_days - 1 })
          .toString(),
        range = planningDateRange(from, through, settings.timezone)
      getDb()
        .prepare(
          "UPDATE schedule_automation SET state='running',checked_at=?,error='' WHERE id=1"
        )
        .run(now)
      const preview = await previewSchedule(OWNER, range)
      if (stopped) throw Error('持续排程已停止')
      return getDb().transaction(() => {
        const current = row()
        if (
          file !== dbFilePath() ||
          !current?.enabled ||
          current.revision !== r.revision ||
          continuousScheduleStamp() !== stamp ||
          hasInteractiveScheduleWork()
        ) {
          discardSchedulePreview(OWNER)
          if (current?.enabled)
            getDb()
              .prepare(
                "UPDATE schedule_automation SET state='waiting' WHERE id=1"
              )
              .run()
          return continuousScheduleState()
        }
        applySchedule(OWNER, preview.token, {
          origin: 'automatic',
          reason:
            '启用持续排程后，任务、日程、设置或时间边界变化，按剩余用时重新安排'
        })
        getDb()
          .prepare(
            "UPDATE schedule_automation SET state='idle',last_stamp=?,checked_at=?,retry_at=0,error='',outcome_json=? WHERE id=1"
          )
          .run(
            continuousScheduleStamp(),
            Date.now(),
            JSON.stringify({
              ...range,
              unplaced: preview.unplaced,
              warnings: preview.warnings
            })
          )
        return continuousScheduleState()
      })()
    } catch (error) {
      discardSchedulePreview(OWNER)
      if (stopped) throw error
      if (file === dbFilePath() && row()?.revision === r.revision)
        getDb()
          .prepare(
            "UPDATE schedule_automation SET state='error',error=?,retry_at=?,checked_at=? WHERE id=1"
          )
          .run(
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              2000
            ),
            Date.now() + 60000,
            Date.now()
          )
      return continuousScheduleState()
    }
  }).finally(() => {
    active = undefined
  })
  return active
}
export function recoverContinuousSchedule(): void {
  stopped = false
  getDb()
    .prepare(
      "UPDATE schedule_automation SET state='waiting',last_stamp='',retry_at=0,error='上次检查中断，将根据已提交的数据重新计算' WHERE state='running' AND enabled=1"
    )
    .run()
}
export function attachContinuousScheduleRuntime(
  refresh: () => void
): () => void {
  refreshRuntime = refresh
  return () => {
    if (refreshRuntime === refresh) refreshRuntime = undefined
  }
}
export function stopContinuousSchedule(): void {
  stopped = true
  discardSchedulePreview(OWNER)
}
