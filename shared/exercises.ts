import type { LearningAsset, LearningEntry, LearningSource, LearningState } from './types'
import { entryText, validateLearningState } from './learning-document'

export const exerciseFields = {
  statement: '题面',
  approach: '解题思路',
  standard_answer: '标准答案',
  user_answer: '用户答案',
  error_reason: '错误原因'
} as const
export type ExerciseField = keyof typeof exerciseFields
export type ExerciseStatus = 'unfinished' | 'correct' | 'wrong'
export const exerciseStatuses: Record<ExerciseStatus, string> = {
  unfinished: '未完成',
  correct: '对',
  wrong: '错'
}
export type ExerciseTexts = Record<ExerciseField, string>
export interface ExerciseSource {
  material_id: string
  version_id: string
  revision_id: string
  entry_id: string
}
export interface ExerciseOrigin {
  reference: ExerciseSource
  label: string
  raw_text: string
  entry: LearningEntry
  sources: LearningSource[]
  assets: LearningAsset[]
  solutions: LearningEntry[]
}
export interface ExerciseSnapshot {
  format_version: 1
  title: string
  subject_id: string | null
  status: ExerciseStatus
  question_type: string
  source_label: string
  no_idea: boolean
  review_concept_ids: string[]
  document: {
    sources: LearningSource[]
    state: LearningState
    fields: Record<ExerciseField, string>
  }
  origin?: ExerciseOrigin
  legacy?: Record<string, unknown>
}
export interface ExerciseInput
  extends Omit<ExerciseSnapshot, 'format_version' | 'document' | 'origin' | 'legacy'> {
  id?: string
  expected_revision_id?: string
  fields: ExerciseTexts
}
export interface ExerciseDetail {
  id: string
  revision_id: string
  current_revision_id: string
  deleted_at: number | null
  created_at: number
  updated_at: number
  snapshot: ExerciseSnapshot
  history: { id: string; created_at: number }[]
}
export interface ExerciseListInput {
  subject_id?: string | null
  status?: ExerciseStatus
  query?: string
  question_type?: string
  concept_id?: string
  trash?: boolean
  offset?: number
}
export interface ExerciseSummary {
  id: string
  revision_id: string
  title: string
  subject_id: string | null
  status: ExerciseStatus
  question_type: string
  source_label: string
  no_idea: boolean
  updated_at: number
}
export interface ExercisePage {
  items: ExerciseSummary[]
  total: number
  next_offset: number | null
}

export function exerciseTexts(snapshot: ExerciseSnapshot): ExerciseTexts {
  const sources = new Map(snapshot.document.sources.map((source) => [source.id, source]))
  return Object.fromEntries(
    Object.keys(exerciseFields).map((role) => {
      const entry = snapshot.document.state.entries.find(
        (item) => item.id === snapshot.document.fields[role as ExerciseField]
      )
      if (!entry) throw new Error('习题字段条目缺失')
      return [role, entryText(entry, sources)]
    })
  ) as ExerciseTexts
}

export function exerciseSnapshot(
  id: string,
  input: ExerciseInput,
  previous?: ExerciseSnapshot
): ExerciseSnapshot {
  const roles = Object.keys(exerciseFields) as ExerciseField[]
  const sources: LearningSource[] = roles.map((role, ordinal) => ({
    id: `${id}_${role}_source`,
    ordinal,
    raw_text: input.fields[role],
    heading: exerciseFields[role],
    extraction: 'manual',
    locator_json: JSON.stringify({ kind: 'exercise', exercise_id: id, field: role })
  }))
  const entries: LearningEntry[] = roles.map((role, index) => ({
    id: `${id}_${role}`,
    type: role === 'statement' ? 'exercise' : role === 'error_reason' ? 'note' : 'solution',
    title: exerciseFields[role],
    sources: [{ source_id: sources[index].id }],
    ...(role === 'statement' && previous?.origin?.entry.figures
      ? { figures: previous.origin.entry.figures }
      : {}),
    ...(role === 'standard_answer' && previous?.origin
      ? {
          figures: [
            ...new Map(
              previous.origin.solutions
                .flatMap((entry) => entry.figures ?? [])
                .map((figure) => [figure.asset_id, figure])
            ).values()
          ]
        }
      : {}),
    analysis: { method: 'manual', review_status: 'confirmed' }
  }))
  const state: LearningState = {
    entries,
    relations: entries
      .filter((e) => e.type === 'solution')
      .map((e) => ({
        from: e.id,
        to: entries[0].id,
        type: 'solves',
        review_status: 'confirmed'
      }))
  }
  validateLearningState(state, sources)
  return {
    format_version: 1,
    title: input.title.trim(),
    subject_id: input.subject_id,
    status: input.status,
    question_type: input.question_type.trim(),
    source_label: input.source_label,
    no_idea: input.no_idea,
    review_concept_ids: [...input.review_concept_ids],
    document: {
      sources,
      state,
      fields: Object.fromEntries(roles.map((role, i) => [role, entries[i].id])) as Record<
        ExerciseField,
        string
      >
    },
    ...(previous?.origin ? { origin: previous.origin } : {}),
    ...(previous?.legacy ? { legacy: previous.legacy } : {})
  }
}
