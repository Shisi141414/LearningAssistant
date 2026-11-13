import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { parseCalendarIcs, serializeCalendarIcs } from '../src/main/services/calendar-ics.ts'
import { listAllTasks } from '../src/main/services/projects.ts'

registerAllIpc()
after(closeDb)
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
const range = {
  from: Date.parse('2026-09-01T00:00:00+08:00'),
  to: Date.parse('2027-01-01T00:00:00+08:00')
}
const ics = (events) =>
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\n' + events + '\r\nEND:VCALENDAR'
const event = (body, uid = 'course') => `BEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT`

test('v20 升级保留项目、时间和知识引用；失败迁移事务可恢复', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 20)) db.exec(m.sql)
  db.exec(
    `INSERT INTO projects(id,title,created_at,updated_at) VALUES ('p','项目',1,1); INSERT INTO tasks(id,kind,project_id,title,planned_at,knowledge_refs_json,created_at,updated_at) VALUES ('t','project_task','p','旧任务',123,'[{"concept_id":"k","why":"应用"}]',1,1)`
  )
  const migration = MIGRATIONS.find((m) => m.version === 21)
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec(migration.sql)
        throw Error('模拟中断')
      })(),
    /模拟中断/
  )
  assert.equal(
    db
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .some((c) => c.name === 'all_day'),
    false
  )
  db.exec(migration.sql)
  const t = db.prepare('SELECT * FROM tasks').get()
  assert.equal(t.project_id, 'p')
  assert.equal(t.planned_at, 123)
  assert.equal(t.all_day, 0)
  assert.equal(t.planned_end_at, null)
  assert.equal(JSON.parse(t.knowledge_refs_json)[0].concept_id, 'k')
  db.close()
})
test('日程时间可编辑；反向时间/无起点/无效 IPC 载荷拒绝，项目引用保留', async () => {
  const project = ok(await invoke('projects:create', { title: '课程项目' }))
  const t = ok(
    await invoke('tasks:create', {
      project_id: project.id,
      title: '安排',
      planned_at: range.from,
      planned_end_at: range.from + 3600000,
      location: '实验室'
    })
  )
  assert.equal(t.planned_end_at, range.from + 3600000)
  assert.equal(t.all_day, false)
  assert.equal(
    (await invoke('tasks:update', { id: t.id, planned_end_at: range.from - 1 })).ok,
    false
  )
  assert.equal(
    (await invoke('tasks:create', { title: '无开始', planned_end_at: range.from })).ok,
    false
  )
  assert.equal((await invoke('tasks:update', { id: t.id, all_day: 'yes' })).ok, false)
  const edited = ok(
    await invoke('tasks:update', {
      id: t.id,
      title: '修改名称',
      detail: '说明',
      location: '新地点',
      planned_end_at: range.from + 7200000
    })
  )
  assert.equal(edited.project_id, project.id)
  assert.equal(edited.location, '新地点')
  assert.equal((await invoke('calendar:preview', { from: 0, to: NaN })).ok, false)
  assert.equal(
    (
      await invoke('tasks:create', {
        title: '错误全天时间',
        planned_at: range.from + 3600000,
        all_day: true
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('calendar:import', 'token', {
        ignore_conflicts: 'yes',
        conflict_fingerprint: ''
      })
    ).ok,
    false
  )
})
test('ICS 周课表按 IANA 时区展开，跳课/补课/改期/取消、中文与转义保留', () => {
  const source = ics(
    event(
      'DTSTART;TZID=Asia/Shanghai:20260907T080000\r\nDTEND;TZID=Asia/Shanghai:20260907T093000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Asia/Shanghai:20260914T080000\r\nRDATE;TZID=Asia/Shanghai:20260909T080000\r\nSUMMARY:理论力学\r\nLOCATION:六教\\,301\r\nDESCRIPTION:讲义\\n第二行'
    ) +
      '\r\n' +
      event(
        'RECURRENCE-ID;TZID=Asia/Shanghai:20260921T080000\r\nDTSTART;TZID=Asia/Shanghai:20260922T100000\r\nDTEND;TZID=Asia/Shanghai:20260922T113000\r\nSUMMARY:调课'
      ) +
      '\r\n' +
      event(
        'RECURRENCE-ID;TZID=Asia/Shanghai:20260928T080000\r\nDTSTART;TZID=Asia/Shanghai:20260928T080000\r\nDTEND;TZID=Asia/Shanghai:20260928T093000\r\nSTATUS:CANCELLED\r\nSUMMARY:取消'
      )
  )
  const result = parseCalendarIcs(source, range)
  assert.equal(result.entries.length, 3)
  assert.equal(result.entries[0].start, Date.parse('2026-09-07T08:00:00+08:00'))
  assert.equal(result.entries[0].end - result.entries[0].start, 90 * 60000)
  assert.equal(result.entries[0].location, '六教,301')
  assert.equal(result.entries[0].detail, '讲义\n第二行')
  assert.equal(result.entries[2].title, '调课')
  assert.equal(result.entries[2].start, Date.parse('2026-09-22T10:00:00+08:00'))
})
test('UTC、全天跨日、跨夏令时的周课程及未知时区', () => {
  const range = { from: Date.parse('2026-03-01Z'), to: Date.parse('2026-04-01Z') }
  const result = parseCalendarIcs(
    ics(
      event(
        'DTSTART;TZID=America/New_York:20260302T090000\r\nDTEND;TZID=America/New_York:20260302T100000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nSUMMARY:DST'
      ) +
        '\r\n' +
        event('DTSTART;VALUE=DATE:20260310\r\nDTEND;VALUE=DATE:20260312\r\nSUMMARY:实验周', 'all')
    ),
    range
  )
  const timed = result.entries.filter((e) => !e.all_day)
  assert.equal(timed[0].start, Date.parse('2026-03-02T14:00:00Z'))
  assert.equal(timed[1].start, Date.parse('2026-03-09T13:00:00Z'))
  assert.equal(
    result.entries.find((e) => e.all_day).end - result.entries.find((e) => e.all_day).start,
    2 * 86400000
  )
  assert.throws(
    () =>
      parseCalendarIcs(ics(event('DTSTART;TZID=Not/AZone:20260302T090000\r\nSUMMARY:bad')), range),
    /时区/
  )
})
test('内嵌 VTIMEZONE 与不带 DTSTART 的取消实例按上游规则处理', () => {
  const source = ics(
    'BEGIN:VTIMEZONE\r\nTZID:School/Local\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n' +
      event(
        'DTSTART;TZID=School/Local:20260907T080000\r\nDTEND;TZID=School/Local:20260907T090000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nSUMMARY:自定义时区'
      ) +
      '\r\n' +
      event('RECURRENCE-ID;TZID=School/Local:20260914T080000\r\nSTATUS:CANCELLED')
  )
  const parsed = parseCalendarIcs(source, range)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].start, Date.parse('2026-09-07T08:00:00+08:00'))
})
test('日程导出再解析保留起止、截止、说明、地点与完成状态；无日期任务明确计数', async () => {
  const t = ok(
    await invoke('tasks:create', {
      title: '导出中文,公式',
      detail: '第一行\n第二行',
      planned_at: range.from + 28800000,
      planned_end_at: range.from + 32400000,
      due_at: range.from + 86400000,
      location: '实验室'
    })
  )
  ok(await invoke('tasks:update', { id: t.id, status: 'done' }))
  const noDate = ok(await invoke('tasks:create', { title: '待安排' }))
  const rows = listAllTasks().filter((row) => row.id === t.id || row.id === noDate.id),
    serialized = serializeCalendarIcs(rows)
  assert.equal(serialized.exported, 1)
  assert.equal(serialized.unscheduled, 1)
  const parsed = parseCalendarIcs(serialized.text, range).entries[0]
  assert.equal(parsed.title, t.title)
  assert.equal(parsed.detail, t.detail)
  assert.equal(parsed.start, t.planned_at)
  assert.equal(parsed.end, t.planned_end_at)
  assert.equal(parsed.due_at, t.due_at)
  assert.equal(parsed.done, true)
  assert.equal(parsed.local_id, t.id)
})
test('错误文件、过大日期范围、过密重复规则有界失败', () => {
  assert.throws(() => parseCalendarIcs('bad', range))
  assert.throws(() => parseCalendarIcs(ics(''), range), /没有/)
  assert.throws(
    () => parseCalendarIcs(ics(event('DTSTART:20260901T010000Z')), { from: 0, to: 500 * 86400000 }),
    /范围/
  )
  assert.throws(
    () =>
      parseCalendarIcs(
        ics(event('DTSTART:20260901T010000Z\r\nRRULE:FREQ=SECONDLY\r\nSUMMARY:dense')),
        range
      ),
    /5000|过多/
  )
})

test('冲突检测覆盖既有/同批、包含/跨日、相邻边界，报告上限与复核指纹', async () => {
  const { calendarConflicts, occupiedEnd } = await import(
    '../src/main/services/calendar-conflicts.ts'
  )
  const item = (key, start, end) => ({ key, title: key, start, end })
  const fresh = [item('a', 10, 20), item('b', 15, 18), item('c', 20, 30)]
  const old = [item('old', 0, 16), item('adjacent', 30, 40)]
  const result = calendarConflicts(fresh, old)
  assert.equal(result.items.length, 3)
  assert.equal(result.items.filter((c) => c.kind === 'import').length, 1)
  assert.equal(
    result.items.some((c) => c.other.key === 'adjacent'),
    false
  )
  assert.equal(calendarConflicts([...fresh].reverse(), old).fingerprint, result.fingerprint)
  assert.notEqual(
    calendarConflicts(fresh, [...old, item('new', 11, 12)]).fingerprint,
    result.fingerprint
  )
  assert.equal(
    calendarConflicts([item('long', 0, 100), item('short', 10, 20)], [item('later', 50, 60)]).items
      .length,
    2
  )
  const many = calendarConflicts(
    Array.from({ length: 100 }, (_, i) => item(String(i), 0, 100)),
    []
  )
  assert.equal(many.items.length, 200)
  assert.equal(many.truncated, true)
  assert.equal(occupiedEnd(0, null, false), 3600000)
  const day = new Date(2026, 10, 13).getTime()
  assert.equal(occupiedEnd(day, null, true), new Date(2026, 10, 14).getTime())
})
test('日程浅色按学科/项目/课程稳定分配且文字对比度可读', async () => {
  const { scheduleCategory, scheduleColor } = await import('../shared/schedule-colors.ts')
  const subjects = [{ id: 's', name: '理论力学' }],
    base = {
      title: '理论力学第1讲',
      project_id: null,
      project_title: null,
      project_subject_id: null
    }
  const category = scheduleCategory(base, subjects)
  assert.equal(scheduleCategory({ ...base, title: '理论力学第2讲' }, subjects), category)
  assert.equal(
    scheduleCategory(
      { ...base, title: '作业', project_id: 'p', project_subject_id: 's' },
      subjects
    ),
    category
  )
  assert.equal(
    scheduleCategory({ ...base, project_id: 'p', project_title: '设计' }, subjects),
    '项目：设计'
  )
  assert.equal(
    scheduleCategory({ ...base, title: '工程热力学第1讲' }, []),
    scheduleCategory({ ...base, title: '工程热力学第2讲' }, [])
  )
  assert.deepEqual(scheduleColor(category), scheduleColor(category))
  const light = (hex) => {
    const c = hex
      .match(/[a-f0-9]{2}/gi)
      .map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const colors = new Set()
  for (let i = 0; i < 80; i++) {
    const color = scheduleColor(String(i))
    colors.add(color.background)
    assert.ok((light(color.background) + 0.05) / (light(color.text) + 0.05) >= 4.5)
  }
  assert.equal(colors.size, 8)
})

test('手工新建和编辑以同一事务检查冲突，拒绝不落盘；确认过期不能绕过；编辑排除自身', async () => {
  const start = new Date(2027, 2, 1, 8).getTime(),
    hour = 3600000
  const anchor = ok(
    await invoke('tasks:create', {
      title: '已有课程',
      planned_at: start,
      planned_end_at: start + hour
    })
  )
  const task = {
    title: '手工新建',
    planned_at: start + hour / 2,
    planned_end_at: start + 1.5 * hour
  }
  const before = listAllTasks().length
  const first = ok(await invoke('calendar:save', { task }))
  assert.equal(first.task, null)
  assert.equal(first.conflicts.items.length, 1)
  assert.equal(listAllTasks().length, before)
  const another = ok(
    await invoke('tasks:create', {
      title: '确认前新增',
      planned_at: start + hour / 2,
      planned_end_at: start + hour
    })
  )
  const stale = ok(
    await invoke('calendar:save', {
      task,
      confirmation: { ignore_conflicts: true, conflict_fingerprint: first.conflicts.fingerprint }
    })
  )
  assert.equal(stale.task, null)
  assert.equal(stale.conflicts.items.length, 2)
  assert.equal(listAllTasks().length, before + 1)
  const created = ok(
    await invoke('calendar:save', {
      task,
      confirmation: { ignore_conflicts: true, conflict_fingerprint: stale.conflicts.fingerprint }
    })
  ).task
  assert.ok(created)
  assert.equal(listAllTasks().length, before + 2)
  ok(await invoke('tasks:remove', anchor.id))
  ok(await invoke('tasks:remove', another.id))
  const self = ok(
    await invoke('calendar:save', { id: created.id, task: { ...task, detail: '排除自己' } })
  )
  assert.equal(self.task.id, created.id)
  assert.equal(self.task.detail, '排除自己')
  ok(
    await invoke('tasks:create', {
      title: '改期冲突',
      planned_at: start + 2 * hour,
      planned_end_at: start + 3 * hour
    })
  )
  const shifted = { ...task, planned_at: start + 2.5 * hour, planned_end_at: start + 3.5 * hour }
  const declined = ok(await invoke('calendar:save', { id: created.id, task: shifted }))
  assert.equal(declined.task, null)
  assert.equal(listAllTasks().find((t) => t.id === created.id).planned_at, task.planned_at)
  const accepted = ok(
    await invoke('calendar:save', {
      id: created.id,
      task: shifted,
      confirmation: { ignore_conflicts: true, conflict_fingerprint: declined.conflicts.fingerprint }
    })
  )
  assert.equal(accepted.task.planned_at, shifted.planned_at)
  assert.ok(
    ok(
      await invoke('calendar:save', {
        task: {
          title: '相邻无冲突',
          planned_at: shifted.planned_end_at,
          planned_end_at: shifted.planned_end_at + hour
        }
      })
    ).task
  )
  assert.equal(
    (
      await invoke('calendar:save', {
        task: { title: '无效', planned_at: start, planned_end_at: start - 1 }
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('calendar:save', {
        task,
        confirmation: { ignore_conflicts: 'yes', conflict_fingerprint: '' }
      })
    ).ok,
    false
  )
})
