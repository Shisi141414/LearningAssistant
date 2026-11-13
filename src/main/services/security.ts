import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc-channels'
import { learningTypes } from '@shared/learning-document'
import { evidenceRoles } from '@shared/evidence'
import { validLearningCropRect } from '@shared/learning-crops'

export function trustedRenderer(url: string): boolean {
  try {
    const candidate = new URL(url)
    if (process.env.ELECTRON_RENDERER_URL) {
      const expected = new URL(process.env.ELECTRON_RENDERER_URL)
      return candidate.origin === expected.origin && candidate.pathname === expected.pathname && !candidate.search
    }
    return candidate.protocol === 'file:' && resolve(fileURLToPath(candidate)) === resolve(join(__dirname, '../renderer/index.html')) && !candidate.search
  } catch { return false }
}
export function safeExternal(url: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol) } catch { return false }
}

type Check = (value: unknown) => boolean
const text = (max = 200_000, nonempty = false): Check => (v) => typeof v === 'string' && v.length <= max && (!nonempty || !!v.trim()) && !v.includes('\0')
const id = text(128, true), title = text(500, true), content = text()
const optional = (check: Check): Check => (v) => v === undefined || check(v)
const nullable = (check: Check): Check => (v) => v === null || check(v)
const opt = (check: Check): Check => optional(nullable(check))
const choice = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v)
const number: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const bool: Check = (v) => typeof v === 'boolean'
const learningRange: Check = v => Array.isArray(v) && v.length === 2 && v.every(item => number(item) && item <= 2_000_000)
const record = (fields: Record<string, Check>): Check => (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  return Object.keys(object).every(key => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check(object[key]))
}
const kind = choice('lecture', 'seminar', 'meeting', 'other')
const segmentType = choice('definition', 'proposition', 'example', 'proof', 'solution', 'note', 'other')
const attachment = { subject_id: opt(id), activity_id: opt(id) }
const subject = { name: title, color: optional(text(64)), description: optional(content) }
const activity = { title, kind: optional(kind), happened_at: opt(number), subject_id: opt(id), description: optional(content) }
const patch = (fields: Record<string, Check>): Record<string, Check> => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, optional(v)]))
const configKey = choice('asr.model_dir', 'asr.hotwords', 'classroom.autoRecord', 'classroom.autoOrganize')
const evidenceSource: Check = value => [
  record({ kind: choice('learning'), material_id: id, version_id: id, revision_id: id, entry_id: id }),
  record({ kind: choice('note'), note_id: id, segment_id: id, field: choice('raw_text', 'organized_text') })
].some(check => check(value))
const conceptInput = { subject_id: nullable(id), name: text(120, true), summary: text(4000), aliases: (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every(text(120, true)) }
const evidenceInput = { source: evidenceSource, expected_note_text: optional(text(40_000)), role: choice(...Object.keys(evidenceRoles)), memo: text(2000) }
const learningChange = (owner: 'note_id' | 'version_id' | 'id', figures: boolean): Check => value => {
  const base = { [owner]: id, expected_revision_id: id, entry_id: id }
  return [
    record({ ...base, action: choice('edit'), type: choice(...Object.keys(learningTypes)), title: text(500) }),
    record({ ...base, action: choice('split'), position: v => number(v) && (v as number) <= 2_000_000 }),
    record({ ...base, action: choice('merge') }),
    record({ ...base, action: choice('outline'), end_entry_id: id, parent_id: nullable(id) }),
    record({ ...base, action: choice('formula'), formula: record({ range: learningRange, latex: text(2000, true), display: bool }) }),
    record({ ...base, action: choice('formula-remove'), range: learningRange }),
    ...(figures ? [record({ ...base, action: choice('figure'), figure: record({ asset_id: id, caption: text(1000) }) }), record({ ...base, action: choice('figure-remove'), asset_id: id })] : []),
    record({ ...base, action: choice('relate'), target_id: nullable(id) })
  ].some(check => check(value))
}

const taskResourceSource: Check = value => [
  record({kind:choice('material'),material_id:id,version_id:id,revision_id:id,entry_id:id}),
  record({kind:choice('note'),note_id:id,revision_id:id,entry_id:id}),
  record({kind:choice('exercise'),exercise_id:id,revision_id:id,entry_id:id}),
  record({kind:choice('project_document'),document_id:id,revision_id:id,entry_id:id})
].some(check=>check(value))
const taskResourceFields = { role:choice('learn','apply','output','question','verify'),concept_id:nullable(id),why:text(4000),verification:text(4000) }
const taskResourceOffset=optional((value:unknown)=>number(value)&&(value as number)<=10_000_000)
const rules: Partial<Record<string, Check[]>> = {
  [IPC.TaskResourcesList]: [record({task_id:id,offset:taskResourceOffset})],
  [IPC.TaskResourcesBacklinks]: [record({source:taskResourceSource,offset:taskResourceOffset})],
  [IPC.TaskResourcesAdd]: [record({task_id:id,source:taskResourceSource,...taskResourceFields})],
  [IPC.TaskResourcesEdit]: [record({id,expected_revision:id,...taskResourceFields})],
  [IPC.TaskResourcesRemove]: [record({id,expected_revision:id})],
  [IPC.ProjectDocumentsList]: [record({ project_id: id, trash: optional(bool) })],
  [IPC.ProjectDocumentsGet]: [record({ id, revision_id: optional(id) })],
  [IPC.ProjectDocumentsSave]: [record({ project_id: id, id: optional(id), expected_revision_id: optional(id), title, kind: choice('requirements','plan','report','other'), body: optional(text(200_000,true)), concept_ids: v => Array.isArray(v) && v.length <= 32 && v.every(id) })],
  [IPC.ProjectDocumentsChange]: [learningChange('id',false)],
  [IPC.ProjectDocumentsRevisionRestore]: [record({ id, expected_revision_id: id, revision_id: id })],
  [IPC.ProjectDocumentsTrash]: [record({ id, expected_revision_id: id })],
  [IPC.ProjectDocumentsRestore]: [record({ id, expected_revision_id: id })],
  [IPC.ProjectDocumentsImport]: [record({ project_id: id, material_id: id, version_id: id, revision_id: id, kind: choice('requirements','plan','report','other') })],
  [IPC.ConceptsGraph]: [],
  [IPC.ConceptsRelationSave]: [record({ from_id: id, to_id: id, relation: choice('prerequisite','extends','related'), memo: text(2000), expected_revision: optional(id) })],
  [IPC.ConceptsRelationRemove]: [record({ from_id: id, to_id: id, expected_revision: id })],
  [IPC.ConceptsPositions]: [v => Array.isArray(v) && v.length > 0 && v.length <= 2000 && v.every(record({ concept_id: id, x: n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000, y: n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000 }))],
  [IPC.ConceptsUsage]: [record({ concept_id: id, offset: optional(v => number(v) && (v as number) <= 10_000_000) })],
  [IPC.ExercisesList]: [record({ subject_id: opt(id), status: optional(choice('unfinished','correct','wrong')), query: optional(text(500)), question_type: optional(text(120)), concept_id: optional(id), trash: optional(bool), offset: optional(v => number(v) && (v as number) <= 10_000_000) })],
  [IPC.ExercisesGet]: [record({ id, revision_id: optional(id) })],
  [IPC.ExercisesSave]: [record({ id: optional(id), expected_revision_id: optional(id), title, subject_id: nullable(id), status: choice('unfinished','correct','wrong'), question_type: text(120), source_label: text(2000), no_idea: bool, review_concept_ids: v => Array.isArray(v) && v.length <= 32 && v.every(id), fields: record({ statement: text(200_000,true), approach: content, standard_answer: content, user_answer: content, error_reason: content }) })],
  [IPC.ExercisesImport]: [record({ material_id: id, version_id: id, revision_id: id, entry_id: id })],
  [IPC.ExerciseSetsPreview]: [id],
  [IPC.ExerciseSetsImport]: [record({ token: id, entry_ids: value => Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(id) })],
  [IPC.ExerciseSetsDiscard]: [],
  [IPC.ExercisesTrash]: [record({ id, expected_revision_id: id })],
  [IPC.ExercisesRestore]: [record({ id, expected_revision_id: id })],
  [IPC.CalendarSave]: [record({ id: optional(id), task: record({ title, detail: optional(content), planned_at: opt(number), planned_end_at: opt(number), all_day: optional(bool), location: optional(text(1000)), due_at: opt(number), status: optional(choice('open','doing','blocked','done')), blocked_reason: optional(text(2000)) }), confirmation: optional(record({ ignore_conflicts: bool, conflict_fingerprint: text(64) })) })],
  [IPC.CalendarPreview]: [record({ from: number, to: number })],
  [IPC.CalendarImport]: [id, optional(record({ ignore_conflicts: bool, conflict_fingerprint: text(64) }))],
  [IPC.CalendarDiscard]: [],
  [IPC.CalendarExport]: [],
  [IPC.LearningPdfExport]: [record({ source: value => [record({ kind: choice('material'), version_id: id, revision_id: id }), record({ kind: choice('note'), note_id: id, revision_id: id }), record({ kind: choice('exercise'), exercise_id: id, revision_id: id }), record({ kind: choice('project_document'), document_id: id, revision_id: id })].some(check => check(value)), landscape: bool, include_original_text: bool })],
  [IPC.LearningPdfCancel]: [],
  [IPC.NotesLearningGet]: [record({ note_id: id, revision_id: optional(id) })],
  [IPC.NotesLearningChange]: [learningChange('note_id', false)],
  [IPC.NotesLearningPreview]: [id],
  [IPC.NotesPackageExport]: [record({ note_id: id, revision_id: id })],
  [IPC.NotesPackageExportCancel]: [id],
  [IPC.NotesPackagePreview]: [],
  [IPC.NotesPackageImport]: [record({ ticket: id, subject_id: id, include_concepts: bool })],
  [IPC.NotesPackageImportCancel]: [],
  [IPC.NotesPackageReceipt]: [id],
  [IPC.NotesLearningSync]: [record({ note_id: id, expected_revision_id: id, fingerprint: v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) })],
  [IPC.KnowledgeSuggestStart]: [record({ source: evidenceSource, expected_note_text: optional(text(12_000)), model_db_id: id })],
  [IPC.KnowledgeSuggestList]: [evidenceSource],
  [IPC.KnowledgeSuggestGet]: [id],
  [IPC.KnowledgeSuggestCancel]: [id],
  [IPC.KnowledgeSuggestDismiss]: [id],
  [IPC.KnowledgeSuggestAdopt]: [record({ suggestion_id: id, candidate_index: v => number(v) && (v as number) < 8, role: evidenceInput.role, memo: text(2000), target: v => [record({ kind: choice('existing'), concept_id: id, expected_revision: number }), record({ kind: choice('new'), concept: record(conceptInput) })].some(check => check(v)) })],
  [IPC.EvidenceAdd]: [record({ ...evidenceInput, concept_id: id })],
  [IPC.EvidenceCreateConcept]: [record({ ...evidenceInput, concept: record(conceptInput) })],
  [IPC.EvidenceList]: [(value) => [record({ concept_id: id, offset: optional(number) }), record({ source: evidenceSource, offset: optional(number) })].some(check => check(value))],
  [IPC.EvidenceRemove]: [id],
  [IPC.LearningSuggestStart]: [record({ version_id: id, expected_revision_id: id, entry_ids: (v) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(id), model_db_id: id })],
  [IPC.NotesLearningSuggestStart]: [record({ note_id: id, expected_revision_id: id, entry_ids: v => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(id), model_db_id: id })],
  [IPC.LearningGet]: [record({ version_id: id, revision_id: optional(id) })],
  [IPC.LearningPackageExport]: [record({ version_id: id, revision_id: id })],
  [IPC.LearningPackageExportCancel]: [id],
  [IPC.LearningPackagePreview]: [],
  [IPC.LearningPackageImport]: [record({ ticket: id, subject_id: id, include_concepts: bool })],
  [IPC.LearningPackageImportCancel]: [],
  [IPC.LearningPrepare]: [id],
  [IPC.LearningAssetsPrepare]: [id],
  [IPC.LearningAssetsCancel]: [id],
  [IPC.LearningAssetsCrop]: [record({ version_id: id, page: v => number(v) && (v as number) >= 1 && (v as number) <= 100_000, rect: validLearningCropRect })],
  [IPC.LearningChange]: [learningChange('version_id', true)],
  [IPC.MaterialsOcrModels]: [],
  [IPC.MaterialsOcrPrepare]: [],
  [IPC.MaterialsOcrStart]: [record({ version_id: id, from_page: (v) => number(v) && (v as number) >= 1 && (v as number) <= 3000, to_page: (v) => number(v) && (v as number) >= 1 && (v as number) <= 3000, engine: optional(choice('ppocr', 'pix2text', 'tesseract')), language: optional(choice('zh-en', 'ja', 'ko', 'latin')) })],
  [IPC.MaterialsPpocrStatus]: [],
  [IPC.MaterialsPpocrPrepare]: [choice('v6-tiny', 'v5-ja', 'v5-ko', 'v5-latin')],
  [IPC.MaterialsPix2textStatus]: [],
  [IPC.MaterialsOcrPage]: [record({ version_id: id, page: (v) => number(v) && (v as number) >= 1 && (v as number) <= 3000 })],
  [IPC.MaterialsOcrCorrect]: [record({ version_id: id, page: (v) => number(v) && (v as number) >= 1 && (v as number) <= 3000, text: text(100_000, true) })],
  [IPC.ConceptsList]: [],
  [IPC.ConceptsSave]: [record({ id: optional(id), revision: optional(number), ...conceptInput })],
  [IPC.ConceptsReferences]: [record({ id, offset: optional((v) => number(v) && (v as number) <= 10_000_000) })],
  [IPC.ClassroomCalibrate]: [record({ note_id: id, block_id: nullable(id) })],
  [IPC.MaterialsLocate]: [record({ version_id: id, unit: choice('block', 'page', 'slide'), index: (v) => number(v) && (v as number) >= 1 && (v as number) <= 50_000 })],
  [IPC.MaterialsList]: [optional(id)],
  [IPC.MaterialsTrash]: [],
  [IPC.MaterialsRestore]: [id],
  [IPC.MaterialsUpdate]: [record({ id, title, subject_id: nullable(id), kind: choice('textbook', 'handout', 'slides', 'supplement') })],
  [IPC.MaterialsImport]: [record({ subject_id: id, title: optional(title), kind: choice('textbook', 'handout', 'slides', 'supplement'), material_id: optional(id) })],
  [IPC.MaterialsBlocks]: [record({ version_id: id, query: optional(text(500)), offset: optional((v) => number(v) && (v as number) <= 50_000) })],
  [IPC.SubjectsCreate]: [record(subject)], [IPC.SubjectsUpdate]: [record({ ...patch(subject), id })],
  [IPC.ActivitiesList]: [optional(record({ kind: optional(kind), subject_id: optional(id) }))],
  [IPC.ActivitiesCreate]: [record(activity)], [IPC.ActivitiesUpdate]: [record({ ...patch(activity), id })],
  [IPC.ProjectsList]: [opt(id)], [IPC.ProjectsCreate]: [record({ title, subject_id: opt(id), goal: optional(content), description: optional(content) })],
  [IPC.ProjectsUpdate]: [record({ id, title: optional(title), subject_id: opt(id), goal: optional(content), description: optional(content), status: optional(choice('active', 'paused', 'done', 'archived')) })],
  [IPC.ProjectsRemove]: [id], [IPC.ProjectsDetail]: [id],
  [IPC.MilestonesCreate]: [record({ project_id: id, title, detail: optional(content), due_at: opt(number) })],
  [IPC.MilestonesUpdate]: [record({ id, title: optional(title), detail: optional(content), due_at: opt(number), status: optional(choice('open', 'done')) })],
  [IPC.MilestonesRemove]: [id],
  [IPC.TasksCreate]: [record({ kind: optional(choice('project_task', 'manual')), project_id: opt(id), milestone_id: opt(id), title, planned_at: opt(number), planned_end_at: opt(number), all_day: optional(bool), location: optional(text(1000)), detail: optional(content), due_at: opt(number), knowledge_refs: optional((v) => Array.isArray(v) && v.length <= 32 && v.every((item) => record({ concept_id: id, why: text(2000) })(item))) })],
  [IPC.TasksUpdate]: [record({ id, title: optional(title), detail: optional(content), status: optional(choice('open', 'doing', 'blocked', 'done')), blocked_reason: optional(text(2000)), due_at: opt(number), planned_at: opt(number), planned_end_at: opt(number), all_day: optional(bool), location: optional(text(1000)), milestone_id: opt(id), knowledge_refs: optional((v) => Array.isArray(v) && v.length <= 32 && v.every((item) => record({ concept_id: id, why: text(2000) })(item))) })],
  [IPC.TasksRemove]: [id], [IPC.TasksListManual]: [], [IPC.TasksListAll]: [],
  [IPC.ProvidersSave]: [record({ id: optional(id), name: title, base_url: (v) => text(2048, true)(v) && safeExternal(v as string) && /^(https?):/.test(v as string), api_format: choice('openai', 'anthropic'), api_key: optional(text(16384)), enabled: optional(bool) })],
  [IPC.ModelsList]: [optional(id)],
  [IPC.ModelsSave]: [record({ id: optional(id), provider_id: id, model_id: title, display_name: optional(title), context_length: opt(number), supports_vision: optional(bool), speed_tier: opt(choice('fast', 'medium', 'slow')), notes: optional(content) })],
  [IPC.NotesList]: [optional(record(attachment))],
  [IPC.NotesCreate]: [record({ title, ...attachment, source: optional(choice('manual', 'class', 'import')) })],
  [IPC.NotesUpdate]: [record({ id, title: optional(title), ...attachment })],
  [IPC.NotesAddSegment]: [record({ note_id: id, seg_type: optional(segmentType), raw_text: optional(content), organized_text: optional(content) })],
  [IPC.NotesUpdateSegment]: [record({ id, seg_type: optional(segmentType), raw_text: optional(content), organized_text: optional(content) })],
  [IPC.AnnotationsAdd]: [record({ segment_id: id, kind: choice('keypoint', 'question'), comment: optional(content) })],
  [IPC.AnnotationsUpdate]: [record({ id, comment: content })],
  [IPC.ChatCreateSession]: [record({ ...attachment, title: optional(title) })],
  [IPC.ChatSend]: [record({ session_id: id, content: (v) => content(v) && !!(v as string).trim(), model_db_id: opt(id), context_refs: optional((v) => Array.isArray(v) && v.length <= 50 && v.every(record({ type: choice('note', 'note_segment'), id }))) })],
  [IPC.InspirationsAdd]: [record({ content: (v) => content(v) && !!(v as string).trim(), subject_id: opt(id), context_text: optional(content) })],
  [IPC.ConfigGet]: [configKey], [IPC.ConfigSet]: [configKey, nullable(text(50_000))],
  [IPC.StorageMigrate]: [text(4096, true)], [IPC.NotesRetryPending]: [optional(id)],
  [IPC.ClassroomFeedAudio]: [(v) => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= 64_000 && v.byteLength % 2 === 0 && v.byteOffset % 2 === 0]
}
for (const channel of [IPC.SubjectsRemove, IPC.ActivitiesRemove, IPC.ProvidersRemove, IPC.ProvidersTest, IPC.ModelsImport, IPC.ModelsRemove, IPC.NotesGet, IPC.NotesRemove, IPC.NotesRemoveSegment, IPC.NotesOrganizeSegment, IPC.AnnotationsRemove, IPC.ChatRemoveSession, IPC.ChatGetMessages, IPC.ChatAbort, IPC.InspirationsRemove, IPC.ClassroomStart]) rules[channel] = [id]
for (const channel of [IPC.SubjectsList, IPC.ProvidersList, IPC.PresetsList, IPC.ClassroomStop, IPC.ClassroomFlush, IPC.AsrStatus, IPC.AsrPickDir, IPC.StorageInfo, IPC.StoragePick, IPC.StorageReset, IPC.DiagnosticsAsr, IPC.DiagnosticsChat, IPC.DiagnosticsOrganize, IPC.DiagnosticsVision, IPC.ChatListSessions, IPC.InspirationsList]) rules[channel] = []

for (const channel of [IPC.MaterialsGet, IPC.MaterialsCancel, IPC.MaterialsRetry, IPC.MaterialsArchive, IPC.MaterialsOpen, IPC.MaterialsAnchor, IPC.MaterialsReferences, IPC.ClassroomPosition]) rules[channel] = [id]
for (const channel of [IPC.LearningSuggestList, IPC.LearningSuggestGet, IPC.LearningSuggestCancel, IPC.LearningSuggestDismiss, IPC.LearningSuggestApply, IPC.MaterialsOpenConverted]) rules[channel] = [id]
for (const channel of [IPC.NotesLearningSuggestList, IPC.NotesLearningSuggestGet, IPC.NotesLearningSuggestCancel, IPC.NotesLearningSuggestDismiss, IPC.NotesLearningSuggestApply]) rules[channel] = [id]
for (const channel of [IPC.MaterialsConverterStatus, IPC.MaterialsConverterPick, IPC.MaterialsConverterAuto]) rules[channel] = []

export function validateIpc(channel: string, args: unknown[]): void {
  const checks = rules[channel]
  if (!checks || args.length > checks.length || !checks.every((check, index) => check(args[index]))) throw new Error('请求参数无效或超出限制')
}
