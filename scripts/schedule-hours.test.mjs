import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleStartTime } from '../shared/schedule-hours.ts'

const time = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const range = { start: time(9), end: time(16) }
const task = (start, end = null, extra = {}) => ({ planned_at: start, planned_end_at: end, all_day: false, due_at: null, ...extra })

test('默认从六点开始，关掉开关回到午夜；午夜以外的全天事件不影响时间轴', () => {
  assert.equal(scheduleStartTime(true, range, []), '06:00:00')
  assert.equal(scheduleStartTime(false, range, []), '00:00:00')
  assert.equal(scheduleStartTime(true, range, [task(time(9), time(10), { all_day: true })]), '06:00:00')
})
test('只看当前日期范围，并保留六点前的日程与截止时刻', () => {
  assert.equal(scheduleStartTime(true, range, [task(time(9, 5, 45))]), '05:30:00')
  assert.equal(scheduleStartTime(true, range, [task(time(8, 1)), task(time(16, 1))]), '06:00:00')
  assert.equal(scheduleStartTime(true, range, [task(null, null, { due_at: time(10, 2, 10) })]), '02:00:00')
})
test('跨午夜与视图边界的事件显示午夜，恰好午夜结束不占下一天', () => {
  assert.equal(scheduleStartTime(true, range, [task(time(8, 23), time(9, 7))]), '00:00:00')
  assert.equal(scheduleStartTime(true, range, [task(time(10, 23), time(11, 8))]), '00:00:00')
  assert.equal(scheduleStartTime(true, range, [task(time(10, 23), time(11))]), '06:00:00')
  assert.equal(scheduleStartTime(true, range, [task(time(8, 23), time(9))]), '06:00:00')
})
