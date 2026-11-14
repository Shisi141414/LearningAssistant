export interface CampusCourse {
  id: string
  title: string
  subject_id: string | null
  revision: string
}
export interface CampusState {
  phase: 'disconnected' | 'login' | 'connected' | 'error'
  label: string
  semester: string
  courses: CampusCourse[]
  busy: boolean
  error: string
}
export interface CampusSource {
  account_id: string
  semester: string
  course_id: string
  course_title: string
  id: string
  base_id: string
  title: string
  deadline: string
  due_at: number
  submitted: boolean
  url: string
}
export type CampusField = 'title' | 'due_at' | 'subject_id'
export interface CampusChange {
  field: CampusField
  local: string | number | null
  remote: string | number | null
  protected: boolean
}
export interface CampusPreviewItem {
  key: string
  course_title: string
  title: string
  due_at: number
  submitted: boolean
  kind: 'new' | 'update' | 'unchanged' | 'trash'
  changes: CampusChange[]
}
export interface CampusPreview {
  token: string
  items: CampusPreviewItem[]
  failures: string[]
}
export interface CampusApply {
  token: string
  keys: string[]
  adopt: Array<{ key: string; fields: CampusField[] }>
}
export interface CampusProvenance {
  current: CampusSource
  versions: number
  overrides: CampusField[]
}
