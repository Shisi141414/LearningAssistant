import { open, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { calendarConflicts, occupiedEnd } from './calendar-conflicts'
import { nanoid } from 'nanoid'
import type {
  CalendarRange,
  CalendarPreview,
  CalendarImportEntry,
  CalendarImportResult,
  CalendarExportResult,
  CalendarImportOptions,
  CalendarConflicts,
  CalendarConflictItem,
  CalendarTaskSaveInput,
  CalendarTaskSaveResult
} from '@shared/calendar'
import { MAX_CALENDAR_BYTES, serializeCalendarIcs, validateCalendarRange } from './calendar-ics'
import { createTask, updateTask, listAllTasks } from './projects'
import { dbFilePath, getDb } from './db'
import { withWork } from './work'
import { externalExportTarget } from './export-target'

const previews = new Map<
  number,
  { token: string; entries: CalendarImportEntry[]; database: string; expires: number }
>()
const previewing = new Set<number>()
const cancelled = new Set<number>()
const parsers = new Map<number, () => void>()
let stopping = false
const checkRunning = (owner?: number): void => {
  if (stopping || (owner !== undefined && cancelled.has(owner))) throw new Error('课表操作已取消')
}
function duplicate(entry: CalendarImportEntry): boolean {
  const db = getDb()
  return (
    !!db
      .prepare('SELECT import_key FROM calendar_import_receipts WHERE import_key = ?')
      .get(entry.key) ||
    !!(entry.local_id && (db.prepare('SELECT id FROM tasks WHERE id = ?').get(entry.local_id) || db.prepare('SELECT import_key FROM calendar_import_receipts WHERE import_key=?').get(`local:${entry.local_id}`)))
  )
}
function conflictsFor(entries: CalendarImportEntry[]): CalendarConflicts {
  const fresh = entries
    .filter((entry) => !duplicate(entry) && !entry.done)
    .map((entry) => ({
      key: entry.key,
      title: entry.title,
      start: entry.start,
      end: occupiedEnd(entry.start, entry.end, entry.all_day)
    }))
  return conflictsWithTasks(fresh)
}
function conflictsWithTasks(fresh: CalendarConflictItem[], excludedId = ''): CalendarConflicts {
  if (!fresh.length) return calendarConflicts([], [])
  const from = Math.min(...fresh.map((item) => item.start)),
    to = Math.max(...fresh.map((item) => item.end))
  const rows = getDb()
    .prepare(
      "SELECT id, title, planned_at, planned_end_at, all_day FROM tasks WHERE id != ? AND status != 'done' AND planned_at < ? AND COALESCE(planned_end_at, planned_at + 172800000) > ? LIMIT 10001"
    )
    .all(excludedId, to, from) as Array<{
    id: string
    title: string
    planned_at: number
    planned_end_at: number | null
    all_day: number
  }>
  if (rows.length > 10000) throw new Error('该日期范围日程过多，请缩小课表导入日期范围')
  const blocks = getDb().prepare("SELECT b.id,b.start_at,b.end_at,t.title FROM schedule_blocks b JOIN tasks t ON b.task_id=t.id WHERE t.id!=? AND t.status!='done' AND b.start_at<? AND b.end_at>? LIMIT 10001").all(excludedId,to,from) as {id:string;start_at:number;end_at:number;title:string}[]
  if (blocks.length+rows.length>10000) throw new Error('该日期范围日程过多，请缩小范围')
  return calendarConflicts(
    fresh,
    [...blocks.map(b=>({key:`block:${b.id}`,title:b.title,start:b.start_at,end:b.end_at})),...rows.map((row) => ({
      key: row.id,
      title: row.title,
      start: row.planned_at,
      end: occupiedEnd(row.planned_at, row.planned_end_at, !!row.all_day)
    }))]
  )
}
class TaskTimeConflict extends Error {
  readonly conflicts: CalendarConflicts
  constructor(conflicts: CalendarConflicts) {
    super('日程存在时间冲突')
    this.conflicts = conflicts
  }
}

/** Validate, check and save in one transaction; a declined conflict leaves no task or project timestamp change. */
export function saveCalendarTask(input: CalendarTaskSaveInput): CalendarTaskSaveResult {
  checkRunning()
  try {
    return getDb().transaction(() => {
      if (input.id) {
        const assignment = getDb().prepare('SELECT revision FROM assignment_links WHERE task_id=?').get(input.id) as {revision:string}|undefined
        if (assignment && assignment.revision !== input.expected_assignment_revision) throw Error('对应作业已变化，请刷新日程后重试；当前输入仍保留')
      }
      let task = input.id ? updateTask(input.id, input.task) : createTask(input.task)
      if (!input.id && input.task.status)
        task = updateTask(task.id, {
          status: input.task.status,
          blocked_reason: input.task.blocked_reason ?? ''
        })
      const conflicts = conflictsWithTasks(
        task.planned_at === null || task.status === 'done'
          ? []
          : [
              {
                key: 'draft',
                title: task.title,
                start: task.planned_at,
                end: occupiedEnd(task.planned_at, task.planned_end_at, task.all_day)
              }
            ],
        task.id
      )
      if (
        conflicts.items.length &&
        (!input.confirmation?.ignore_conflicts ||
          input.confirmation.conflict_fingerprint !== conflicts.fingerprint)
      )
        throw new TaskTimeConflict(conflicts)
      return { task }
    })()
  } catch (error) {
    if (error instanceof TaskTimeConflict) return { task: null, conflicts: error.conflicts }
    throw error
  }
}
export async function previewCalendar(
  file: string,
  range: CalendarRange,
  owner: number
): Promise<CalendarPreview> {
  validateCalendarRange(range)
  checkRunning()
  if (previewing.has(owner)) throw new Error('正在读取课表，请稍候')
  previewing.add(owner)
  previews.delete(owner)
  cancelled.delete(owner)
  try {
    return await withWork('课表预览', async () => {
      const handle = await open(file, 'r')
      let text: string
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > MAX_CALENDAR_BYTES)
          throw new Error('请选择不超过 5 MiB 的 ICS 文件')
        const bytes = Buffer.alloc(MAX_CALENDAR_BYTES + 1)
        let size = 0
        while (size < bytes.length) {
          const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > MAX_CALENDAR_BYTES) throw new Error('课表文件超过 5 MiB')
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
      } finally {
        await handle.close()
      }
      checkRunning(owner)
      const data = await new Promise<{ entries: CalendarImportEntry[]; warnings: string[] }>(
        (resolve, reject) => {
          const worker = new Worker(join(__dirname, 'calendar-worker.js'), {
            workerData: { text, range },
            resourceLimits: { maxOldGenerationSizeMb: 128 }
          })
          let settled = false
          const finish = (
            error?: Error,
            data?: { entries: CalendarImportEntry[]; warnings: string[] }
          ): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            parsers.delete(owner)
            void worker.terminate()
            if (error) reject(error)
            else resolve(data!)
          }
          const timer = setTimeout(
            () => finish(new Error('课表解析超时，请缩小文件或导入日期范围')),
            15_000
          )
          parsers.set(owner, () => finish(new Error('课表操作已取消')))
          worker.once('message', (result) =>
            finish(result.ok ? undefined : new Error(result.error), result.data)
          )
          worker.once('error', (error) =>
            finish(error instanceof Error ? error : new Error(String(error)))
          )
          worker.once('exit', (code) => {
            if (!settled) finish(new Error(`课表解析进程退出（${code}）`))
          })
        }
      )
      checkRunning(owner)
      const conflicts = conflictsFor(data.entries)
      const token = nanoid()
      previews.set(owner, {
        token,
        entries: data.entries,
        database: dbFilePath(),
        expires: Date.now() + 15 * 60_000
      })
      return {
        token,
        file_name: basename(file),
        ...data,
        duplicates: data.entries.filter(duplicate).length,
        conflicts
      }
    })
  } finally {
    previewing.delete(owner)
    cancelled.delete(owner)
  }
}
export function discardCalendarPreview(owner: number): void {
  previews.delete(owner)
  if (previewing.has(owner)) cancelled.add(owner)
  parsers.get(owner)?.()
}
export function stopCalendarJobs(): void {
  stopping = true
  previews.clear()
  for (const cancel of parsers.values()) cancel()
}
export function importCalendar(
  token: string,
  owner: number,
  options?: CalendarImportOptions
): CalendarImportResult {
  checkRunning()
  const preview = previews.get(owner)
  if (
    !preview ||
    preview.token !== token ||
    preview.expires < Date.now() ||
    preview.database !== dbFilePath()
  ) {
    previews.delete(owner)
    throw new Error('课表预览已失效，请重新选择文件')
  }
  const result = getDb().transaction(() => {
    const conflicts = conflictsFor(preview.entries)
    if (
      conflicts.items.length &&
      (!options?.ignore_conflicts || options.conflict_fingerprint !== conflicts.fingerprint)
    )
      return { added: 0, skipped: 0, conflicts }
    let added = 0,
      skipped = 0
    for (const entry of preview.entries) {
      if (duplicate(entry)) {
        skipped++
        continue
      }
      const task = createTask({
        title: entry.title,
        detail: entry.detail,
        location: entry.location,
        planned_at: entry.start,
        planned_end_at: entry.end > entry.start ? entry.end : null,
        all_day: entry.all_day,
        due_at: entry.due_at
      })
      if (entry.done) updateTask(task.id, { status: 'done' })
      getDb()
        .prepare(
          'INSERT INTO calendar_import_receipts(import_key, task_id, created_at) VALUES (?,?,?)'
        )
        .run(entry.key, task.id, Date.now())
      added++
    }
    return { added, skipped }
  })()
  if (!result.conflicts) previews.delete(owner)
  return result
}
export async function exportCalendar(file: string): Promise<CalendarExportResult> {
  return withWork('日程导出', async () => {
    checkRunning()
    const destination = await externalExportTarget(file, '.ics')
    checkRunning()
    const keys = getDb()
      .prepare('SELECT task_id, import_key FROM calendar_import_receipts WHERE task_id IS NOT NULL')
      .all() as Array<{ task_id: string; import_key: string }>
    const tasks = listAllTasks(), blocks = getDb().prepare('SELECT id,task_id,start_at,end_at FROM schedule_blocks ORDER BY start_at').all() as {id:string;task_id:string;start_at:number;end_at:number}[],
      taskMap = new Map(tasks.map(t=>[t.id,t])), blockedIds = new Set(blocks.map(b=>b.task_id))
    const result = serializeCalendarIcs(
      [...tasks.filter(t=>!blockedIds.has(t.id)||t.due_at!==null||t.planned_at!==null), ...blocks.map(b=>({...taskMap.get(b.task_id)!,id:`block:${b.id}`,planned_at:b.start_at,planned_end_at:b.end_at,all_day:false,due_at:null}))],
      new Map(keys.map((row) => [row.task_id, row.import_key]))
    )
    const temporary = join(destination.directory, `.calendar-${nanoid()}.tmp`)
    try {
      await writeFile(temporary, result.text, { encoding: 'utf8', flag: 'wx' })
      checkRunning()
      await rename(temporary, destination.target)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return {
      file_name: basename(destination.target),
      exported: result.exported,
      unscheduled: result.unscheduled
    }
  })
}
