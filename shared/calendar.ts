import type { Task, TaskInput } from './types'

export interface CalendarRange {
  from: number
  to: number
}
export interface CalendarImportEntry {
  key: string
  title: string
  detail: string
  location: string
  start: number
  end: number
  all_day: boolean
  due_at: number | null
  done: boolean
  local_id: string | null
}
export interface CalendarConflictItem {
  key: string
  title: string
  start: number
  end: number
}
export interface CalendarConflict {
  incoming: CalendarConflictItem
  other: CalendarConflictItem
  kind: 'existing' | 'import'
}
export interface CalendarConflicts {
  items: CalendarConflict[]
  truncated: boolean
  fingerprint: string
}
export interface CalendarImportOptions {
  ignore_conflicts: boolean
  conflict_fingerprint: string
}
export interface CalendarPreview {
  token: string
  file_name: string
  entries: CalendarImportEntry[]
  duplicates: number
  warnings: string[]
  conflicts: CalendarConflicts
}
export interface CalendarImportResult {
  added: number
  skipped: number
  conflicts?: CalendarConflicts
}
export interface CalendarExportResult {
  file_name: string
  exported: number
  unscheduled: number
}

export interface CalendarTaskSaveInput {
  id?: string
  task: Pick<
    TaskInput,
    'title' | 'detail' | 'planned_at' | 'planned_end_at' | 'all_day' | 'location' | 'due_at'
  > & { status?: Task['status']; blocked_reason?: string }
  confirmation?: CalendarImportOptions
}
export type CalendarTaskSaveResult =
  | { task: Task; conflicts?: never }
  | { task: null; conflicts: CalendarConflicts }
