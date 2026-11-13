import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calendarFollowTime,
  calendarVisibleStart
} from '../shared/calendar-follow.ts'
const at = (hour, minute = 0) => new Date(2026, 10, 13, hour, minute).getTime()
const range = { start: at(0), end: at(24) }
test('日/周优先展示当前时间后方；21点定位20点，非今天及月视图不跟随', () => {
  assert.equal(calendarFollowTime(at(21), range, 'timeGridDay'), '20:00:00')
  assert.equal(
    calendarFollowTime(at(21, 45), range, 'timeGridWeek'),
    '20:45:00'
  )
  assert.equal(calendarFollowTime(at(0, 15), range, 'timeGridWeek'), '00:00:00')
  assert.equal(calendarFollowTime(at(24), range, 'timeGridDay'), null)
  assert.equal(calendarFollowTime(at(21), range, 'dayGridMonth'), null)
})
test('今天6点之前或自定义起点晚于当前时间时，仍让红线进入时间轴；其他日期保留设置', () => {
  assert.equal(calendarVisibleStart('06:00:00', at(5, 20), true), '05:00:00')
  assert.equal(calendarVisibleStart('23:00:00', at(21), true), '21:00:00')
  assert.equal(calendarVisibleStart('06:00:00', at(21), true), '06:00:00')
  assert.equal(calendarVisibleStart('06:00:00', at(5), false), '06:00:00')
})
