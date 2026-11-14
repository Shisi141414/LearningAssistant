import { Temporal } from '@js-temporal/polyfill'

export interface Availability {
  weekday: number
  start: string
  end: string
}
export interface ScheduleSettings {
  timezone: string
  availability: Availability[]
  daily_minutes: number
  buffer_minutes: number
}
export interface TaskPlanning {
  task_id: string
  revision: string
  enabled: boolean
  remaining_minutes: number
  priority: number
  not_before: number | null
  splittable: boolean
  min_minutes: number
  max_minutes: number
  dependencies: string[]
}
export interface ScheduleBlock {
  review_cycle?: string
  id: string
  task_id: string
  start_at: number
  end_at: number
  locked: boolean
  revision: string
  reason: string
}
export interface PlannerTask {
  review_cycle?: string | null
  review_due_at?: number | null
  id: string
  title: string
  status: string
  project_status: string | null
  due_at: number | null
  planned_at: number | null
  planned_end_at: number | null
  all_day: boolean
}
export interface PlannerInput {
  settings: ScheduleSettings
  tasks: PlannerTask[]
  planning: TaskPlanning[]
  blocks: ScheduleBlock[]
  from: number
  to: number
  now: number
}
export interface PlannedBlock {
  review_cycle?: string
  task_id: string
  start_at: number
  end_at: number
  reason: string
}
export interface PlannerResult {
  added: PlannedBlock[]
  removed: ScheduleBlock[]
  unplaced: { task_id: string; reason: string }[]
  warnings: string[]
}
export interface PlanningState {
  settings: { revision: string | null; value: ScheduleSettings }
  planning: TaskPlanning[]
  blocks: ScheduleBlock[]
  latest_run: { id: string; created_at: number } | null
}
export interface PlanningPreview extends PlannerResult {
  token: string
  from: number
  to: number
}
export type TaskPlanningSave = Omit<TaskPlanning, 'revision'> & {
  expected_revision: string | null
}
const MINUTE = 60_000
const clock = /^([01]\d|2[0-3]):[0-5]\d$/
const minutes = (s: string): number =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
const integer = (n: number, low: number, high: number): boolean =>
  Number.isSafeInteger(n) && n >= low && n <= high
export function validateScheduleSettings(s: ScheduleSettings): void {
  Temporal.Now.zonedDateTimeISO(s.timezone)
  if (
    !integer(s.daily_minutes, 5, 1440) ||
    s.daily_minutes % 5 ||
    !integer(s.buffer_minutes, 0, 60)
  )
    throw Error('每日安排时长应为 5–1440 分钟且为 5 的倍数；缓冲为 0–60 分钟')
  if (!Array.isArray(s.availability) || s.availability.length > 28)
    throw Error('每周最多设置 28 个可用时段')
  const sorted = [...s.availability].sort(
    (a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)
  )
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i],
      prev = sorted[i - 1]
    if (
      !integer(a.weekday, 1, 7) ||
      !clock.test(a.start) ||
      !clock.test(a.end) ||
      minutes(a.start) >= minutes(a.end)
    )
      throw Error('可用时段需要同一天内有效的起止时间')
    if (
      prev &&
      prev.weekday === a.weekday &&
      minutes(prev.end) > minutes(a.start)
    )
      throw Error('同一天的可用时段不能重叠')
  }
}
export function validateTaskPlanning(p: Omit<TaskPlanning, 'revision'>): void {
  if (
    !integer(p.remaining_minutes, 5, 3600) ||
    p.remaining_minutes % 5 ||
    !integer(p.priority, 0, 3)
  )
    throw Error('剩余用时应为 5–3600 分钟且为 5 的倍数；优先级为 0–3')
  if (
    !integer(p.min_minutes, 5, 240) ||
    !integer(p.max_minutes, p.min_minutes, 480) ||
    p.min_minutes % 5 ||
    p.max_minutes % 5
  )
    throw Error('每段最少 5–240 分钟，最多不超过 480 分钟，并使用 5 的倍数')
  if (p.not_before !== null && !integer(p.not_before, 0, 8_640_000_000_000_000))
    throw Error('最早开始时间无效')
  if (
    !Array.isArray(p.dependencies) ||
    p.dependencies.length > 32 ||
    new Set(p.dependencies).size !== p.dependencies.length ||
    p.dependencies.includes(p.task_id)
  )
    throw Error('前置任务不能重复或包含任务自身，最多 32 项')
}
export function assertAcyclic(
  planning: Pick<TaskPlanning, 'task_id' | 'dependencies'>[]
): void {
  const graph = new Map(planning.map((p) => [p.task_id, p.dependencies])),
    active = new Set<string>(),
    seen = new Set<string>()
  function visit(id: string): void {
    if (active.has(id)) throw Error('前置任务形成循环依赖')
    if (seen.has(id)) return
    active.add(id)
    for (const dep of graph.get(id) ?? []) visit(dep)
    active.delete(id)
    seen.add(id)
  }
  for (const id of graph.keys()) visit(id)
}
export function defaultScheduleSettings(): ScheduleSettings {
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    daily_minutes: 120,
    buffer_minutes: 10,
    availability: Array.from({ length: 7 }, (_, i) => ({
      weekday: i + 1,
      start: '19:00',
      end: '21:00'
    }))
  }
}
export function scheduleDateInZone(at: number, timezone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(at)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString()
}
/** Calendar dates belong to the configured availability zone, independent of the host zone. */
export function planningDateRange(
  from: string,
  through: string,
  timezone: string
): { from: number; to: number } {
  const a = Temporal.PlainDate.from(from),
    b = Temporal.PlainDate.from(through),
    start = a.toZonedDateTime(timezone),
    end = b.add({ days: 1 }).toZonedDateTime(timezone)
  if (
    !start.toPlainDate().equals(a) ||
    !b.toZonedDateTime(timezone).toPlainDate().equals(b) ||
    Temporal.PlainDate.compare(a, b) > 0
  )
    throw Error('请输入正确日期')
  return { from: start.epochMilliseconds, to: end.epochMilliseconds }
}
export function defaultTaskPlanning(task_id: string): TaskPlanningSave {
  return {
    task_id,
    expected_revision: null,
    enabled: false,
    remaining_minutes: 60,
    priority: 1,
    not_before: null,
    splittable: true,
    min_minutes: 25,
    max_minutes: 60,
    dependencies: []
  }
}
export function fixedTaskEnd(t: PlannerTask): number {
  if (t.planned_end_at !== null) return t.planned_end_at
  if (!t.all_day) return t.planned_at! + 60 * MINUTE
  const end = new Date(t.planned_at!)
  end.setDate(end.getDate() + 1)
  return end.getTime()
}

/** Deterministic earliest-deadline heuristic, not an optimality solver. Never writes user data. */
export function planSchedule(input: PlannerInput): PlannerResult {
  const { settings: settings, tasks, planning, blocks, from, to, now } = input
  validateScheduleSettings(settings)
  if (
    ![from, to, now].every((n) => integer(n, 0, 8_640_000_000_000_000)) ||
    from >= to ||
    to - from > 32 * 86400_000
  )
    throw Error('排程范围须为 31 天以内的有效时间')
  if (tasks.length > 5000 || planning.length > 500 || blocks.length > 10000)
    throw Error('排程数据过多，请先清理已完成的任务或时间块')
  for (const p of planning) validateTaskPlanning(p)
  assertAcyclic(planning)
  const result: PlannerResult = {
      added: [],
      removed: [],
      unplaced: [],
      warnings: []
    },
    taskById = new Map(tasks.map((t) => [t.id, t])),
    options = new Map(planning.map((p) => [p.task_id, p])),
    eligible = new Set(
      planning
        .filter((p) => {
          const t = taskById.get(p.task_id)
          return (
            p.enabled &&
            t &&
            ['open', 'doing'].includes(t.status) &&
            (!t.project_status || t.project_status === 'active') &&
            t.planned_at === null
          )
        })
        .map((p) => p.task_id)
    ),
    lower = Math.max(from, now),
    buffer = settings.buffer_minutes * MINUTE
  const zoned = (at: number) =>
    Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(
      settings.timezone
    )
  const dayKey = (at: number): string => zoned(at).toPlainDate().toString()
  if (
    zoned(to - 1)
      .toPlainDate()
      .since(zoned(from).toPlainDate()).days >= 31
  )
    throw Error('排程范围须为 31 天以内的有效时间')
  const preserved = blocks.filter(
    (b) =>
      !eligible.has(b.task_id) ||
      b.locked ||
      b.start_at < lower ||
      b.end_at > to
  )
  result.removed = blocks.filter((b) => !preserved.includes(b))
  const busy: { start: number; end: number }[] = []
  const used = new Map<string, number>()
  const addUsed = (start: number, end: number): void => {
    let cursor = Math.max(start, lower),
      stop = Math.min(end, to)
    while (cursor < stop) {
      const z = zoned(cursor),
        nextDay = z
          .toPlainDate()
          .add({ days: 1 })
          .toZonedDateTime(settings.timezone).epochMilliseconds,
        next = Math.min(stop, nextDay),
        key = dayKey(cursor)
      used.set(key, (used.get(key) ?? 0) + (next - cursor) / MINUTE)
      cursor = next
    }
  }
  for (const t of tasks)
    if (t.status !== 'done' && t.planned_at !== null)
      busy.push({ start: t.planned_at, end: fixedTaskEnd(t) })
  for (const b of preserved)
    if (taskById.get(b.task_id)?.status !== 'done') {
      busy.push({ start: b.start_at, end: b.end_at })
      addUsed(b.start_at, b.end_at)
    }
  const slots: { start: number; end: number; day: string }[] = []
  let day = zoned(from).toPlainDate(),
    lastDay = zoned(to - 1).toPlainDate()
  while (Temporal.PlainDate.compare(day, lastDay) <= 0) {
    for (const a of settings.availability.filter(
      (a) => a.weekday === day.dayOfWeek
    )) {
      try {
        const start = Math.max(
            lower,
            day
              .toPlainDateTime(a.start)
              .toZonedDateTime(settings.timezone, { disambiguation: 'reject' })
              .epochMilliseconds
          ),
          end = Math.min(
            to,
            day
              .toPlainDateTime(a.end)
              .toZonedDateTime(settings.timezone, { disambiguation: 'reject' })
              .epochMilliseconds
          )
        if (end > start) slots.push({ start, end, day: day.toString() })
      } catch {
        result.warnings.push(
          `${day} ${a.start}–${a.end} 在 ${settings.timezone} 存在夏令时歧义，已跳过`
        )
      }
    }
    day = day.add({ days: 1 })
  }
  slots.sort((a, b) => a.start - b.start)
  const finish = new Map<string, number>(),
    pending = new Set(eligible),
    failed = new Set<string>()
  for (const t of tasks) {
    if (t.status === 'done') finish.set(t.id, 0)
    else if (
      t.planned_at !== null &&
      t.status !== 'blocked' &&
      (!t.project_status || t.project_status === 'active')
    )
      finish.set(t.id, fixedTaskEnd(t))
  }
  for (const p of planning)
    if (
      p.enabled &&
      !eligible.has(p.task_id) &&
      taskById.get(p.task_id)?.status !== 'done'
    )
      result.unplaced.push({
        task_id: p.task_id,
        reason: '任务已固定时间、处于阻塞状态或项目未启用；保留原有安排'
      })
  // A prerequisite inherits the nearest downstream deadline so it does not strand urgent work.
  const deadlines = new Map(
    tasks.map((t) => [
      t.id,
      t.review_cycle ? Number.MAX_SAFE_INTEGER : t.due_at ?? Number.MAX_SAFE_INTEGER
    ])
  )
  for (let i = 0; i < planning.length; i++) {
    let changed = false
    for (const p of planning)
      if (eligible.has(p.task_id))
        for (const dep of p.dependencies) {
          if ((deadlines.get(dep) ?? Infinity) > deadlines.get(p.task_id)!) {
            deadlines.set(dep, deadlines.get(p.task_id)!)
            changed = true
          }
        }
    if (!changed) break
  }
  const fail = (id: string, reason: string): void => {
    result.unplaced.push({ task_id: id, reason })
    failed.add(id)
    pending.delete(id)
  }
  while (pending.size) {
    let advanced = false
    for (const id of [...pending]) {
      const p = options.get(id)!
      if (
        p.dependencies.some(
          (dep) => failed.has(dep) || (!pending.has(dep) && !finish.has(dep))
        )
      ) {
        fail(id, '前置任务未完成且没有可用安排')
        advanced = true
      }
    }
    const ready = [...pending]
      .filter((id) =>
        options.get(id)!.dependencies.every((dep) => finish.has(dep))
      )
      .sort(
        (a, b) =>
          deadlines.get(a)! - deadlines.get(b)! ||
          (taskById.get(a)!.review_due_at ?? Number.MAX_SAFE_INTEGER) -
            (taskById.get(b)!.review_due_at ?? Number.MAX_SAFE_INTEGER) ||
          options.get(b)!.priority - options.get(a)!.priority ||
          a.localeCompare(b)
      )
    if (!ready.length) {
      if (advanced) continue
      for (const id of pending) fail(id, '前置任务未就绪')
      break
    }
    const id = ready[0],
      p = options.get(id)!,
      t = taskById.get(id)!,
      reservations = preserved.filter(
        (b) => b.task_id === id && (!!t.review_cycle || b.end_at > lower)
      ),
      constrainedStart = Math.max(
        p.not_before ?? 0,
        t.review_due_at ?? 0,
        ...p.dependencies.map((dep) => finish.get(dep)!)
      ),
      earliest = Math.max(lower, constrainedStart),
      latest = t.review_cycle ? to : Math.min(to, t.due_at ?? to),
      reserved = reservations.reduce(
        (sum, b) =>
          sum + Math.max(0, b.end_at - Math.max(lower, b.start_at)) / MINUTE,
        0
      )
    if (
      reservations.some(
        (b) => b.start_at < constrainedStart || (!t.review_cycle && b.end_at > latest)
      )
    ) {
      fail(
        id,
        '保留的时间块不符合最早开始、截止或前置任务约束，请调整或解锁后重试'
      )
      continue
    }
    // An elapsed review reservation is not a successful review, but must not spawn another block every tick.
    const covered =
      t.review_cycle && reservations.length ? p.remaining_minutes : reserved
    let remaining =
      Math.ceil(Math.max(0, p.remaining_minutes - covered) / 5) * 5
    const proposed: PlannedBlock[] = [],
      localUsed = new Map(used)
    for (const slot of slots) {
      if (!remaining) break
      const occupied = [
        ...busy,
        ...proposed.map((b) => ({ start: b.start_at, end: b.end_at }))
      ].sort((a, b) => a.start - b.start)
      let cursor =
          Math.ceil(Math.max(slot.start, earliest) / (5 * MINUTE)) *
          (5 * MINUTE),
        end = Math.min(slot.end, latest)
      const free: [number, number][] = []
      for (const b of occupied) {
        if (b.end + buffer <= cursor || b.start - buffer >= end) continue
        if (b.start - buffer > cursor)
          free.push([cursor, Math.min(end, b.start - buffer)])
        cursor = Math.max(cursor, b.end + buffer)
      }
      if (cursor < end) free.push([cursor, end])
      for (const [a, z] of free) {
        cursor = Math.ceil(a / (5 * MINUTE)) * (5 * MINUTE)
        while (remaining > 0 && cursor < z) {
          const capacity =
            Math.floor(
              Math.min(
                (z - cursor) / MINUTE,
                settings.daily_minutes - (localUsed.get(slot.day) ?? 0)
              ) / 5
            ) * 5
          let take = Math.min(
            remaining,
            capacity,
            p.splittable ? p.max_minutes : remaining
          )
          // Avoid an unfillable tail smaller than the minimum; a whole short task is allowed.
          if (
            p.splittable &&
            remaining > take &&
            remaining - take < p.min_minutes
          )
            take -= p.min_minutes - (remaining - take)
          if (
            take <= 0 ||
            (!p.splittable && take < remaining) ||
            (take < p.min_minutes && take < remaining)
          )
            break
          proposed.push({
            ...(t.review_cycle ? { review_cycle: t.review_cycle } : {}),
            task_id: id,
            start_at: cursor,
            end_at: cursor + take * MINUTE,
            reason: `${t.review_cycle ? '到建议复习时间后；' : ''}避让固定日程；优先级 ${p.priority}；${p.dependencies.length ? '前置任务完成后；' : ''}按可用时段安排`
          })
          remaining -= take
          localUsed.set(slot.day, (localUsed.get(slot.day) ?? 0) + take)
          cursor += (take + settings.buffer_minutes) * MINUTE
        }
      }
    }
    if (remaining > 0) {
      fail(
        id,
        t.review_cycle
          ? '复习到期后没有足够的可用时段或每日容量；保留待复习，不改动记忆时间'
          : '截止前可用时段不足，或每日上限、分段长度不能满足；未写入部分安排'
      )
      continue
    }
    result.added.push(...proposed)
    proposed.forEach((b) => busy.push({ start: b.start_at, end: b.end_at }))
    used.clear()
    for (const [k, v] of localUsed) used.set(k, v)
    finish.set(
      id,
      Math.max(
        earliest,
        ...reservations.map((b) => b.end_at),
        ...proposed.map((b) => b.end_at)
      )
    )
    pending.delete(id)
  }
  for (const b of preserved)
    if (b.locked && b.end_at > lower) {
      const t = taskById.get(b.task_id)
      if (t?.due_at !== null && t?.due_at !== undefined && b.end_at > t.due_at)
        result.warnings.push(`${t.title} 的锁定时间块晚于截止时间，已保留`)
    }
  for (const [day, count] of used)
    if (count > settings.daily_minutes)
      result.warnings.push(`${day} 保留的学习时间已超过每日上限，未移动原安排`)
  const existing = [
    ...tasks
      .filter((t) => t.status !== 'done' && t.planned_at !== null)
      .map((t) => ({
        key: t.id,
        title: t.title,
        start: t.planned_at!,
        end: fixedTaskEnd(t)
      })),
    ...preserved
      .filter((b) => taskById.get(b.task_id)?.status !== 'done')
      .map((b) => ({
        key: b.id,
        title: taskById.get(b.task_id)?.title ?? '任务',
        start: b.start_at,
        end: b.end_at
      }))
  ]
    .filter((b) => b.start < to && b.end > lower)
    .sort((a, b) => a.start - b.start)
  let active: typeof existing = [],
    overlaps = 0
  for (const b of existing) {
    active = active.filter((a) => a.end > b.start)
    for (const a of active) {
      result.warnings.push(
        `保留安排存在重叠：${a.title} 与 ${b.title}，请手动处理`
      )
      if (++overlaps === 200) break
    }
    if (overlaps === 200) {
      result.warnings.push('保留安排的冲突较多，仅列出前 200 处')
      break
    }
    active.push(b)
  }
  return result
}
