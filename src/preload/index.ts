/**
 * preload/index.ts —— contextBridge 暴露的类型化 API
 *
 * 渲染进程只能通过 window.api.* 与主进程通信（contextIsolation 开启），
 * ipcRenderer 本体、Node API 一律不暴露。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type {
  ApiResult, Subject, SubjectInput, Provider, ProviderInput, ProviderTestResult,
  ModelInfo, ModelInput, Note, NoteWithSegments, NoteSegment, Annotation, AnnotationKind,
  SegmentType, ChatSession, ChatMessage, ChatSendInput, Inspiration,
  InspirationInput, LlmChunkEvent, LlmDoneEvent, LlmErrorEvent, ID,
  Activity, ActivityInput, ActivityKind,
  AsrStatus, ClassroomStartResult, ClassroomPartialEvent, ClassroomFinalEvent,
  SegmentOrganizedEvent, StorageInfo,
  DiagAsrResult, DiagChatResult, DiagOrganizeResult, DiagVisionResult
} from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer) as <T>(channel: string, ...args: unknown[]) => Promise<ApiResult<T>>

const api = {
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
