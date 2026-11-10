/**
 * shared/types.ts —— 全部业务实体与 DTO 类型
 * 三进程共享（main / preload / renderer），不依赖 electron。
 * 与 src/main/db/schema.sql 一一对应，改动需同步迁移。
 */

export type ID = string

/** 时间戳统一为 epoch 毫秒（SQLite INTEGER） */
export type Timestamp = number

/* ---------- 学科 ---------- */

export interface Subject {
  id: ID
  name: string
  color: string
  description: string
  created_at: Timestamp
}

export interface SubjectInput {
  name: string
  color?: string
  description?: string
}

/* ---------- API 供应商（ccswitch 风格） ---------- */

/** 上游格式：v1 支持两种（见 docs/02-architecture.md ADR-4） */
export type ApiFormat = 'openai' | 'anthropic'

export interface Provider {
  id: ID
  name: string
  base_url: string
  api_format: ApiFormat
  /** 渲染进程永远拿不到明文 Key，只有"是否已配置" */
  has_key: boolean
  enabled: boolean
  created_at: Timestamp
  updated_at: Timestamp
}

export interface ProviderInput {
  name: string
  base_url: string
  api_format: ApiFormat
  api_key?: string // 仅创建/更新时上行；存储前经 safeStorage 加密
  enabled?: boolean
}

/** 供应商预设（添加面板一键填充，不直接入库） */
export interface ProviderPreset {
  key: string
  label: string
  base_url: string
  api_format: ApiFormat
  /** 预置模型（仅作示例，用户应通过"导入模型"拉取真实列表） */
  models: PresetModel[]
  hint?: string
}

export interface PresetModel {
  model_id: string
  display_name: string
  context_length?: number
  supports_vision?: boolean
  speed_tier?: SpeedTier
  notes?: string
}

export type SpeedTier = 'fast' | 'medium' | 'slow'

/* ---------- 模型 ---------- */

export interface ModelInfo {
  id: ID
  provider_id: ID
  model_id: string
  display_name: string
  context_length: number | null
  supports_vision: boolean
  speed_tier: SpeedTier | null
  notes: string
  created_at: Timestamp
}

export interface ModelInput {
  provider_id: ID
  model_id: string
  display_name?: string
  context_length?: number | null
  supports_vision?: boolean
  speed_tier?: SpeedTier | null
  notes?: string
}

/* ---------- 笔记与段落 ---------- */

export type SegmentType =
  | 'definition' // 定义
  | 'proposition' // 命题/定理
  | 'example' // 例题
  | 'proof' // 证明
  | 'solution' // 解答
  | 'note' // 注意
  | 'other' // 其他

export const SEGMENT_TYPE_META: Record<SegmentType, { label: string; color: string }> = {
  definition: { label: '定义', color: '#2563eb' },
  proposition: { label: '命题', color: '#7c3aed' },
  example: { label: '例题', color: '#16a34a' },
  proof: { label: '证明', color: '#ea580c' },
  solution: { label: '解答', color: '#0891b2' },
  note: { label: '注意', color: '#dc2626' },
  other: { label: '其他', color: '#64748b' }
}

export interface Note {
  id: ID
  subject_id: ID | null
  title: string
  source: 'manual' | 'class' | 'import'
  created_at: Timestamp
  updated_at: Timestamp
}

export interface NoteSegment {
  id: ID
  note_id: ID
  sort_order: number
  seg_type: SegmentType
  /** 原文视图（转写规整后的口语原文；手动笔记则与整理视图可一致） */
  raw_text: string
  /** 整理视图（AI 或手动整理后的 markdown） */
  organized_text: string
  image_path: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface NoteWithSegments extends Note {
  segments: NoteSegment[]
  annotations: Annotation[]
}

export interface SegmentInput {
  note_id: ID
  seg_type?: SegmentType
  raw_text?: string
  organized_text?: string
}

/* ---------- 标注 ---------- */

export type AnnotationKind = 'keypoint' | 'question'

export interface Annotation {
  id: ID
  segment_id: ID
  kind: AnnotationKind
  /** 选区定位（M0 为整段级 null；M1 BlockNote 接入后为选区 JSON） */
  anchor_json: string | null
  comment: string
  created_at: Timestamp
}

export interface AnnotationInput {
  segment_id: ID
  kind: AnnotationKind
  comment?: string
}

/* ---------- 对话 ---------- */

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatSession {
  id: ID
  subject_id: ID | null
  title: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface ChatMessage {
  id: ID
  session_id: ID
  role: ChatRole
  content: string
  /** 消息挂载的上下文引用（笔记段/材料 id 列表） */
  context_json: string | null
  created_at: Timestamp
}

/** 上下文引用：渲染进程只传 id，主进程查库拼装全文（ADR-2） */
export interface ContextRef {
  type: 'note_segment' | 'note'
  id: ID
}

export interface ChatSendInput {
  session_id: ID
  content: string
  /** 本次提问挂载的上下文 */
  context_refs?: ContextRef[]
  /** 指定模型；null 则用该会话上次模型或第一个可用模型 */
  model_db_id?: ID | null
}

/** 流式事件（主进程 -> 渲染进程） */
export interface LlmChunkEvent {
  session_id: ID
  message_id: ID
  delta: string
}

export interface LlmDoneEvent {
  session_id: ID
  message_id: ID
  content: string
  model_display: string
}

export interface LlmErrorEvent {
  session_id: ID
  message_id: ID
  error: string
}

/* ---------- 灵感 ---------- */

export interface Inspiration {
  id: ID
  subject_id: ID | null
  content: string
  context_text: string
  created_at: Timestamp
}

export interface InspirationInput {
  content: string
  subject_id?: ID | null
  context_text?: string
}

/* ---------- 通用 ---------- */

export interface ApiOk<T> {
  ok: true
  data: T
}

export interface ApiErr {
  ok: false
  error: string
}

export type ApiResult<T> = ApiOk<T> | ApiErr

/** 发给 LLM 的消息（openai/anthropic 两种格式的公共子集） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 主进程连通性测试结果 */
export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  error?: string
}
