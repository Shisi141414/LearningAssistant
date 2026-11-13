export function calendarFollowTime(
  now: number,
  range: { start: number; end: number } | null,
  view: string
): string | null {
  if (
    !view.startsWith('timeGrid') ||
    !range ||
    now < range.start ||
    now >= range.end
  )
    return null
  const date = new Date(now),
    minutes = Math.max(0, date.getHours() * 60 + date.getMinutes() - 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`
}
export function calendarVisibleStart(
  start: string,
  now: number,
  following: boolean
): string {
  if (!following) return start
  const current = `${String(new Date(now).getHours()).padStart(2, '0')}:00:00`
  return current < start ? current : start
}
