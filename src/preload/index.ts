import type { MemoInput, MemoDetail, MemoPage, MemoRoutePlan, MemoRoutePreview, MemoReference, MemoAutoSettings, MemoAutoState } from '@shared/memos'
/**
 * preload/index.ts —— contextBridge 暴露的类型化 API
 *
 * 渲染进程只能通过 window.api.* 与主进程通信（contextIsolation 开启），
 * ipcRenderer 本体、Node API 一律不暴露。
 */
import type { ProjectDocumentDetail, ProjectDocumentSummary, ProjectDocumentSave, ProjectDocumentChange, ProjectDocumentAction, ProjectDocumentKind } from '@shared/project-documents'
import type { TaskResourceAdd, TaskResourceEdit, TaskResourceSource, TaskResourcePage, TaskResource } from '@shared/task-resources'
import { contextBridge, ipcRenderer } from 'electron'
import type { ReminderAction, ReminderConfiguration, ReminderPage, ReminderSettings, ReminderTaskOptions } from '@shared/reminders'
import type { ContinuousSettings, ContinuousState } from '@shared/continuous-schedule'
import type { PlanningState, PlanningPreview, ScheduleSettings, TaskPlanningSave } from '@shared/auto-schedule'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type { KnowledgeGraph, ConceptRelationInput, ConceptRelation, ConceptRelationRemove, ConceptPosition, ConceptUsagePage } from '@shared/knowledge-graph'
import type { ExerciseDetail, ExerciseInput, ExerciseListInput, ExercisePage, ExerciseSource } from '@shared/exercises'
import type { ExerciseSetPreview, ExerciseSetResult } from '@shared/exercise-set'
import type { CalendarRange, CalendarPreview, CalendarImportResult, CalendarExportResult, CalendarImportOptions, CalendarTaskSaveInput, CalendarTaskSaveResult } from '@shared/calendar'
import type { LearningPackageExportInput, LearningPackageExportResult, LearningPackagePreview, LearningPackageImportInput, LearningPackageImportResult } from '@shared/learning-package'
import type { LearningPdfInput, LearningPdfResult } from '@shared/learning-pdf'
import type { NotePackageExportInput, NotePackageExportResult, NotePackagePreview, NotePackageImportResult, NotePackageReceipt } from '@shared/note-package'
import type {
  LearningDocument, LearningChange, LearningPdfCrop, LearningSuggestInput, LearningSuggestion, LearningSuggestionDetail, OfficeConverterStatus, Concept, Evidence, EvidenceInput, EvidenceListInput, EvidencePage, ConceptFromEvidenceInput,
  KnowledgeSuggestInput, KnowledgeSuggestion, KnowledgeSuggestionDetail, KnowledgeAdoptInput, EvidenceSource,
  Material, MaterialDetail, MaterialInput, MaterialBlock, MaterialAnchor, MaterialLocateInput, MaterialNoteRef, ClassroomPosition, OcrInput, OcrCorrectionInput, OcrPage, OcrModelsStatus,
  ApiResult, Subject, SubjectInput, Provider, ProviderInput, ProviderTestResult,
  ModelInfo, ModelInput, Note, NoteWithSegments, NoteSegment, NoteLearningDocument, NoteLearningChange, NoteLearningSyncPreview, NoteLearningSuggestInput, NoteLearningSuggestion, NoteLearningSuggestionDetail, Annotation, AnnotationKind,
  SegmentType, ChatSession, ChatMessage, ChatSendInput, Inspiration,
  InspirationInput, LlmChunkEvent, LlmDoneEvent, LlmErrorEvent, ID,
  Activity, ActivityInput, ActivityKind,
  AsrStatus, ClassroomStartResult, ClassroomPartialEvent, ClassroomFinalEvent,
  SegmentOrganizedEvent, StorageInfo,
  Project, ProjectInput, ProjectDetail, Milestone, MilestoneInput, Task, TaskInput,
  DiagAsrResult, DiagChatResult, DiagOrganizeResult, DiagVisionResult
} from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer) as <T>(channel: string, ...args: unknown[]) => Promise<ApiResult<T>>

const api = {
  memos: {
    autoState:()=>invoke<MemoAutoState>(IPC.MemoAutoState),
    autoSave:(input:Omit<MemoAutoSettings,'since'>)=>invoke<MemoAutoState>(IPC.MemoAutoSave,input),
    autoBacklog:()=>invoke<number>(IPC.MemoAutoBacklog),
    autoAction:(input:{id:string;action:'cancel'|'retry'})=>invoke<MemoAutoState>(IPC.MemoAutoAction,input),
    list:(input:{query:string;archived:boolean;offset:number;state?:'all'|'inbox'|'routed'})=>invoke<MemoPage>(IPC.MemosList,input),
    get:(id:string)=>invoke<MemoDetail>(IPC.MemosGet,id),
    save:(input:MemoInput)=>invoke<MemoDetail>(IPC.MemosSave,input),
    archive:(input:{id:string;expected_revision:string;archived:boolean})=>invoke<MemoDetail>(IPC.MemosArchive,input),
    fromInspiration:(id:string)=>invoke<MemoDetail>(IPC.MemosInspiration,id),
    preview:(input:MemoRoutePlan)=>invoke<MemoRoutePreview>(IPC.MemosPreview,input),
    apply:(input:{plan:MemoRoutePlan;fingerprint:string;ignore_conflicts:boolean})=>invoke<MemoDetail>(IPC.MemosApply,input),
    undo:(id:string)=>invoke<MemoDetail>(IPC.MemosUndo,id),
    references:(input:{kind:'concept'|'task';id:string})=>invoke<MemoReference[]>(IPC.MemosReferences,input),
    recognize:(input:{id:string;expected_revision:string;model_db_id:string})=>invoke<MemoDetail>(IPC.MemosRecognize,input),
    cancelRecognition:(id:string)=>invoke<boolean>(IPC.MemosCancel,id)
  },
  exerciseSets: {
    preview: (versionId: string) => invoke<ExerciseSetPreview>(IPC.ExerciseSetsPreview, versionId),
    import: (input: { token: string; entry_ids: string[] }) => invoke<ExerciseSetResult>(IPC.ExerciseSetsImport, input),
    discard: () => invoke<boolean>(IPC.ExerciseSetsDiscard)
  },
  exercises: {
    list: (input: ExerciseListInput) => invoke<ExercisePage>(IPC.ExercisesList, input),
    get: (input: { id: string; revision_id?: string }) => invoke<ExerciseDetail>(IPC.ExercisesGet, input),
    save: (input: ExerciseInput) => invoke<ExerciseDetail>(IPC.ExercisesSave, input),
    import: (input: ExerciseSource) => invoke<ExerciseDetail>(IPC.ExercisesImport, input),
    trash: (input: { id: string; expected_revision_id: string }) => invoke<ExerciseDetail>(IPC.ExercisesTrash, input),
    restore: (input: { id: string; expected_revision_id: string }) => invoke<ExerciseDetail>(IPC.ExercisesRestore, input)
  },
  knowledgeSuggestions: {
    start: (input: KnowledgeSuggestInput) => invoke<KnowledgeSuggestion>(IPC.KnowledgeSuggestStart, input),
    list: (source: EvidenceSource) => invoke<KnowledgeSuggestion[]>(IPC.KnowledgeSuggestList, source),
    get: (id: ID) => invoke<KnowledgeSuggestionDetail>(IPC.KnowledgeSuggestGet, id),
    cancel: (id: ID) => invoke<boolean>(IPC.KnowledgeSuggestCancel, id),
    dismiss: (id: ID) => invoke<boolean>(IPC.KnowledgeSuggestDismiss, id),
    adopt: (input: KnowledgeAdoptInput) => invoke<KnowledgeSuggestionDetail>(IPC.KnowledgeSuggestAdopt, input)
  },
  evidence: {
    add: (input: EvidenceInput) => invoke<{ evidence: Evidence; created: boolean }>(IPC.EvidenceAdd, input),
    createConcept: (input: ConceptFromEvidenceInput) => invoke<{ concept: Concept; evidence: Evidence }>(IPC.EvidenceCreateConcept, input),
    list: (input: EvidenceListInput) => invoke<EvidencePage>(IPC.EvidenceList, input),
    remove: (id: ID) => invoke<boolean>(IPC.EvidenceRemove, id)
  },
  learning: {
    packagePreview: () => invoke<LearningPackagePreview | null>(IPC.LearningPackagePreview),
    packageImport: (input: LearningPackageImportInput) => invoke<LearningPackageImportResult>(IPC.LearningPackageImport, input),
    packageImportCancel: () => invoke<boolean>(IPC.LearningPackageImportCancel),
    packageExport: (input: LearningPackageExportInput) => invoke<LearningPackageExportResult | null>(IPC.LearningPackageExport, input),
    packageExportCancel: (versionId: ID) => invoke<boolean>(IPC.LearningPackageExportCancel, versionId),
    pdfExport: (input: LearningPdfInput) => invoke<LearningPdfResult | null>(IPC.LearningPdfExport, input),
    pdfCancel: () => invoke<boolean>(IPC.LearningPdfCancel),
    suggestStart: (input: LearningSuggestInput) => invoke<LearningSuggestion>(IPC.LearningSuggestStart, input),
    suggestList: (versionId: ID) => invoke<LearningSuggestion[]>(IPC.LearningSuggestList, versionId),
    suggestGet: (id: ID) => invoke<LearningSuggestionDetail>(IPC.LearningSuggestGet, id),
    suggestCancel: (id: ID) => invoke<boolean>(IPC.LearningSuggestCancel, id),
    suggestDismiss: (id: ID) => invoke<boolean>(IPC.LearningSuggestDismiss, id),
    suggestApply: (id: ID) => invoke<LearningDocument>(IPC.LearningSuggestApply, id),
    get: (input: { version_id: ID; revision_id?: ID }) => invoke<LearningDocument | null>(IPC.LearningGet, input),
    prepare: (id: ID) => invoke<LearningDocument>(IPC.LearningPrepare, id),
    assetsPrepare: (id: ID) => invoke<LearningDocument>(IPC.LearningAssetsPrepare, id),
    assetsCancel: (id: ID) => invoke<boolean>(IPC.LearningAssetsCancel, id),
    assetsCrop: (input: LearningPdfCrop) => invoke<LearningDocument>(IPC.LearningAssetsCrop, input),
    change: (input: LearningChange) => invoke<LearningDocument>(IPC.LearningChange, input)
  },
  concepts: {
    graph: () => invoke<KnowledgeGraph>(IPC.ConceptsGraph),
    relationSave: (input: ConceptRelationInput) => invoke<ConceptRelation>(IPC.ConceptsRelationSave,input),
    relationRemove: (input: ConceptRelationRemove) => invoke<boolean>(IPC.ConceptsRelationRemove,input),
    positions: (input: ConceptPosition[]) => invoke<boolean>(IPC.ConceptsPositions,input),
    usage: (input: { concept_id: string; offset?: number }) => invoke<ConceptUsagePage>(IPC.ConceptsUsage,input),
    list: () => invoke<import('@shared/types').Concept[]>(IPC.ConceptsList),
    save: (input: import('@shared/types').ConceptInput) => invoke<import('@shared/types').Concept>(IPC.ConceptsSave, input),
    references: (input: { id: ID; offset?: number }) => invoke<import('@shared/types').ConceptReferences>(IPC.ConceptsReferences, input)
  },
  materials: {
    converterStatus: () => invoke<OfficeConverterStatus>(IPC.MaterialsConverterStatus),
    converterPick: () => invoke<OfficeConverterStatus>(IPC.MaterialsConverterPick),
    converterAuto: () => invoke<OfficeConverterStatus>(IPC.MaterialsConverterAuto),
    openConverted: (id: ID) => invoke<boolean>(IPC.MaterialsOpenConverted, id),
    ocrModels: () => invoke<OcrModelsStatus>(IPC.MaterialsOcrModels),
    ocrPrepare: () => invoke<OcrModelsStatus>(IPC.MaterialsOcrPrepare),
    ppocrStatus: () => invoke<{ presets: Array<{ key: string; label: string; ready: boolean; missing: string[] }> }>(IPC.MaterialsPpocrStatus),
    ppocrPrepare: (preset: string) => invoke<{ presets: Array<{ key: string; label: string; ready: boolean; missing: string[] }> }>(IPC.MaterialsPpocrPrepare, preset),
    pix2textStatus: () => invoke<{ python: boolean; pythonDetail: string; pix2text: boolean; pix2textVersion: string | null; sidecarRunning: boolean; issue: string | null }>(IPC.MaterialsPix2textStatus),
    ocrStart: (input: OcrInput) => invoke<ID>(IPC.MaterialsOcrStart, input),
    ocrPage: (input: { version_id: ID; page: number }) => invoke<OcrPage | null>(IPC.MaterialsOcrPage, input),
    ocrCorrect: (input: OcrCorrectionInput) => invoke<ID>(IPC.MaterialsOcrCorrect, input),
    anchor: (id: ID) => invoke<MaterialAnchor>(IPC.MaterialsAnchor, id),
    locate: (input: MaterialLocateInput) => invoke<MaterialAnchor | null>(IPC.MaterialsLocate, input),
    references: (id: ID) => invoke<MaterialNoteRef[]>(IPC.MaterialsReferences, id),
    list: (subjectId?: ID) => invoke<Material[]>(IPC.MaterialsList, subjectId),
    import: (input: MaterialInput) => invoke<Material | null>(IPC.MaterialsImport, input),
    get: (id: ID) => invoke<MaterialDetail>(IPC.MaterialsGet, id),
    blocks: (input: { version_id: ID; query?: string; offset?: number }) => invoke<{ blocks: MaterialBlock[]; total: number }>(IPC.MaterialsBlocks, input),
    cancel: (id: ID) => invoke<boolean>(IPC.MaterialsCancel, id),
    retry: (id: ID) => invoke<boolean>(IPC.MaterialsRetry, id),
    archive: (id: ID) => invoke<boolean>(IPC.MaterialsArchive, id),
    trash: () => invoke<Material[]>(IPC.MaterialsTrash),
    restore: (id: ID) => invoke<boolean>(IPC.MaterialsRestore, id),
    update: (id: ID, input: Pick<Material, 'title' | 'subject_id' | 'kind'>) => invoke<Material>(IPC.MaterialsUpdate, { id, ...input }),
    open: (id: ID) => invoke<boolean>(IPC.MaterialsOpen, id)
  },
  subjects: {
    list: () => invoke<Subject[]>(IPC.SubjectsList),
    create: (input: SubjectInput) => invoke<Subject>(IPC.SubjectsCreate, input),
    update: (id: ID, patch: Partial<SubjectInput>) => invoke<Subject>(IPC.SubjectsUpdate, { id, ...patch }),
    remove: (id: ID) => invoke<boolean>(IPC.SubjectsRemove, id)
  },
  activities: {
    list: (filter?: { kind?: ActivityKind; subject_id?: ID }) => invoke<Activity[]>(IPC.ActivitiesList, filter),
    create: (input: ActivityInput) => invoke<Activity>(IPC.ActivitiesCreate, input),
    update: (id: ID, patch: Partial<ActivityInput>) => invoke<Activity>(IPC.ActivitiesUpdate, { id, ...patch }),
    remove: (id: ID) => invoke<boolean>(IPC.ActivitiesRemove, id)
  },
  providers: {
    list: () => invoke<Provider[]>(IPC.ProvidersList),
    save: (input: ProviderInput & { id?: ID }) => invoke<Provider>(IPC.ProvidersSave, input),
    remove: (id: ID) => invoke<boolean>(IPC.ProvidersRemove, id),
    test: (id: ID) => invoke<ProviderTestResult>(IPC.ProvidersTest, id)
  },
  models: {
    list: (providerId?: ID) => invoke<ModelInfo[]>(IPC.ModelsList, providerId),
    /** 返回上游模型 id 字符串数组（不入库，用户确认后逐条 save） */
    import: (providerId: ID) => invoke<string[]>(IPC.ModelsImport, providerId),
    save: (input: ModelInput & { id?: ID }) => invoke<ModelInfo>(IPC.ModelsSave, input),
    remove: (id: ID) => invoke<boolean>(IPC.ModelsRemove, id)
  },
  notes: {
    packagePreview: () => invoke<NotePackagePreview | null>(IPC.NotesPackagePreview),
    packageImport: (input: LearningPackageImportInput) => invoke<NotePackageImportResult>(IPC.NotesPackageImport, input),
    packageImportCancel: () => invoke<boolean>(IPC.NotesPackageImportCancel),
    packageReceipt: (noteId: ID) => invoke<NotePackageReceipt | null>(IPC.NotesPackageReceipt, noteId),
    packageExport: (input: NotePackageExportInput) => invoke<NotePackageExportResult | null>(IPC.NotesPackageExport, input),
    packageExportCancel: (noteId: ID) => invoke<boolean>(IPC.NotesPackageExportCancel, noteId),
    learningGet: (input: { note_id: ID; revision_id?: ID }) => invoke<NoteLearningDocument>(IPC.NotesLearningGet, input),
    learningSuggestStart: (input: NoteLearningSuggestInput) => invoke<NoteLearningSuggestion>(IPC.NotesLearningSuggestStart, input),
    learningSuggestList: (noteId: ID) => invoke<NoteLearningSuggestion[]>(IPC.NotesLearningSuggestList, noteId),
    learningSuggestGet: (id: ID) => invoke<NoteLearningSuggestionDetail>(IPC.NotesLearningSuggestGet, id),
    learningSuggestCancel: (id: ID) => invoke<boolean>(IPC.NotesLearningSuggestCancel, id),
    learningSuggestDismiss: (id: ID) => invoke<boolean>(IPC.NotesLearningSuggestDismiss, id),
    learningSuggestApply: (id: ID) => invoke<NoteLearningDocument>(IPC.NotesLearningSuggestApply, id),
    learningChange: (input: NoteLearningChange) => invoke<NoteLearningDocument>(IPC.NotesLearningChange, input),
    learningPreview: (id: ID) => invoke<NoteLearningSyncPreview>(IPC.NotesLearningPreview, id),
    learningSync: (input: { note_id: ID; expected_revision_id: ID; fingerprint: string }) => invoke<NoteLearningDocument>(IPC.NotesLearningSync, input),
    list: (filter?: { subject_id?: ID | null; activity_id?: ID | null }) => invoke<Note[]>(IPC.NotesList, filter),
    get: (id: ID) => invoke<NoteWithSegments>(IPC.NotesGet, id),
    create: (input: { title: string; subject_id?: ID | null; activity_id?: ID | null; source?: Note['source'] }) => invoke<Note>(IPC.NotesCreate, input),
    update: (id: ID, patch: { title?: string; subject_id?: ID | null; activity_id?: ID | null }) => invoke<Note>(IPC.NotesUpdate, { id, ...patch }),
    remove: (id: ID) => invoke<boolean>(IPC.NotesRemove, id),
    addSegment: (input: { note_id: ID; seg_type?: SegmentType; raw_text?: string; organized_text?: string }) =>
      invoke<NoteSegment>(IPC.NotesAddSegment, input),
    updateSegment: (id: ID, patch: { seg_type?: SegmentType; raw_text?: string; organized_text?: string }) =>
      invoke<NoteSegment>(IPC.NotesUpdateSegment, { id, ...patch }),
    removeSegment: (id: ID) => invoke<boolean>(IPC.NotesRemoveSegment, id)
  },
  annotations: {
    add: (input: { segment_id: ID; kind: AnnotationKind; comment?: string }) => invoke<Annotation>(IPC.AnnotationsAdd, input),
    update: (id: ID, comment: string) => invoke<Annotation>(IPC.AnnotationsUpdate, { id, comment }),
    remove: (id: ID) => invoke<boolean>(IPC.AnnotationsRemove, id)
  },
  classroom: {
    position: (noteId: ID) => invoke<ClassroomPosition | null>(IPC.ClassroomPosition, noteId),
    calibrate: (input: { note_id: ID; block_id: ID | null }) => invoke<ClassroomPosition>(IPC.ClassroomCalibrate, input),
    flush: () => invoke<boolean>(IPC.ClassroomFlush),
    retryPending: (noteId?: ID) => invoke<number>(IPC.NotesRetryPending, noteId),
    /** 返回 mode: 'asr'（语音就绪）| 'manual'（手动转写模式） */
    start: (noteId: ID) => invoke<ClassroomStartResult>(IPC.ClassroomStart, noteId),
    stop: () => invoke<boolean>(IPC.ClassroomStop),
    /** 高频音频块：单向 send（16k 单声道 Int16 PCM） */
    feedAudio: (pcm: Int16Array) => {
      ipcRenderer.send(IPC.ClassroomFeedAudio, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    },
    asrStatus: () => invoke<AsrStatus>(IPC.AsrStatus),
    pickModelDir: () => invoke<string | null>(IPC.AsrPickDir),
    /** 触发段落 AI 整理（结果经 onSegmentOrganized 事件回推） */
    organizeSegment: (segmentId: ID) => invoke<SegmentOrganizedEvent>(IPC.NotesOrganizeSegment, segmentId)
  },
  config: {
    get: (key: string) => invoke<string | null>(IPC.ConfigGet, key),
    set: (key: string, value: string | null) => invoke<boolean>(IPC.ConfigSet, key, value)
  },
  storage: {
    info: () => invoke<StorageInfo>(IPC.StorageInfo),
    pickDir: () => invoke<string | null>(IPC.StoragePick),
    /** 迁移数据到新目录（旧数据保留作保险）；返回新的存储信息 */
    migrate: (newDir: string) => invoke<StorageInfo>(IPC.StorageMigrate, newDir),
    resetToDefault: () => invoke<StorageInfo>(IPC.StorageReset)
  },
  diag: {
    asr: () => invoke<DiagAsrResult>(IPC.DiagnosticsAsr),
    chat: () => invoke<DiagChatResult>(IPC.DiagnosticsChat),
    organize: () => invoke<DiagOrganizeResult>(IPC.DiagnosticsOrganize),
    vision: () => invoke<DiagVisionResult>(IPC.DiagnosticsVision)
  },
  chat: {
    listSessions: () => invoke<ChatSession[]>(IPC.ChatListSessions),
    createSession: (input: { subject_id?: ID | null; activity_id?: ID | null; title?: string }) => invoke<ChatSession>(IPC.ChatCreateSession, input),
    removeSession: (id: ID) => invoke<boolean>(IPC.ChatRemoveSession, id),
    getMessages: (sessionId: ID) => invoke<ChatMessage[]>(IPC.ChatGetMessages, sessionId),
    /** 发送后流式事件经 onLlmChunk/onLlmDone/onLlmError 推送 */
    send: (input: ChatSendInput) => invoke<boolean>(IPC.ChatSend, input),
    abort: (messageId: ID) => invoke<boolean>(IPC.ChatAbort, messageId)
  },
  inspirations: {
    list: () => invoke<Inspiration[]>(IPC.InspirationsList),
    add: (input: InspirationInput) => invoke<Inspiration>(IPC.InspirationsAdd, input),
    remove: (id: ID) => invoke<boolean>(IPC.InspirationsRemove, id)
  },
  taskResources: {
    list: (input: {task_id:string;offset?:number}) => invoke<TaskResourcePage>(IPC.TaskResourcesList,input),
    backlinks: (input: {source:TaskResourceSource;offset?:number}) => invoke<TaskResourcePage>(IPC.TaskResourcesBacklinks,input),
    add: (input:TaskResourceAdd) => invoke<{resource:TaskResource;created:boolean}>(IPC.TaskResourcesAdd,input),
    edit: (input:TaskResourceEdit) => invoke<TaskResource>(IPC.TaskResourcesEdit,input),
    remove: (input:{id:string;expected_revision:string}) => invoke<boolean>(IPC.TaskResourcesRemove,input)
  },
  projectDocuments: {
    list: (input: { project_id: string; trash?: boolean }) => invoke<ProjectDocumentSummary[]>(IPC.ProjectDocumentsList,input),
    get: (input: { id: string; revision_id?: string }) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsGet,input),
    save: (input: ProjectDocumentSave) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsSave,input),
    change: (input: ProjectDocumentChange) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsChange,input),
    revisionRestore: (input: ProjectDocumentAction & { revision_id: string }) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsRevisionRestore,input),
    trash: (input: ProjectDocumentAction) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsTrash,input),
    restore: (input: ProjectDocumentAction) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsRestore,input),
    import: (input: { project_id: string; material_id: string; version_id: string; revision_id: string; kind: ProjectDocumentKind }) => invoke<ProjectDocumentDetail>(IPC.ProjectDocumentsImport,input)
  },
  projects: {
    list: (subjectId?: ID | null) => invoke<Project[]>(IPC.ProjectsList, subjectId),
    create: (input: ProjectInput) => invoke<Project>(IPC.ProjectsCreate, input),
    update: (id: ID, patchInput: Partial<ProjectInput>) => invoke<Project>(IPC.ProjectsUpdate, { id, ...patchInput }),
    remove: (id: ID) => invoke<boolean>(IPC.ProjectsRemove, id),
    detail: (id: ID) => invoke<ProjectDetail>(IPC.ProjectsDetail, id)
  },
  milestones: {
    create: (input: MilestoneInput) => invoke<Milestone>(IPC.MilestonesCreate, input),
    update: (id: ID, patchInput: Partial<MilestoneInput> & { status?: 'open' | 'done' }) => invoke<Milestone>(IPC.MilestonesUpdate, { id, ...patchInput }),
    remove: (id: ID) => invoke<boolean>(IPC.MilestonesRemove, id)
  },
  tasks: {
    create: (input: TaskInput) => invoke<Task>(IPC.TasksCreate, input),
    update: (id: ID, patchInput: Partial<TaskInput> & { status?: Task['status']; blocked_reason?: string; planned_at?: number | null }) => invoke<Task>(IPC.TasksUpdate, { id, ...patchInput }),
    remove: (id: ID) => invoke<boolean>(IPC.TasksRemove, id),
    listManual: () => invoke<Task[]>(IPC.TasksListManual),
    listAll: () => invoke<Array<Task & { project_title: string | null; project_subject_id: string | null }>>(IPC.TasksListAll)
  },
  calendar: {
    continuous: () => invoke<ContinuousState>(IPC.ContinuousGet),
    saveContinuous: (input:ContinuousSettings) => invoke<ContinuousState>(IPC.ContinuousSave,input),
    checkContinuous: () => invoke<ContinuousState>(IPC.ContinuousCheck),
    planning: () => invoke<PlanningState>(IPC.PlanningGet),
    saveSettings: (input: {expected_revision:string|null;value:ScheduleSettings}) => invoke<PlanningState>(IPC.PlanningSettings,input),
    savePlanning: (input: TaskPlanningSave) => invoke<PlanningState>(IPC.PlanningTask,input),
    changeBlock: (input:{id:string;expected_revision:string;action:'lock'|'unlock'|'remove'}) => invoke<PlanningState>(IPC.PlanningBlock,input),
    moveBlock: (input: import('@shared/schedule-block-move').BlockMoveInput) => invoke<import('@shared/schedule-block-move').BlockMoveResult>(IPC.PlanningMove,input),
    plan: (range:CalendarRange) => invoke<PlanningPreview>(IPC.PlanningPreview,range),
    applyPlan: (token:string) => invoke<PlanningState>(IPC.PlanningApply,token),
    discardPlan: () => invoke<boolean>(IPC.PlanningDiscard),
    undoPlan: (id:string) => invoke<PlanningState>(IPC.PlanningUndo,id),
    save: (input: CalendarTaskSaveInput) => invoke<CalendarTaskSaveResult>(IPC.CalendarSave, input),
    preview: (range: CalendarRange) => invoke<CalendarPreview | null>(IPC.CalendarPreview, range),
    import: (token: string, options?: CalendarImportOptions) => invoke<CalendarImportResult>(IPC.CalendarImport, token, options),
    discard: () => invoke<boolean>(IPC.CalendarDiscard),
    export: () => invoke<CalendarExportResult | null>(IPC.CalendarExport)
  },
  reminders: {
    settings: () => invoke<ReminderConfiguration>(IPC.RemindersSettings),
    saveSettings: (input:{expected_revision:string|null;value:ReminderSettings}) => invoke<ReminderConfiguration>(IPC.RemindersSaveSettings,input),
    task: (id:string) => invoke<ReminderTaskOptions>(IPC.RemindersTask,id),
    saveTask: (input:ReminderTaskOptions) => invoke<ReminderTaskOptions>(IPC.RemindersSaveTask,input),
    list: (input:{view:'attention'|'upcoming'|'history';offset?:number}) => invoke<ReminderPage>(IPC.RemindersList,input),
    action: (input:ReminderAction) => invoke<boolean>(IPC.RemindersAction,input),
    test: () => invoke<string>(IPC.RemindersTest)
  },
  onReminderOpen: (cb:(input:{task_id?:string})=>void) => subscribe(IPC_EVENTS.ReminderOpen,cb),
  /** 流式事件订阅（返回取消订阅函数） */
  onLlmChunk: (cb: (e: LlmChunkEvent) => void) => subscribe(IPC_EVENTS.LlmChunk, cb),
  onLlmDone: (cb: (e: LlmDoneEvent) => void) => subscribe(IPC_EVENTS.LlmDone, cb),
  onLlmError: (cb: (e: LlmErrorEvent) => void) => subscribe(IPC_EVENTS.LlmError, cb),
  onClassroomPartial: (cb: (e: ClassroomPartialEvent) => void) => subscribe(IPC_EVENTS.ClassroomPartial, cb),
  onClassroomFinal: (cb: (e: ClassroomFinalEvent) => void) => subscribe(IPC_EVENTS.ClassroomFinal, cb),
  onSegmentOrganized: (cb: (e: SegmentOrganizedEvent) => void) => subscribe(IPC_EVENTS.SegmentOrganized, cb)
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
