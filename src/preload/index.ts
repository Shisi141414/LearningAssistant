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
  Activity, ActivityInput, ActivityKind
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
    create: (input: { title: string; subject_id?: ID | null; activity_id?: ID | null }) => invoke<Note>(IPC.NotesCreate, input),
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
  onLlmError: (cb: (e: LlmErrorEvent) => void) => subscribe(IPC_EVENTS.LlmError, cb)
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronApi = typeof api
