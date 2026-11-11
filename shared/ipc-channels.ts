/**
 * shared/ipc-channels.ts —— IPC 通道名单（单一事实来源）
 *
 * 规范（docs/02-architecture.md §4）：
 *  - 命名 `域:动作`
 *  - 请求走 ipcRenderer.invoke（双向），流式事件走 webContents.send（单向推送）
 *  - 所有响应统一 ApiResult<T>，不 reject
 *
 * 本文件只登记通道名常量；载荷类型见 types.ts，
 * preload 按此名单暴露类型化 API，主进程 handler 按此名单注册。
 */

export const IPC = {
  MaterialsConverterStatus: 'materials:converterStatus',
  MaterialsConverterPick: 'materials:converterPick',
  MaterialsConverterAuto: 'materials:converterAuto',
  MaterialsOpenConverted: 'materials:openConverted',
  LearningGet: 'learning:get',
  LearningPrepare: 'learning:prepare',
  LearningChange: 'learning:change',
  LearningSuggestStart: 'learning:suggestStart',
  LearningSuggestList: 'learning:suggestList',
  LearningSuggestGet: 'learning:suggestGet',
  LearningSuggestCancel: 'learning:suggestCancel',
  LearningSuggestDismiss: 'learning:suggestDismiss',
  LearningSuggestApply: 'learning:suggestApply',
  ConceptsList: 'concepts:list',
  ConceptsSave: 'concepts:save',
  ConceptsReferences: 'concepts:references',
  MaterialsList: 'materials:list',
  MaterialsImport: 'materials:import',
  MaterialsGet: 'materials:get',
  MaterialsBlocks: 'materials:blocks',
  MaterialsCancel: 'materials:cancel',
  MaterialsRetry: 'materials:retry',
  MaterialsArchive: 'materials:archive',
  MaterialsOpen: 'materials:open',
  MaterialsAnchor: 'materials:anchor',
  MaterialsLocate: 'materials:locate',
  MaterialsReferences: 'materials:references',
  MaterialsOcrModels: 'materials:ocrModels',
  MaterialsOcrPrepare: 'materials:ocrPrepare',
  MaterialsOcrStart: 'materials:ocrStart',
  MaterialsOcrPage: 'materials:ocrPage',
  MaterialsOcrCorrect: 'materials:ocrCorrect',
  ClassroomPosition: 'classroom:position',
  ClassroomCalibrate: 'classroom:calibrate',
  /* 学科 */
  SubjectsList: 'subjects:list',
  SubjectsCreate: 'subjects:create',
  SubjectsUpdate: 'subjects:update',
  SubjectsRemove: 'subjects:remove',

  /* 活动（讲座/会议/讨论） */
  ActivitiesList: 'activities:list',
  ActivitiesCreate: 'activities:create',
  ActivitiesUpdate: 'activities:update',
  ActivitiesRemove: 'activities:remove',

  /* 供应商 */
  ProvidersList: 'providers:list',
  ProvidersSave: 'providers:save',
  ProvidersRemove: 'providers:remove',
  ProvidersTest: 'providers:test',
  PresetsList: 'presets:list',

  /* 模型 */
  ModelsList: 'models:list',
  ModelsImport: 'models:import',
  ModelsSave: 'models:save',
  ModelsRemove: 'models:remove',

  /* 笔记 */
  NotesList: 'notes:list',
  NotesGet: 'notes:get',
  NotesCreate: 'notes:create',
  NotesUpdate: 'notes:update',
  NotesRemove: 'notes:remove',
  NotesAddSegment: 'notes:addSegment',
  NotesUpdateSegment: 'notes:updateSegment',
  NotesRemoveSegment: 'notes:removeSegment',
  NotesOrganizeSegment: 'notes:organizeSegment',

  /* 课堂模式（M1） */
  ClassroomStart: 'classroom:start',
  ClassroomStop: 'classroom:stop',
  ClassroomFlush: 'classroom:flush',
  NotesRetryPending: 'notes:retryPending',
  ClassroomFeedAudio: 'classroom:feedAudio', // 单向 send（高频音频块）
  AsrStatus: 'asr:status',
  AsrPickDir: 'asr:pickDir',

  /* 配置与存储 */
  ConfigGet: 'config:get',
  ConfigSet: 'config:set',
  StorageInfo: 'storage:info',
  StoragePick: 'storage:pick',
  StorageMigrate: 'storage:migrate',
  StorageReset: 'storage:reset',

  /* 功能自检（诊断） */
  DiagnosticsAsr: 'diag:asr',
  DiagnosticsChat: 'diag:chat',
  DiagnosticsOrganize: 'diag:organize',
  DiagnosticsVision: 'diag:vision',

  /* 标注 */
  AnnotationsAdd: 'annotations:add',
  AnnotationsUpdate: 'annotations:update',
  AnnotationsRemove: 'annotations:remove',

  /* 对话 */
  ChatListSessions: 'chat:listSessions',
  ChatCreateSession: 'chat:createSession',
  ChatRemoveSession: 'chat:removeSession',
  ChatGetMessages: 'chat:getMessages',
  ChatSend: 'chat:send',
  ChatAbort: 'chat:abort',

  /* 灵感 */
  InspirationsList: 'inspirations:list',
  InspirationsAdd: 'inspirations:add',
  InspirationsRemove: 'inspirations:remove'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 流式/事件通道（主进程 -> 渲染进程单向推送） */
export const IPC_EVENTS = {
  LlmChunk: 'llm:chunk',
  LlmDone: 'llm:done',
  LlmError: 'llm:error',
  ClassroomPartial: 'classroom:partial',
  ClassroomFinal: 'classroom:final',
  SegmentOrganized: 'segment:organized'
} as const

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
