import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planSchedule,
  assertAcyclic,
  validateScheduleSettings,
  planningDateRange,
  scheduleDateInZone,
  defaultTaskPlanning
} from '../shared/auto-schedule.ts'
const at = (day, time) => Date.parse(`2026-11-${day}T${time}:00+08:00`)
const task = (id, extra = {}) => ({
  id,
  title: id,
  status: 'open',
  project_status: null,
  due_at: at('17', '23:00'),
  planned_at: null,
  planned_end_at: null,
  all_day: false,
  ...extra
})
const planning = (id, extra = {}) => ({
  ...defaultTaskPlanning(id),
  revision: 'r',
  enabled: true,
  ...extra
})
const settings = {
  timezone: 'Asia/Shanghai',
  daily_minutes: 120,
  buffer_minutes: 10,
  availability: [
    { weekday: 1, start: '19:00', end: '22:00' },
    { weekday: 2, start: '19:00', end: '22:00' }
  ]
}
const input = (extra) => ({
  settings,
  tasks: [task('a')],
  planning: [planning('a')],
  blocks: [],
  from: at('16', '00:00'),
  to: at('18', '00:00'),
  now: at('15', '18:00'),
  ...extra
})
const block = (extra = {}) => ({
  id: 'lock',
  task_id: 'a',
  revision: 'r',
  start_at: at('16', '19:00'),
  end_at: at('16', '19:30'),
  locked: true,
  reason: '',
  ...extra
})
test('自动排程避让课程和缓冲，分段不超过每日上限，输入不被修改', () => {
  const fixture = input({
    tasks: [
      task('a'),
      task('course', {
        planned_at: at('16', '19:00'),
        planned_end_at: at('16', '20:00')
      })
    ],
    planning: [planning('a', { remaining_minutes: 180 })]
  })
  const before = JSON.stringify(fixture),
    r = planSchedule(fixture)
  assert.equal(JSON.stringify(fixture), before)
  assert.equal(r.unplaced.length, 0)
  assert.equal(
    r.added.reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0),
    180
  )
  assert.equal(r.added[0].start_at, at('16', '20:10'))
  for (const d of ['16', '17'])
    assert.ok(
      r.added
        .filter(
          (b) =>
            b.start_at >= at(d, '00:00') &&
            b.start_at < at(String(Number(d) + 1), '00:00')
        )
        .reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0) <= 120
    )
})
test('前置任务继承紧迫截止时间；后继只在前置安排完后开始', () => {
  const r = planSchedule(
    input({
      tasks: [
        task('a', { due_at: null }),
        task('b', { due_at: at('16', '22:00') }),
        task('c', { due_at: at('17', '22:00') })
      ],
      planning: [
        planning('a'),
        planning('b', { dependencies: ['a'] }),
        planning('c', { priority: 3 })
      ]
    })
  )
  assert.equal(r.added[0].task_id, 'a')
  assert.equal(r.added[1].task_id, 'b')
  assert.ok(r.added[1].start_at >= r.added[0].end_at + 10 * 60000)
})
test('锁定、已开始、非启用和范围外块保留；可重排块进入明确删除列表', () => {
  const blocks = [
    block(),
    block({
      id: 'old',
      locked: false,
      start_at: at('17', '20:00'),
      end_at: at('17', '20:30')
    }),
    block({
      id: 'past',
      locked: false,
      start_at: at('15', '17:00'),
      end_at: at('15', '18:00')
    })
  ]
  const r = planSchedule(input({ blocks }))
  assert.deepEqual(
    r.removed.map((b) => b.id),
    ['old']
  )
  assert.equal(
    r.added.reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0),
    30
  )
  assert.ok(r.added[0].start_at >= blocks[0].end_at + 10 * 60000)
})
test('不足时不产生部分安排，不擅改截止时间，前置失败传递给后继', () => {
  const r = planSchedule(
    input({
      tasks: [task('a', { due_at: at('16', '19:40') }), task('b')],
      planning: [
        planning('a', { remaining_minutes: 180 }),
        planning('b', { dependencies: ['a'] })
      ]
    })
  )
  assert.equal(r.added.length, 0)
  assert.deepEqual(
    r.unplaced.map((p) => p.task_id),
    ['a', 'b']
  )
})
test('非分段任务不拆开；仅修改剩余用时才会把已过去的块当作完成', () => {
  const r = planSchedule(
    input({
      planning: [planning('a', { remaining_minutes: 180, splittable: false })],
      blocks: [
        block({
          locked: false,
          start_at: at('15', '17:00'),
          end_at: at('15', '18:00')
        })
      ]
    })
  )
  assert.equal(r.added.length, 0)
  assert.equal(r.unplaced.length, 1)
})
test('循环依赖、重叠可用时段、非法时间和过大范围被拒绝', () => {
  assert.throws(
    () =>
      assertAcyclic([
        planning('a', { dependencies: ['b'] }),
        planning('b', { dependencies: ['a'] })
      ]),
    /循环/
  )
  assert.throws(
    () =>
      validateScheduleSettings({
        ...settings,
        availability: [
          { weekday: 1, start: '19:00', end: '22:00' },
          { weekday: 1, start: '21:00', end: '23:00' }
        ]
      }),
    /重叠/
  )
  assert.throws(
    () => planSchedule(input({ to: at('18', '00:00') + 32 * 86400000 })),
    /31/
  )
})
test('已完成前置满足，未启用的未完成前置不可凭空跳过，阻塞项目不排', () => {
  assert.equal(
    planSchedule(
      input({
        tasks: [task('a'), task('dep', { status: 'done' })],
        planning: [planning('a', { dependencies: ['dep'] })]
      })
    ).added.length,
    1
  )
  assert.equal(
    planSchedule(
      input({
        tasks: [task('a'), task('dep')],
        planning: [planning('a', { dependencies: ['dep'] })]
      })
    ).unplaced.length,
    1
  )
  assert.equal(
    planSchedule(input({ tasks: [task('a', { project_status: 'paused' })] }))
      .added.length,
    0
  )
})
test('DST 缺失/歧义时段显式跳过而非静默改时间', () => {
  const r = planSchedule(
    input({
      settings: {
        ...settings,
        timezone: 'America/New_York',
        availability: [{ weekday: 7, start: '01:30', end: '03:30' }]
      },
      from: Date.parse('2026-11-01T00:00:00-04:00'),
      to: Date.parse('2026-11-02T00:00:00-05:00'),
      now: 0
    })
  )
  assert.equal(r.added.length, 0)
  assert.ok(r.warnings.some((w) => w.includes('夏令时')))
})
test('输出稳定，相邻短尾合并为合法分段，最早开始和截止均被遵守', () => {
  const fixture = input({
    planning: [
      planning('a', { remaining_minutes: 70, not_before: at('16', '20:00') })
    ]
  })
  const r = planSchedule(fixture)
  assert.deepEqual(r, planSchedule(fixture))
  assert.deepEqual(
    r.added.map((b) => (b.end_at - b.start_at) / 60000),
    [45, 25]
  )
  assert.equal(r.added[0].start_at, at('16', '20:00'))
})
test('正在进行的保留块不被当作约束冲突，补充安排按五分钟向上取整', () => {
  const now = at('16', '19:10') + 32000
  const r = planSchedule(input({ now, blocks: [block({ locked: false })] }))
  assert.equal(r.unplaced.length, 0)
  assert.equal(r.removed.length, 0)
  assert.ok(
    r.added.every(
      (b) =>
        b.start_at >= at('16', '19:40') &&
        (b.end_at - b.start_at) % (5 * 60000) === 0
    )
  )
  assert.equal(
    r.added.reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0),
    45
  )
})
test('不同约束组合生成的所有安排均满足间隔、时段、每日上限及依赖', () => {
  for (let seed = 0; seed < 30; seed++) {
    const tasks = Array.from({ length: 8 }, (_, i) =>
        task('t' + i, {
          due_at: i % 2 === 0 ? at('16', '22:00') : at('17', '22:00')
        })
      ),
      ps = tasks.map((t, i) =>
        planning(t.id, {
          remaining_minutes: 25 + (((i + seed) * 5) % 60),
          priority: (i + seed) % 4,
          dependencies: i % 3 === 1 ? ['t' + (i - 1)] : []
        })
      ),
      fixed = task('course', {
        planned_at: at('16', '20:00'),
        planned_end_at: at('16', '20:30')
      }),
      r = planSchedule(input({ tasks: [...tasks, fixed], planning: ps })),
      all = r.added
    const daily = new Map()
    for (const a of all) {
      assert.ok(
        a.start_at >= at('16', '19:00') &&
          a.end_at <= tasks.find((t) => t.id === a.task_id).due_at
      )
      const day = a.start_at < at('17', '00:00') ? '16' : '17'
      assert.ok(a.start_at >= at(day, '19:00') && a.end_at <= at(day, '22:00'))
      assert.ok(
        a.end_at + 600000 <= fixed.planned_at ||
          a.start_at >= fixed.planned_end_at + 600000
      )
      daily.set(day, (daily.get(day) || 0) + (a.end_at - a.start_at) / 60000)
      for (const b of all)
        if (a !== b)
          assert.ok(
            a.end_at + 600000 <= b.start_at || b.end_at + 600000 <= a.start_at
          )
      for (const dep of ps.find((p) => p.task_id === a.task_id).dependencies) {
        const previous = all.filter((b) => b.task_id === dep)
        assert.ok(previous.length)
        assert.ok(a.start_at >= Math.max(...previous.map((b) => b.end_at)))
      }
    }
    assert.ok([...daily.values()].every((n) => n <= 120))
  }
})
test('锁定冲突与超额负荷可见，未启用和范围外安排不会被删除', () => {
  const lock = block({ end_at: at('16', '22:00') }),
    outside = block({
      id: 'outside',
      locked: false,
      start_at: at('19', '19:00'),
      end_at: at('19', '20:00')
    }),
    r = planSchedule(
      input({
        tasks: [
          task('a'),
          task('course', {
            planned_at: at('16', '20:00'),
            planned_end_at: at('16', '21:00')
          })
        ],
        blocks: [lock, outside]
      })
    )
  assert.equal(r.removed.length, 0)
  assert.ok(r.warnings.some((w) => w.includes('重叠')))
  assert.ok(r.warnings.some((w) => w.includes('每日上限')))
  assert.equal(
    planSchedule(
      input({
        blocks: [block({ locked: false })],
        planning: [planning('a', { enabled: false })]
      })
    ).removed.length,
    0
  )
})
test('排程日期遵循所选时区，31 个自然日跨夏令时仍合法，不存在的整日被拒绝', () => {
  const range = planningDateRange(
    '2026-11-13',
    '2026-11-13',
    'America/New_York'
  )
  assert.equal(range.from, Date.parse('2026-11-13T00:00:00-05:00'))
  assert.equal(range.to, Date.parse('2026-11-14T00:00:00-05:00'))
  assert.equal(
    scheduleDateInZone(Date.parse('2026-11-13T01:00:00Z'), 'America/New_York'),
    '2026-11-12'
  )
  const dst = planningDateRange('2026-10-20', '2026-11-19', 'America/New_York')
  assert.equal(dst.to - dst.from, 31 * 86400000 + 3600000)
  assert.doesNotThrow(() =>
    planSchedule(
      input({
        ...dst,
        now: 0,
        tasks: [],
        planning: [],
        settings: { ...settings, timezone: 'America/New_York' }
      })
    )
  )
  assert.throws(
    () => planningDateRange('2011-12-30', '2011-12-30', 'Pacific/Apia'),
    /日期/
  )
})
