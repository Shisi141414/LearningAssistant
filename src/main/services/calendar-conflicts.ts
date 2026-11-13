import { createHash } from 'node:crypto'
import type { CalendarConflictItem, CalendarConflicts } from '@shared/calendar'

/** Half-open intervals: an event ending at 10:00 does not overlap one starting at 10:00. */
export function calendarConflicts(
  incoming: CalendarConflictItem[],
  existing: CalendarConflictItem[]
): CalendarConflicts {
  const sort = (a: CalendarConflictItem, b: CalendarConflictItem): number =>
    a.start - b.start || a.key.localeCompare(b.key)
  const fresh = [...incoming].sort(sort),
    old = [...existing].sort(sort)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([fresh, old]))
    .digest('hex')
  const items: CalendarConflicts['items'] = []
  let activeOld: CalendarConflictItem[] = [],
    activeNew: CalendarConflictItem[] = [],
    cursor = 0
  for (const item of fresh) {
    activeOld = activeOld.filter((other) => other.end > item.start)
    activeNew = activeNew.filter((other) => other.end > item.start)
    while (cursor < old.length && old[cursor].start < item.end) {
      if (old[cursor].end > item.start) activeOld.push(old[cursor])
      cursor++
    }
    for (const [others, kind] of [
      [activeOld, 'existing'],
      [activeNew, 'import']
    ] as const) {
      for (const other of others) {
        if (item.start >= other.end || other.start >= item.end) continue
        if (items.length === 200) return { items, truncated: true, fingerprint }
        items.push({ incoming: item, other, kind })
      }
    }
    activeNew.push(item)
  }
  return { items, truncated: false, fingerprint }
}

export function occupiedEnd(start: number, end: number | null, allDay: boolean): number {
  if (end !== null && end > start) return end
  if (!allDay) return start + 3600000
  const next = new Date(start)
  next.setDate(next.getDate() + 1)
  return next.getTime()
}
