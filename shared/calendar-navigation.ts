export function validCalendarDate(value: string): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function calendarJumpTarget(input: { start: string; end: string; original_start: string; original_end: string; week: boolean }): string | null {
  const start = validCalendarDate(input.start), end = input.week ? validCalendarDate(input.end) : start
  if (!start || !end) return null
  return input.week && start === input.original_start && end !== input.original_end ? end : start
}
