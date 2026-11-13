import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { nanoid } from 'nanoid'
import type {
  PlannerInput,
  PlannerResult,
  PlanningPreview,
  PlanningState,
  ScheduleBlock,
  ScheduleSettings,
  TaskPlanningSave
} from '@shared/auto-schedule'
import {
  assertAcyclic,
  defaultScheduleSettings,
  validateScheduleSettings,
  validateTaskPlanning
} from '@shared/auto-schedule'
import { dbFilePath, getDb } from './db'
import { withWork } from './work'

interface Snapshot {
  state: PlanningState
  tasks: PlannerInput['tasks']
  fingerprint: string
}
interface Preview {
  token: string
  fingerprint: string
  expires: number
  data: PlanningPreview
}
const previews = new Map<number, Preview>(),
  workers = new Map<number, () => void>()
let stopping = false
function assertRunning(): void {
  if (stopping) throw Error('自动排程已停止')
}
export function discardSchedulePreview(owner: number): void {
  previews.delete(owner)
  workers.get(owner)?.()
  workers.delete(owner)
}
export function hasInteractiveScheduleWork(): boolean {
  for (const [owner, preview] of previews) {
    if (preview.expires < Date.now()) previews.delete(owner)
  }
  return [...workers.keys(), ...previews.keys()].some(owner => owner >= 0)
}
export function stopScheduleJobs(): void {
  stopping = true
  for (const owner of workers.keys()) discardSchedulePreview(owner)
  previews.clear()
}
export function listScheduleBlocks(): ScheduleBlock[] {
  const rows = getDb()
    .prepare('SELECT * FROM schedule_blocks ORDER BY start_at,id LIMIT 10001')
    .all() as Array<Omit<ScheduleBlock, 'locked'> & { locked: number }>
  if (rows.length > 10000) throw Error('学习时间块超过一万项，请先清理历史安排')
  return rows.map((b) => ({ ...b, locked: !!b.locked }))
}
function snapshot(): Snapshot {
  const db = getDb(),
    settings = db
      .prepare('SELECT revision,value_json FROM schedule_settings WHERE id=1')
      .get() as { revision: string; value_json: string } | undefined,
    rows = db
      .prepare('SELECT * FROM task_planning ORDER BY task_id LIMIT 501')
      .all() as { task_id: string; revision: string; options_json: string }[],
    deps = db
      .prepare('SELECT * FROM task_dependencies ORDER BY task_id,depends_on_id')
      .all() as { task_id: string; depends_on_id: string }[],
    tasks = db
      .prepare(
        'SELECT t.id,t.title,t.status,t.due_at,t.planned_at,t.planned_end_at,t.all_day,t.updated_at,p.status AS project_status FROM tasks t LEFT JOIN projects p ON t.project_id=p.id ORDER BY t.id LIMIT 5001'
      )
      .all() as Array<PlannerInput['tasks'][number] & { updated_at: number }>,
    latest = db
      .prepare(
        'SELECT id,created_at FROM schedule_runs WHERE undone_at IS NULL ORDER BY rowid DESC LIMIT 1'
      )
      .get() as PlanningState['latest_run'] | undefined
  if (tasks.length > 5000 || rows.length > 500)
    throw Error('最多支持五千项任务、五百项自动排程配置，请先清理历史任务')
  const state: PlanningState = {
    settings: {
      revision: settings?.revision ?? null,
      value: settings
        ? JSON.parse(settings.value_json)
        : defaultScheduleSettings()
    },
    planning: rows.map((r) => ({
      ...JSON.parse(r.options_json),
      task_id: r.task_id,
      revision: r.revision,
      dependencies: deps
        .filter((d) => d.task_id === r.task_id)
        .map((d) => d.depends_on_id)
    })),
    blocks: listScheduleBlocks(),
    latest_run: latest ?? null
  }
  return {
    state,
    tasks,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          dbFilePath(),
          state.settings,
          state.planning,
          state.blocks,
          tasks
        ])
      )
      .digest('hex')
  }
}
export function getPlanningState(): PlanningState {
  return snapshot().state
}
function assertRevision(current: string | null, expected: string | null): void {
  if (current !== expected)
    throw Error('排程信息已变化，请刷新后重试；未保存的输入仍保留')
}
export function saveScheduleSettings(input: {
  expected_revision: string | null
  value: ScheduleSettings
}): PlanningState {
  assertRunning()
  validateScheduleSettings(input.value)
  return getDb().transaction(() => {
    assertRevision(snapshot().state.settings.revision, input.expected_revision)
    getDb()
      .prepare(
        'INSERT INTO schedule_settings(id,revision,value_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json'
      )
      .run(nanoid(), JSON.stringify(input.value))
    return getPlanningState()
  })()
}
export function saveTaskPlanning(input: TaskPlanningSave): PlanningState {
  assertRunning()
  validateTaskPlanning(input)
  return getDb().transaction(() => {
    const s = snapshot(),
      task = s.tasks.find((t) => t.id === input.task_id),
      current = s.state.planning.find((p) => p.task_id === input.task_id)
    if (!task) throw Error('任务不存在')
    assertRevision(current?.revision ?? null, input.expected_revision)
    if (input.enabled && task.planned_at !== null)
      throw Error(
        '此任务已有固定日程，请先清除固定开始和结束时间再启用自动安排'
      )
    if (input.dependencies.some((id) => !s.tasks.some((t) => t.id === id)))
      throw Error('前置任务不存在')
    const { expected_revision: _revision, dependencies, ...options } = input
    assertAcyclic([
      ...s.state.planning.filter((p) => p.task_id !== input.task_id),
      { task_id: input.task_id, dependencies }
    ])
    getDb()
      .prepare(
        'INSERT INTO task_planning(task_id,revision,options_json) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,options_json=excluded.options_json'
      )
      .run(input.task_id, nanoid(), JSON.stringify(options))
    getDb()
      .prepare('DELETE FROM task_dependencies WHERE task_id=?')
      .run(input.task_id)
    const insert = getDb().prepare(
      'INSERT INTO task_dependencies(task_id,depends_on_id) VALUES(?,?)'
    )
    for (const dep of dependencies) insert.run(input.task_id, dep)
    return getPlanningState()
  })()
}
export function changeScheduleBlock(input: {
  id: string
  expected_revision: string
  action: 'lock' | 'unlock' | 'remove'
}): PlanningState {
  assertRunning()
  return getDb().transaction(() => {
    const b = listScheduleBlocks().find((b) => b.id === input.id)
    if (!b) throw Error('时间块已不存在，请刷新')
    assertRevision(b.revision, input.expected_revision)
    if (input.action === 'remove')
      getDb().prepare('DELETE FROM schedule_blocks WHERE id=?').run(b.id)
    else
      getDb()
        .prepare('UPDATE schedule_blocks SET locked=?,revision=? WHERE id=?')
        .run(Number(input.action === 'lock'), nanoid(), b.id)
    return getPlanningState()
  })()
}
export async function previewSchedule(
  owner: number,
  range: { from: number; to: number }
): Promise<PlanningPreview> {
  assertRunning()
  discardSchedulePreview(owner)
  return withWork('自动排程', async () => {
    const s = snapshot(),
      token = nanoid(),
      input: PlannerInput = {
        ...range,
        now: Date.now(),
        settings: s.state.settings.value,
        tasks: s.tasks,
        planning: s.state.planning,
        blocks: s.state.blocks
      }
    const result = await new Promise<PlannerResult>((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'auto-schedule-worker.js'), {
          workerData: input
        }),
        timer = setTimeout(
          () => finish(new Error('排程计算超时，请缩小范围或减少任务')),
          20000
        )
      let settled = false
      function finish(error?: Error, data?: PlannerResult): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        workers.delete(owner)
        void worker.terminate()
        if (error) reject(error)
        else resolve(data!)
      }
      workers.set(owner, () => finish(new Error('排程计算已取消')))
      worker.once('message', (r) =>
        r.ok ? finish(undefined, r.data) : finish(new Error(r.error))
      )
      worker.once('error', (e) =>
        finish(e instanceof Error ? e : new Error(String(e)))
      )
      worker.once('exit', () => finish(new Error('排程工作线程意外退出')))
    })
    assertRunning()
    if (result.added.length > 10000)
      throw Error('拟生成的时间块过多，请缩小范围')
    const data: PlanningPreview = { ...result, ...range, token }
    previews.set(owner, {
      token,
      data,
      fingerprint: s.fingerprint,
      expires: Date.now() + 10 * 60000
    })
    return data
  })
}
function insertBlock(b: ScheduleBlock): void {
  getDb()
    .prepare(
      'INSERT INTO schedule_blocks(id,task_id,start_at,end_at,locked,revision,reason) VALUES(?,?,?,?,?,?,?)'
    )
    .run(
      b.id,
      b.task_id,
      b.start_at,
      b.end_at,
      Number(b.locked),
      b.revision,
      b.reason
    )
  // Tombstones also prevent our own exported/deleted block from becoming a new task on reimport.
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO calendar_import_receipts(import_key,task_id,created_at) VALUES(?,NULL,?)'
    )
    .run(`local:block:${b.id}`, Date.now())
}
export function applySchedule(owner: number, token: string, audit = {
  origin: 'manual', reason: '用户确认排程预览'
}): PlanningState {
  assertRunning()
  const preview = previews.get(owner)
  if (!preview || preview.token !== token || preview.expires < Date.now())
    throw Error('排程预览已过期，请重新生成')
  const state = getDb().transaction(() => {
    const s = snapshot()
    if (s.fingerprint !== preview.fingerprint)
      throw Error('任务、日程或设置已改变，请重新生成排程预览')
    const { added, removed } = preview.data
    if (added.some((b) => b.start_at < Date.now()))
      throw Error('预览中的开始时间已过去，请重新生成')
    // Keep identity/revision for an unchanged block so a no-op preview creates no history.
    const same = (
      a: { task_id: string; start_at: number; end_at: number },
      b: typeof a
    ): boolean =>
      a.task_id === b.task_id &&
      a.start_at === b.start_at &&
      a.end_at === b.end_at
    const deleted = removed.filter((b) => !added.some((a) => same(a, b))),
      created = added.filter((a) => !removed.some((b) => same(a, b)))
    if (!deleted.length && !created.length) return s.state
    for (const b of deleted)
      getDb().prepare('DELETE FROM schedule_blocks WHERE id=?').run(b.id)
    const inserted = created.map((a) => ({
      ...a,
      id: nanoid(),
      revision: nanoid(),
      locked: false
    }))
    for (const b of inserted) insertBlock(b)
    const after = snapshot()
    getDb()
      .prepare(
        'INSERT INTO schedule_runs(id,created_at,before_json,after_fingerprint,changed_json,origin,reason,outcome_json) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(
        nanoid(),
        Date.now(),
        JSON.stringify(s.state.blocks),
        after.fingerprint,
        JSON.stringify([...deleted, ...inserted]),
        audit.origin,
        audit.reason,
        JSON.stringify({ unplaced: preview.data.unplaced, warnings: preview.data.warnings })
      )
    getDb()
      .prepare(
        'DELETE FROM schedule_runs WHERE id NOT IN (SELECT id FROM schedule_runs ORDER BY rowid DESC LIMIT 20)'
      )
      .run()
    return getPlanningState()
  })()
  previews.delete(owner)
  return state
}
export function undoSchedule(id: string): PlanningState {
  assertRunning()
  return getDb().transaction(() => {
    const s = snapshot(),
      run = getDb()
        .prepare('SELECT * FROM schedule_runs WHERE id=?')
        .get(id) as
        | {
            before_json: string
            after_fingerprint: string
            changed_json: string
            undone_at: number | null
          }
        | undefined
    if (!run || run.undone_at !== null || s.state.latest_run?.id !== id)
      throw Error('只能撤销最近一次尚未撤销的排程')
    if (s.fingerprint !== run.after_fingerprint)
      throw Error('排程后已有任务、设置或时间块改动，为保护修改不能直接撤销')
    const changed = JSON.parse(run.changed_json) as ScheduleBlock[]
    if (changed.some((b) => b.start_at < Date.now()))
      throw Error('受影响的时间块已开始，不能直接撤销；请手动处理')
    getDb().prepare('DELETE FROM schedule_blocks').run()
    for (const b of JSON.parse(run.before_json) as ScheduleBlock[])
      insertBlock(b)
    getDb()
      .prepare('UPDATE schedule_runs SET undone_at=? WHERE id=?')
      .run(Date.now(), id)
    // Undo is a deliberate change of direction: do not immediately auto-apply it again.
    getDb().prepare("UPDATE schedule_automation SET enabled=0,revision=CASE WHEN enabled=1 THEN ? ELSE revision END,state='paused',last_stamp='',retry_at=0,error='',outcome_json='{}' WHERE id=1").run(nanoid())
    return getPlanningState()
  })()
}
