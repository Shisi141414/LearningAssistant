import type { CalendarConflicts } from './calendar'

export interface MemoInput {
  content: string
  subject_id: string | null
  id?: string
  expected_revision?: string
}
export interface MemoVersion {
  id: string
  content: string
  subject_id: string | null
  created_at: number
  timezone: string
}
export interface MemoSummary {
  id: string
  revision: string
  content: string
  subject_id: string | null
  created_at: number
  updated_at: number
  archived: boolean
  routed: boolean
  inspiration_id: string | null
}
export interface MemoPage {
  items: MemoSummary[]
  next_offset: number | null
}
export interface MemoRoutePlan {
  id: string
  expected_revision: string
  knowledge:
    | null
    | { kind: 'existing'; id: string; revision: number }
    | { kind: 'new'; name: string; summary: string; subject_id: string }
  task: null | {
    title: string
    detail: string
    due_at: number | null
    planned_at: number | null
    planned_end_at: number | null
    location: string
  }
}
export interface MemoRoutePreview {
  fingerprint: string
  conflicts: CalendarConflicts
  existing_concept_id: string | null
  duplicate_route_id: string | null
}
export interface MemoTarget {
  id: string
  kind: 'concept' | 'task'
  target_id: string | null
  title: string
  created: boolean
}
export interface MemoRoute {
  id: string
  revision: string
  created_at: number
  undone_at: number | null
  targets: MemoTarget[]
}
export interface MemoProposal {
  kind: 'knowledge' | 'task' | 'mixed' | 'idea' | 'other'
  knowledge: null | { name: string; summary: string; excerpt: string }
  task: null | {
    title: string
    detail: string
    time_text: string
    start: string | null
    end: string | null
    due: string | null
    location: string
    excerpt: string
  }
  uncertainties: string[]
}
export interface MemoRecognition {
  id: string
  revision: string
  status: 'running' | 'ready' | 'failed' | 'cancelled'
  provider_name: string
  model_id: string
  error: string
  proposal: MemoProposal | null
  created_at: number
}
export interface MemoDetail {
  memo: MemoSummary
  versions: MemoVersion[]
  routes: MemoRoute[]
  recognitions: MemoRecognition[]
  automation: MemoAutoJob[]
}
export interface MemoReference {
  memo_id: string
  revision: string
  content: string
  archived: boolean
  created_at: number
}

export interface MemoAutoSettings {
  revision: string
  enabled: boolean
  model_db_id: string | null
  subject_ids: string[]
  include_unassigned: boolean
  knowledge: boolean
  tasks: boolean
  /** SQLite version row watermark at opt-in, not a wall-clock timestamp. */
  since: number
}
export interface MemoAutoJob {
  id: string
  excerpt: string
  memo_id: string
  revision: string
  policy_revision: string
  policy_json: string
  status: 'pending' | 'running' | 'review' | 'routed' | 'cancelled'
  attempts: number
  next_at: number
  recognition_id: string | null
  reason: string
  created_at: number
  updated_at: number
}
export interface MemoAutoState {
  settings: MemoAutoSettings
  jobs: MemoAutoJob[]
}
