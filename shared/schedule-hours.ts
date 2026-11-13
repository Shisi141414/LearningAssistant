import type { Task } from './types'

type TimedTask = Pick<Task, 'planned_at' | 'planned_end_at' | 'all_day' | 'due_at'>

/** The current view's exclusive date range; all-day rows do not need time slots. */
export function scheduleStartTime(
  fromSix: boolean,
  range: { start: number; end: number } | null,
  tasks: TimedTask[],
  preferredMinutes = 360
): string {
  if (!fromSix) return '00:00:00'
  const preferred = Number.isInteger(preferredMinutes) && preferredMinutes >= 0 && preferredMinutes < 1440 ? preferredMinutes : 360
  let minutes = preferred
  if (range) for (const task of tasks) {
    const intervals: [number, number][] = []
    if (task.planned_at !== null && !task.all_day) {
      intervals.push([task.planned_at, task.planned_end_at ?? task.planned_at + 3600000])
    }
    if (task.due_at !== null && task.due_at !== task.planned_at) intervals.push([task.due_at, task.due_at])
    for (const [start, end] of intervals) {
      if (start >= range.end || (end > start ? end <= range.start : start < range.start)) continue
      const visibleStart = new Date(Math.max(start, range.start))
      minutes = Math.min(minutes, visibleStart.getHours() * 60 + visibleStart.getMinutes())
      const nextMidnight = new Date(visibleStart)
      nextMidnight.setHours(24, 0, 0, 0)
      if (end > nextMidnight.getTime() && nextMidnight.getTime() < range.end) minutes = 0
    }
  }
  if (minutes < preferred) minutes = Math.floor(minutes / 30) * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
}
