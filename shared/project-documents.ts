import type { LearningAsset, LearningOperation, LearningSource, LearningState } from './types'

export const projectDocumentKinds = {
  requirements: '项目要求',
  plan: '计划书',
  report: '成果与报告',
  other: '项目文档'
} as const
export type ProjectDocumentKind = keyof typeof projectDocumentKinds
export interface ProjectDocumentSnapshot {
  format_version: 1
  title: string
  kind: ProjectDocumentKind
  concept_ids: string[]
  sources: LearningSource[]
  state: LearningState
  assets: LearningAsset[]
  origin?: { material_id: string; version_id: string; revision_id: string; title: string }
}
export interface ProjectDocumentSummary {
  id: string
  project_id: string
  title: string
  kind: ProjectDocumentKind
  head_revision_id: string
  deleted_at: number | null
  updated_at: number
}
export interface ProjectDocumentDetail extends ProjectDocumentSummary {
  revision_id: string
  snapshot: ProjectDocumentSnapshot
  history: { id: string; created_at: number }[]
}
export interface ProjectDocumentSave {
  project_id: string
  id?: string
  expected_revision_id?: string
  title: string
  kind: ProjectDocumentKind
  concept_ids: string[]
  /** Omit to preserve structured content. Replacing body resets its local structure explicitly. */
  body?: string
}
export interface ProjectDocumentAction {
  id: string
  expected_revision_id: string
}
export type ProjectDocumentChange = ProjectDocumentAction & { entry_id: string } & Exclude<
    LearningOperation,
    { action: 'figure' | 'figure-remove' }
  >
