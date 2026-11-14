import type { ExerciseSnapshot } from './exercises'

export type ReviewKind = 'concept' | 'exercise'
export type ReviewGrade = 1 | 2 | 3 | 4
export const reviewGrades: Record<ReviewGrade, string> = {
  1: '忘记',
  2: '困难',
  3: '记得',
  4: '轻松'
}
export interface ReviewSource {
  kind: ReviewKind
  source_id: string
  expected_source_revision: string
}
export interface ReviewSnapshot {
  title: string
  subject_id: string | null
  prompt: string
  answer: string
  aliases: string[]
  exercise?: ExerciseSnapshot
}
export interface ReviewSummary {
  id: string
  kind: ReviewKind
  source_id: string
  source_revision: string
  revision: string
  task_id: string
  title: string
  subject_id: string | null
  active: boolean
  available: boolean
  source_changed: boolean
  due_at: number
  reps: number
  lapses: number
  state: number
}
export interface ReviewListInput {
  scope: 'today' | 'all' | 'paused'
  subject_id?: string | null
  offset: number
}
export interface ReviewPage {
  items: ReviewSummary[]
  total: number
  due_now: number
  next_offset: number | null
  legacy_count: number
  now: number
}
export interface ReviewLog {
  id: string
  action: 'grade' | 'undo' | 'pause' | 'resume' | 'refresh'
  grade: ReviewGrade | null
  created_at: number
  due_at: number
  source_revision: string
  undone: boolean
}
export interface ReviewDetail extends ReviewSummary {
  snapshot: ReviewSnapshot
  history: ReviewLog[]
  can_undo: boolean
}
export interface ReviewReveal {
  token: string
  expires_at: number
  detail: ReviewDetail
  choices: { grade: ReviewGrade; due_at: number }[]
}
export interface ReviewAction {
  id: string
  expected_revision: string
  action: 'pause' | 'resume' | 'refresh' | 'undo'
}
