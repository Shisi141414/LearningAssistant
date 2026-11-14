import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type {
  ReminderAction,
  ReminderCapabilities,
  ReminderConfiguration,
  ReminderItem,
  ReminderPage,
  ReminderSettings,
  ReminderTaskOptions,
  SystemDeliveryStatus
} from '@shared/reminders'
import {
  allDayReminderEvent,
  defaultReminderSettings,
  quietUntil,
  validateReminderSettings,
  validateReminderTask
} from '@shared/reminders'
import { dbFilePath, getDb } from './db'
import { updateTask } from './projects'

interface TaskRow {
  id: string
  title: string
  location: string
  status: string
  project_status: string | null
  planned_at: number | null
  due_at: number | null
  all_day: number
}
interface Runtime {
  capabilities: () => ReminderCapabilities
  refresh: () => void
  test: () => Promise<string>
}
let runtime: Runtime | undefined,
  cache: { file: string; seq: number; zone: string } | null = null,
  lastNow = 0
export function attachReminderRuntime(value: Runtime): () => void {
  runtime = value
  return () => {
    if (runtime === value) runtime = undefined
  }
}
const capabilities = (): ReminderCapabilities =>
  runtime?.capabilities() ?? {
    system_supported: false,
    background_active: false,
    packaged: false,
    error: '通知运行时尚未启动'
  }
export function reminderSettings(): ReminderConfiguration {
  const row = getDb()
    .prepare('SELECT revision,value_json FROM reminder_settings WHERE id=1')
    .get() as { revision: string; value_json: string } | undefined
  return {
    revision: row?.revision ?? null,
    value: row ? JSON.parse(row.value_json) : defaultReminderSettings(),
    capabilities: capabilities()
  }
}
export function taskReminderOptions(task_id: string): ReminderTaskOptions {
  if (!getDb().prepare('SELECT id FROM tasks WHERE id=?').get(task_id))
    throw Error('任务不存在')
  const row = getDb()
    .prepare('SELECT * FROM task_reminder_options WHERE task_id=?')
    .get(task_id) as
    | (Omit<ReminderTaskOptions, 'enabled'> & { enabled: number })
    | undefined
  return row
    ? { ...row, enabled: !!row.enabled }
    : {
        task_id,
        revision: null,
        enabled: true,
        start_lead_minutes: null,
        due_lead_minutes: null
      }
}
function revision(current: string | null, expected: string | null): void {
  if (current !== expected)
    throw Error('提醒信息已改变，请刷新后重试；未保存的输入仍保留')
}
export function saveReminderSettings(input: {
  expected_revision: string | null
  value: ReminderSettings
}): ReminderConfiguration {
  validateReminderSettings(input.value)
  getDb().transaction(() => {
    revision(reminderSettings().revision, input.expected_revision)
    getDb()
      .prepare(
        'INSERT INTO reminder_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json'
      )
      .run(nanoid(), JSON.stringify(input.value))
  })()
  if (!input.value.system_enabled)
    getDb()
      .prepare(
        "UPDATE reminder_deliveries SET status='skipped',error='系统通知已停用；应用内提醒保留' WHERE status IN ('pending','claimed')"
      )
      .run()
  reconcileReminders()
  runtime?.refresh()
  return reminderSettings()
}
export function saveTaskReminderOptions(
  input: ReminderTaskOptions
): ReminderTaskOptions {
  validateReminderTask(input)
  getDb().transaction(() => {
    revision(taskReminderOptions(input.task_id).revision, input.revision)
    getDb()
      .prepare(
        'INSERT INTO task_reminder_options VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,start_lead_minutes=excluded.start_lead_minutes,due_lead_minutes=excluded.due_lead_minutes'
      )
      .run(
        input.task_id,
        nanoid(),
        Number(input.enabled),
        input.start_lead_minutes,
        input.due_lead_minutes
      )
  })()
  reconcileReminders()
  runtime?.refresh()
  return taskReminderOptions(input.task_id)
}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Root = Pick<
  ReminderItem,
  | 'id'
  | 'task_id'
  | 'event_key'
  | 'kind'
  | 'source_id'
  | 'event_at'
  | 'remind_at'
  | 'title'
  | 'location'
>
/** Cached change counter includes same-millisecond task edits and all time-block mutations. */
export function reconcileReminders(now = Date.now()): void {
  const db = getDb(),
    file = dbFilePath(),
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    seq = (
      db
        .prepare('SELECT seq FROM reminder_change_counter WHERE id=1')
        .get() as { seq: number }
    ).seq
  if (now < lastNow - 60000) cache = null
  lastNow = now
  if (cache?.file === file && cache.seq === seq && cache.zone === zone) return
  const settings = reminderSettings().value
  db.transaction(() => {
    const tasks = db
        .prepare(
          "SELECT t.id,t.title,t.location,t.status,t.planned_at,t.due_at,t.all_day,p.status AS project_status FROM tasks t LEFT JOIN projects p ON t.project_id=p.id WHERE t.status!='done' AND (p.status IS NULL OR p.status='active') LIMIT 5001"
        )
        .all() as TaskRow[],
      blocks = db
        .prepare(
          "SELECT b.id,b.task_id,b.start_at FROM schedule_blocks b JOIN tasks t ON t.id=b.task_id LEFT JOIN projects p ON p.id=t.project_id WHERE t.status IN ('open','doing') AND (p.status IS NULL OR p.status='active') LIMIT 10001"
        )
        .all() as { id: string; task_id: string; start_at: number }[],
      options = db
        .prepare('SELECT * FROM task_reminder_options')
        .all() as Array<
        Omit<ReminderTaskOptions, 'enabled'> & { enabled: number }
      >
    if (tasks.length > 5000 || blocks.length > 10000)
      throw Error(
        '提醒数据超过五千任务或一万时间块，请清理历史任务；未更新提醒计划'
      )
    const opts = new Map(options.map((p) => [p.task_id, p])),
      taskMap = new Map(tasks.map((t) => [t.id, t])),
      desired: Root[] = []
    const add = (
      t: TaskRow,
      kind: Root['kind'],
      source_id: string,
      event_at: number
    ): void => {
      const p = opts.get(t.id)
      if (!settings.enabled || p?.enabled === 0) return
      const lead =
          kind === 'due'
            ? (p?.due_lead_minutes ?? settings.due_lead_minutes)
            : (p?.start_lead_minutes ?? settings.start_lead_minutes),
        remind_at = event_at - lead * 60000,
        key = hash([t.id, kind, source_id, event_at, remind_at])
      desired.push({
        id: key,
        event_key: key,
        task_id: t.id,
        kind,
        source_id,
        event_at,
        remind_at,
        title: t.title,
        location: t.location
      })
    }
    for (const t of tasks) {
      if (t.due_at !== null) add(t, 'due', t.id, t.due_at)
      if (t.status !== 'blocked' && t.planned_at !== null)
        add(
          t,
          'start',
          t.id,
          t.all_day
            ? allDayReminderEvent(t.planned_at, settings, zone)
            : t.planned_at
        )
    }
    for (const b of blocks) {
      const t = taskMap.get(b.task_id)
      if (t) add(t, 'block', b.id, b.start_at)
    }
    const valid = new Set(desired.map((p) => p.event_key)),
      active = db
        .prepare(
          "SELECT id,event_key FROM reminders WHERE status IN ('pending','published')"
        )
        .all() as { id: string; event_key: string }[],
      cancel = db.prepare(
        "UPDATE reminders SET status='cancelled',revision=? WHERE id=?"
      ),
      cancelDelivery = db.prepare(
        "UPDATE reminder_deliveries SET status='cancelled',error='原提醒已失效' WHERE reminder_id=?"
      )
    for (const r of active)
      if (!valid.has(r.event_key)) {
        cancel.run(nanoid(), r.id)
        cancelDelivery.run(r.id)
      }
    const insert = db.prepare(
        "INSERT OR IGNORE INTO reminders(id,task_id,event_key,kind,source_id,event_at,remind_at,title,location,status,published_at,revision,created_at) VALUES(@id,@task_id,@event_key,@kind,@source_id,@event_at,@remind_at,@title,@location,'pending',NULL,@revision,@created_at)"
      ),
      restore = db.prepare(
        "UPDATE reminders SET status='pending',revision=? WHERE id=? AND status IN ('cancelled','expired') AND published_at IS NULL AND remind_at>=?"
      ),
      rename = db.prepare(
        "UPDATE reminders SET title=?,location=?,revision=? WHERE id=? AND status='pending' AND (title!=? OR location!=?)"
      )
    for (const r of desired) {
      insert.run({ ...r, revision: nanoid(), created_at: now })
      restore.run(nanoid(), r.id, now - settings.catchup_minutes * 60000)
      rename.run(r.title, r.location, nanoid(), r.id, r.title, r.location)
    }
  })()
  cache = { file, seq, zone }
}
/** Publish the in-app record before any external side effect. Overdue backlogs become one system batch. */
export function publishDueReminders(now = Date.now()): number {
  reconcileReminders(now)
  const db = getDb(),
    settings = reminderSettings().value
  if (!settings.enabled) return 0
  return db.transaction(() => {
    db.prepare(
      "UPDATE reminders SET status='expired',revision=? WHERE status='pending' AND remind_at<?"
    ).run(nanoid(), now - settings.catchup_minutes * 60000)
    const rows = db
      .prepare(
        "SELECT id FROM reminders WHERE status='pending' AND remind_at<=? ORDER BY remind_at,id LIMIT 1000"
      )
      .all(now) as { id: string }[]
    const publish = db.prepare(
        "UPDATE reminders SET status='published',published_at=?,revision=? WHERE id=?"
      ),
      delivery = db.prepare(
        'INSERT OR REPLACE INTO reminder_deliveries(reminder_id,status,next_at,error) VALUES(?,?,?,?)'
      )
    const next = quietUntil(now, settings) ?? now
    for (const r of rows) {
      publish.run(now, nanoid(), r.id)
      delivery.run(
        r.id,
        settings.system_enabled ? 'pending' : 'skipped',
        next,
        settings.system_enabled ? '' : '系统通知未启用；应用内提醒已保存'
      )
    }
    return rows.length
  })()
}
const itemQuery =
  'SELECT r.*,c.id AS review_id,d.status AS system_status,d.error AS system_error FROM reminders r LEFT JOIN reminder_deliveries d ON r.id=d.reminder_id LEFT JOIN review_cards c ON c.task_id=r.task_id'
export function listReminders(
  input: { view: 'attention' | 'upcoming' | 'history'; offset?: number },
  now = Date.now()
): ReminderPage {
  publishDueReminders(now)
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
    throw Error('提醒分页无效')
  const where =
      input.view === 'attention'
        ? "r.status='published'"
        : input.view === 'upcoming'
          ? "r.status='pending'"
          : "r.status NOT IN ('pending','published')",
    db = getDb(),
    total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM reminders r WHERE ${where}`)
        .get() as { c: number }
    ).c,
    counts = db
      .prepare(
        "SELECT SUM(status='published') AS attention,SUM(status='pending') AS upcoming FROM reminders"
      )
      .get() as { attention: number | null; upcoming: number | null }
  return {
    items: db
      .prepare(
        `${itemQuery} WHERE ${where} ORDER BY r.remind_at ${input.view === 'upcoming' ? 'ASC' : 'DESC'},r.id LIMIT 50 OFFSET ?`
      )
      .all(offset) as ReminderItem[],
    total,
    next_offset: offset + 50 < total ? offset + 50 : null,
    attention_count: counts.attention ?? 0,
    upcoming_count: counts.upcoming ?? 0
  }
}
export function activeReminder(id: string): ReminderItem | null {
  reconcileReminders()
  return (
    (getDb()
      .prepare(`${itemQuery} WHERE r.id=? AND r.status='published'`)
      .get(id) as ReminderItem | undefined) ?? null
  )
}
export function actOnReminder(
  input: ReminderAction,
  now = Date.now()
): boolean {
  publishDueReminders(now)
  getDb().transaction(() => {
    const r = getDb().prepare(`${itemQuery} WHERE r.id=?`).get(input.id) as
      | ReminderItem
      | undefined
    if (!r) throw Error('提醒已不存在')
    revision(r.revision, input.expected_revision)
    if (r.status !== 'published') throw Error('此提醒已处理或失效，请刷新')
    if (input.action === 'retry') {
      if (!reminderSettings().value.system_enabled)
        throw Error('请先启用系统通知')
      if (!['failed', 'uncertain', 'skipped'].includes(r.system_status ?? ''))
        throw Error('此提醒无需重试，或已有投递在进行')
      getDb()
        .prepare(
          "UPDATE reminder_deliveries SET status='pending',attempt=NULL,next_at=?,error='' WHERE reminder_id=?"
        )
        .run(quietUntil(now, reminderSettings().value) ?? now, r.id)
      getDb()
        .prepare('UPDATE reminders SET revision=? WHERE id=?')
        .run(nanoid(), r.id)
      return
    }
    if (input.action === 'snooze') {
      if (!input.minutes || ![5, 10, 30, 60, 1440].includes(input.minutes))
        throw Error('稍后提醒支持 5、10、30、60 分钟或明天此时')
      getDb()
        .prepare(
          "INSERT INTO reminders(id,task_id,event_key,kind,source_id,event_at,remind_at,title,location,status,published_at,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?,?)"
        )
        .run(
          nanoid(),
          r.task_id,
          r.event_key,
          r.kind,
          r.source_id,
          r.event_at,
          now + input.minutes * 60000,
          r.title,
          r.location,
          nanoid(),
          now
        )
    }
    if (input.action === 'complete') updateTask(r.task_id, { status: 'done' })
    getDb()
      .prepare('UPDATE reminders SET status=?,revision=? WHERE id=?')
      .run(input.action === 'snooze' ? 'snoozed' : 'dismissed', nanoid(), r.id)
    getDb()
      .prepare(
        "UPDATE reminder_deliveries SET status='cancelled',error='提醒已处理' WHERE reminder_id=?"
      )
      .run(r.id)
  })()
  reconcileReminders(now)
  runtime?.refresh()
  return true
}
export interface DeliveryBatch {
  attempt: string
  database: string
  items: ReminderItem[]
}
export function claimSystemReminders(now = Date.now()): DeliveryBatch | null {
  publishDueReminders(now)
  const settings = reminderSettings().value
  if (
    !settings.enabled ||
    !settings.system_enabled ||
    quietUntil(now, settings) !== null
  )
    return null
  return getDb().transaction(() => {
    const items = getDb()
      .prepare(
        // Re-evaluate the current quiet window above. A saved next_at belongs to
        // the old settings/timezone and must not delay an explicitly ended window.
        `${itemQuery} WHERE r.status='published' AND d.status='pending' ORDER BY r.remind_at,r.id LIMIT 1000`
      )
      .all() as ReminderItem[]
    if (!items.length) return null
    const attempt = nanoid(),
      claim = getDb().prepare(
        "UPDATE reminder_deliveries SET status='claimed',attempt=?,attempted_at=? WHERE reminder_id=? AND status='pending'"
      )
    for (const r of items) claim.run(attempt, now, r.id)
    return { attempt, database: dbFilePath(), items }
  })()
}
export function finishSystemDelivery(
  batch: DeliveryBatch,
  status: Extract<SystemDeliveryStatus, 'shown' | 'failed' | 'uncertain'>,
  error = ''
): void {
  if (batch.database !== dbFilePath()) return
  getDb()
    .prepare(
      `UPDATE reminder_deliveries SET status=?,error=? WHERE attempt=? AND ${status === 'uncertain' ? "status='claimed'" : "status IN ('claimed','shown')"} AND reminder_id IN (SELECT id FROM reminders WHERE status='published')`
    )
    .run(status, error.slice(0, 1000), batch.attempt)
}
export function recoverReminderDeliveries(): void {
  getDb()
    .prepare(
      "UPDATE reminder_deliveries SET status='uncertain',error='上次在系统通知发送中中断；不会自动重复发送，可手动重试' WHERE status='claimed'"
    )
    .run()
  cache = null
}
export function requestReminderTest(): Promise<string> {
  if (!runtime) throw Error('通知运行时尚未就绪')
  return runtime.test()
}
