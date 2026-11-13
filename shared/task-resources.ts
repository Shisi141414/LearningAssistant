import type {
  LearningAsset,
  LearningEntryType,
  LearningFigure,
  LearningFormula
} from './types'

export type TaskResourceSource =
  | {
      kind: 'material'
      material_id: string
      version_id: string
      revision_id: string
      entry_id: string
    }
  | { kind: 'note'; note_id: string; revision_id: string; entry_id: string }
  | {
      kind: 'exercise'
      exercise_id: string
      revision_id: string
      entry_id: string
    }
  | {
      kind: 'project_document'
      document_id: string
      revision_id: string
      entry_id: string
    }
export const taskResourceRoles = {
  learn: '需要掌握',
  apply: '在此应用',
  output: '产出证据',
  question: '待解决问题',
  verify: '验证理解'
} as const
export type TaskResourceRole = keyof typeof taskResourceRoles
export interface TaskResourceFields {
  role: TaskResourceRole
  concept_id: string | null
  why: string
  verification: string
}
export interface TaskResourceSnapshot {
  source: TaskResourceSource
  title: string
  entry_title: string
  entry_type: LearningEntryType
  quote: string
  location: string
  formulas: LearningFormula[]
  figures: LearningFigure[]
  assets: LearningAsset[]
  original_text?: string
  source_project_id?: string
}
export interface TaskResource extends TaskResourceFields {
  id: string
  task_id: string
  revision: string
  created_at: number
  updated_at: number
  snapshot: TaskResourceSnapshot
  available: boolean
  task_title: string
  project_id: string | null
  project_title: string | null
}
export interface TaskResourcePage {
  items: TaskResource[]
  total: number
  next_offset: number | null
}
export interface TaskResourceAdd extends TaskResourceFields {
  task_id: string
  source: TaskResourceSource
}
export interface TaskResourceEdit extends TaskResourceFields {
  id: string
  expected_revision: string
}
export function taskResourceKey(source: TaskResourceSource): string {
  return JSON.stringify(
    source.kind === 'material'
      ? [
          'material',
          source.material_id,
          source.version_id,
          source.revision_id,
          source.entry_id
        ]
      : source.kind === 'note'
        ? ['note', source.note_id, source.revision_id, source.entry_id]
        : source.kind === 'exercise'
          ? [
              'exercise',
              source.exercise_id,
              source.revision_id,
              source.entry_id
            ]
          : [
              'project_document',
              source.document_id,
              source.revision_id,
              source.entry_id
            ]
  )
}
export function taskResourceHref(resource: TaskResource): string | null {
  if (!resource.available) return null
  const s = resource.snapshot.source,
    query = new URLSearchParams({ revision: s.revision_id, entry: s.entry_id })
  if (s.kind === 'material') {
    query.set('material', s.material_id)
    query.set('version', s.version_id)
    return `/library?${query}`
  }
  if (s.kind === 'note') {
    query.set('view', 'uniform')
    return `/notes/${encodeURIComponent(s.note_id)}?${query}`
  }
  if (s.kind === 'exercise')
    return `/exercises/${encodeURIComponent(s.exercise_id)}?${query}`
  return resource.snapshot.source_project_id
    ? `/projects/${encodeURIComponent(resource.snapshot.source_project_id)}/documents/${encodeURIComponent(s.document_id)}?${query}`
    : null
}
