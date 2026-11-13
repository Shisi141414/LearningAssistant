import ICAL from 'ical.js'
import { Temporal } from '@js-temporal/polyfill'
import { createHash } from 'node:crypto'
import type { Task } from '@shared/types'
import type { CalendarRange, CalendarImportEntry } from '@shared/calendar'

export const MAX_CALENDAR_BYTES = 5 * 1024 * 1024
export function validateCalendarRange(range: CalendarRange): void {
  if (
    ![range.from, range.to].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n < 8_640_000_000_000_000
    ) ||
    range.to <= range.from ||
    range.to - range.from > 366 * 86_400_000
  )
    throw new Error('请选择有效且不超过 366 天的导入范围')
}

/** VTIMEZONE 交给 ical.js；缺失 VTIMEZONE 的 IANA 标识交给 Temporal/Intl。 */
function timestamp(time: ICAL.Time, component: ICAL.Component, property: string): number {
  if (!time.isDate && time.zone.tzid !== 'floating') return time.toJSDate().getTime()
  const tzid = time.isDate
    ? null
    : (component.getFirstProperty(property)?.getParameter('tzid') ??
      component.getFirstProperty('dtstart')?.getParameter('tzid'))
  const timeZone =
    typeof tzid === 'string' ? tzid : Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    return Temporal.ZonedDateTime.from(
      {
        timeZone,
        year: time.year,
        month: time.month,
        day: time.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second
      },
      { disambiguation: 'reject' }
    ).epochMilliseconds
  } catch {
    throw new Error(`无法确定课表时间或时区：${timeZone}，请检查 ICS 的时区定义`)
  }
}

export function parseCalendarIcs(
  text: string,
  range: CalendarRange
): { entries: CalendarImportEntry[]; warnings: string[] } {
  validateCalendarRange(range)
  if (Buffer.byteLength(text) > MAX_CALENDAR_BYTES || text.includes('\0'))
    throw new Error('课表文件超过 5 MiB 或包含无效内容')
  if (text.split(/\r?\n/).length > 100_000) throw new Error('课表内容过多，请缩小范围后重新导出')
  const calendar = new ICAL.Component(ICAL.parse(text.replace(/^\uFEFF/, '')))
  if (calendar.name !== 'vcalendar') throw new Error('请选择有效的 ICS 日历文件')
  const components = calendar.getAllSubcomponents('vevent')
  if (!components.length) throw new Error('ICS 文件中没有课程或日程（VEVENT）')
  if (components.length > 5000) throw new Error('课表事件超过 5000 项，请分批导入')
  // METHOD:CANCEL 的例外实例可能只带 RECURRENCE-ID；补充内存中的起点，
  // 让上游例外解析能取消该次课程，不要求修改原 ICS 文件。
  for (const component of components) {
    if (
      component.getFirstPropertyValue('status') === 'CANCELLED' &&
      component.hasProperty('recurrence-id') &&
      !component.hasProperty('dtstart')
    ) {
      const event = new ICAL.Event(component)
      event.startDate = event.recurrenceId.clone()
    }
  }
  const entries = new Map<string, CalendarImportEntry>(),
    warnings = new Set<string>()
  if (calendar.getAllSubcomponents('vtodo').length)
    warnings.add('本次仅导入日历事件，未导入 VTODO 待办。')
  const add = (
    event: ICAL.Event,
    startDate: ICAL.Time,
    endDate: ICAL.Time,
    recurrence: ICAL.Time
  ): void => {
    if (event.component.getFirstPropertyValue('status') === 'CANCELLED') return
    const start = timestamp(startDate, event.component, 'dtstart'),
      end = timestamp(endDate, event.component, 'dtend')
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
      throw new Error('课表包含无效的起止时间')
    if (start >= range.to || (end > start ? end <= range.from : start < range.from)) return
    const title = event.summary || '未命名课程'
    const detail = event.description || '',
      location = event.location || ''
    if (title.length > 500 || detail.length > 200_000 || location.length > 1000)
      throw new Error('课表名称、说明或地点超过容量限制')
    if (!event.uid || event.uid.length > 2000)
      throw new Error('课表事件缺少有效 UID，无法安全识别重复项')
    const customKey = event.component.getFirstPropertyValue('x-learning-assistant-import-key')
    const key =
      typeof customKey === 'string' && /^[a-f0-9]{64}$/.test(customKey)
        ? customKey
        : createHash('sha256')
            .update(JSON.stringify([event.uid, recurrence.toString()]))
            .digest('hex')
    const local = event.component.getFirstPropertyValue('x-learning-assistant-task-id')
    const due = event.component.getFirstPropertyValue('x-learning-assistant-due')
    const dueAt = typeof due === 'string' && /^\d+$/.test(due) ? Number(due) : null
    if (dueAt !== null && (!Number.isSafeInteger(dueAt) || dueAt > 8_640_000_000_000_000))
      throw new Error('课表截止时间无效')
    entries.set(key, {
      key,
      title,
      detail,
      location,
      start,
      end,
      all_day: startDate.isDate,
      due_at: dueAt,
      done:
        event.component.getFirstPropertyValue('status') === 'COMPLETED' ||
        event.component.getFirstPropertyValue('x-learning-assistant-done') === 'true',
      local_id: typeof local === 'string' && local.length <= 128 ? local : null
    })
    if (entries.size > 5000) throw new Error('范围内超过 5000 项日程，请缩小导入范围')
  }
  let steps = 0
  for (const component of components) {
    if (
      component.getFirstPropertyValue('status') === 'CANCELLED' &&
      !component.hasProperty('recurrence-id')
    )
      continue
    const event = new ICAL.Event(component)
    if (!component.hasProperty('dtstart')) throw new Error('课表事件缺少开始时间')
    if (event.isRecurrenceException()) {
      add(event, event.startDate, event.endDate, event.recurrenceId)
      continue
    }
    if (!event.isRecurring()) {
      add(event, event.startDate, event.endDate, event.startDate)
      continue
    }
    const iterator = event.iterator()
    let next: ICAL.Time | null
    while ((next = iterator.next())) {
      if (++steps > 50_000)
        throw new Error('课表重复规则展开过多，请从学校重新导出较短时间范围的课表')
      if (timestamp(next, component, 'dtstart') >= range.to) break
      const occurrence = event.getOccurrenceDetails(next)
      add(occurrence.item, occurrence.startDate, occurrence.endDate, next)
    }
  }
  if (!entries.size) warnings.add('所选范围内没有日程，请调整导入日期。')
  warnings.add(
    '重复课程会展开为独立日程；编辑或删除只影响所选的一次。重复导入保留已有修改，不重新生成已删除项。'
  )
  return {
    entries: [...entries.values()].sort(
      (a, b) => a.start - b.start || a.title.localeCompare(b.title)
    ),
    warnings: [...warnings]
  }
}

export function serializeCalendarIcs(
  tasks: Task[],
  importKeys: Map<string, string> = new Map()
): { text: string; exported: number; unscheduled: number } {
  const calendar = new ICAL.Component(['vcalendar', [], []])
  calendar.updatePropertyWithValue('version', '2.0')
  calendar.updatePropertyWithValue('prodid', '-//LearningAssistant//Schedule//ZH')
  const scheduled = tasks.filter((t) => t.planned_at !== null || t.due_at !== null)
  if (scheduled.length > 5000) throw new Error('日程超过五千项，请先清理后导出')
  for (const task of scheduled) {
    const component = new ICAL.Component('vevent'),
      event = new ICAL.Event(component)
    event.uid = `${task.id}@learning-assistant.local`
    event.summary = task.title
    event.description = task.detail
    event.location = task.location
    const start = task.planned_at ?? task.due_at!
    const time = (ts: number): ICAL.Time => {
      if (!task.all_day) return ICAL.Time.fromJSDate(new Date(ts), true)
      const date = new Date(ts)
      return ICAL.Time.fromData({
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        isDate: true
      })
    }
    event.startDate = time(start)
    if (task.planned_end_at !== null) event.endDate = time(task.planned_end_at)
    component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
    component.updatePropertyWithValue('x-learning-assistant-task-id', task.id)
    if (task.due_at !== null)
      component.updatePropertyWithValue('x-learning-assistant-due', String(task.due_at))
    component.updatePropertyWithValue('x-learning-assistant-done', String(task.status === 'done'))
    if (importKeys.has(task.id))
      component.updatePropertyWithValue('x-learning-assistant-import-key', importKeys.get(task.id)!)
    calendar.addSubcomponent(component)
  }
  const text = calendar.toString() + '\r\n'
  if (Buffer.byteLength(text) > MAX_CALENDAR_BYTES)
    throw new Error('导出文件超过 5 MiB，请先清理过长的日程说明')
  return { text, exported: scheduled.length, unscheduled: tasks.length - scheduled.length }
}
