import type { Task, TaskStatus } from './types'

export interface Assignment {
  id: string
  revision: string
  subject_id: string | null
  source: string
  deleted_at: number | null
  restore_status: TaskStatus | null
  task: Task
}
export interface AssignmentHistory {
  id: string
  action: string
  before_json: string | null
  after_json: string
  created_at: number
}
export interface AssignmentDetail extends Assignment {
  history: AssignmentHistory[]
  history_total: number
  legacy_snapshot_json: string | null
}
export interface AssignmentSave {
  id?: string
  expected_revision?: string
  subject_id: string | null
  title: string
  detail: string
  status: TaskStatus
  blocked_reason: string
  due_at: number | null
}
export interface AssignmentList {
  query: string
  scope: 'open' | 'all' | 'overdue' | 'trash'
  subject_id?: string | null
  offset: number
}
export interface AssignmentPage {
  items: Assignment[]
  total: number
}
export interface AssignmentArchive {
  id: string
  expected_revision: string
  archived: boolean
}

export const assignmentStatuses: Record<TaskStatus, string> = {
  open: '未开始',
  doing: '进行中',
  blocked: '有困难',
  done: '已完成'
}
