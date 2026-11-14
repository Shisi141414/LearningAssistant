import { Temporal } from '@js-temporal/polyfill'

export interface ReminderSettings {
  enabled: boolean
  system_enabled: boolean
  background_enabled: boolean
  start_lead_minutes: number
  due_lead_minutes: number
  catchup_minutes: number
  all_day_time: string
  quiet_enabled: boolean
  quiet_start: string
  quiet_end: string
}
export interface ReminderTaskOptions {
  task_id: string
  revision: string | null
  enabled: boolean
  start_lead_minutes: number | null
  due_lead_minutes: number | null
}
export type ReminderStatus =
  | 'pending'
  | 'published'
  | 'dismissed'
  | 'snoozed'
  | 'cancelled'
  | 'expired'
export type SystemDeliveryStatus =
  | 'pending'
  | 'claimed'
  | 'shown'
  | 'failed'
  | 'uncertain'
  | 'skipped'
  | 'cancelled'
export interface ReminderItem {
  review_id?: string | null
  id: string
  task_id: string
  event_key: string
  kind: 'start' | 'due' | 'block'
  source_id: string
  event_at: number
  remind_at: number
  title: string
  location: string
  status: ReminderStatus
  published_at: number | null
  revision: string
  system_status: SystemDeliveryStatus | null
  system_error: string | null
}
export interface ReminderCapabilities {
  system_supported: boolean
  background_active: boolean
  packaged: boolean
  error: string
}
export interface ReminderConfiguration {
  revision: string | null
  value: ReminderSettings
  capabilities: ReminderCapabilities
}
export interface ReminderPage {
  items: ReminderItem[]
  total: number
  next_offset: number | null
  attention_count: number
  upcoming_count: number
}
export interface ReminderAction {
  id: string
  expected_revision: string
  action: 'dismiss' | 'snooze' | 'complete' | 'retry'
  minutes?: number
}
export const defaultReminderSettings = (): ReminderSettings => ({
  enabled: true,
  system_enabled: false,
  background_enabled: false,
  start_lead_minutes: 10,
  due_lead_minutes: 60,
  catchup_minutes: 120,
  all_day_time: '09:00',
  quiet_enabled: false,
  quiet_start: '22:00',
  quiet_end: '07:00'
})
const clock = /^([01]\d|2[0-3]):[0-5]\d$/
export function validLead(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 10080
  )
}
export function validateReminderSettings(s: ReminderSettings): void {
  if (
    !validLead(s.start_lead_minutes) ||
    !validLead(s.due_lead_minutes) ||
    !validLead(s.catchup_minutes) ||
    s.catchup_minutes < 1
  )
    throw Error('提前量为 0–10080 分钟，补发窗口为 1–10080 分钟')
  if (
    !clock.test(s.all_day_time) ||
    !clock.test(s.quiet_start) ||
    !clock.test(s.quiet_end) ||
    s.quiet_start === s.quiet_end
  )
    throw Error(
      '请输入有效的全天提醒与免打扰起止时间；免打扰开始和结束不能相同'
    )
}
export function validateReminderTask(p: ReminderTaskOptions): void {
  if (
    ![p.start_lead_minutes, p.due_lead_minutes].every(
      (v) => v === null || validLead(v)
    )
  )
    throw Error('任务提前量为 0–10080 分钟；留空表示跟随全局设置')
}
/** Quiet hours affect system banners only; the in-app inbox remains available. */
export function quietUntil(
  now: number,
  s: ReminderSettings,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): number | null {
  if (!s.quiet_enabled) return null
  const z =
      Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timezone),
    time = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`,
    crosses = s.quiet_start > s.quiet_end,
    inside = crosses
      ? time >= s.quiet_start || time < s.quiet_end
      : time >= s.quiet_start && time < s.quiet_end
  if (!inside) return null
  const day =
    crosses && time >= s.quiet_start
      ? z.toPlainDate().add({ days: 1 })
      : z.toPlainDate()
  return day
    .toPlainDateTime(s.quiet_end)
    .toZonedDateTime(timezone, { disambiguation: 'later' }).epochMilliseconds
}
export function allDayReminderEvent(
  start: number,
  s: ReminderSettings,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
): number {
  return Temporal.Instant.fromEpochMilliseconds(start)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toPlainDateTime(s.all_day_time)
    .toZonedDateTime(timezone, { disambiguation: 'later' }).epochMilliseconds
}
