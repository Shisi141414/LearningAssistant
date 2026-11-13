import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validCalendarDate, calendarJumpTarget } from '../shared/calendar-navigation.ts'
test('日期严格校验实际存在的年月日，不接受自动进位和不完整输入', () => {
  for (const input of ['2026-02-30', '2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11', '11/13', 'hello', '0000-01-01']) assert.equal(validCalendarDate(input), null, input)
  assert.equal(validCalendarDate('2000-2-29'), '2000-02-29')
  assert.equal(validCalendarDate('2026-11-13'), '2026-11-13')
})
test('周视图只改结束日使用结束日，同时修改时起始日期优先', () => {
  const input = { start: '2026-11-09', end: '2026-11-15', original_start: '2026-11-09', original_end: '2026-11-15', week: true }
  assert.equal(calendarJumpTarget({ ...input, end: '2026-12-31' }), '2026-12-31')
  assert.equal(calendarJumpTarget({ ...input, start: '2026-12-01', end: '2026-12-31' }), '2026-12-01')
  assert.equal(calendarJumpTarget({ ...input, start: '2026-12-01', end: '2026-02-30' }), null)
  assert.equal(calendarJumpTarget({ ...input, start: '2026-12-01', end: '', week: false }), '2026-12-01')
})
