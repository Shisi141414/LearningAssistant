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

/* ---------- 活动（讲座/会议/讨论，ADR-5） ---------- */

export type ActivityKind = 'lecture' | 'seminar' | 'meeting' | 'other'

export const ACTIVITY_KIND_META: Record<ActivityKind, { label: string; color: string }> = {
  lecture: { label: '讲座', color: '#0d9488' },
  seminar: { label: '研讨', color: '#9333ea' },
  meeting: { label: '会议', color: '#b45309' },
  other: { label: '其他', color: '#64748b' }
}

export interface Activity {
  id: ID
  title: string
  kind: ActivityKind
  happened_at: Timestamp | null
  /** 可选关联学科：活动内容的知识点可挂入该学科知识网络 */
  subject_id: ID | null
  description: string
  created_at: Timestamp
  /** 列表查询附带：该活动的笔记数 */
  notes_count?: number
}

export interface ActivityInput {
  title: string
  kind?: ActivityKind
  happened_at?: Timestamp | null
  subject_id?: ID | null
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
  /** 挂载活动（与 subject_id 二选一，ADR-5） */
  activity_id: ID | null
  title: string
  source: 'manual' | 'class' | 'import'
  created_at: Timestamp
  updated_at: Timestamp
  /** 列表查询附带：挂载活动的标题（用于"全部"视图标识） */
  activity_title?: string | null
}

export interface NoteSegment {
  material_ref?: MaterialAnchor | null
  revision?: number
  organized_by?: 'initial' | 'ai' | 'user'
  organize_status?: 'idle' | 'pending' | 'processing' | 'done' | 'failed' | 'conflict'
  organize_error?: string | null
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
  activity_id: ID | null
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

/** 主进程连通性测试结果 */
export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  error?: string
}

/** 发给 LLM 的消息（openai/anthropic 两种格式的公共子集） */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/* ---------- 课堂模式（M1） ---------- */

/** 本地 ASR 引擎状态（设置页/课堂页就绪检查） */
export interface AsrStatus {
  /** sherpa-onnx-node 是否已安装 */
  installed: boolean
  moduleError?: string
  modelDir: string | null
  modelReady: boolean
  missingFiles: string[]
}

export type ClassroomStartResult = { mode: 'asr' | 'manual'; message?: string }

export interface ClassroomPartialEvent {
  text: string
}

export interface ClassroomFinalEvent {
  text: string
  segment: NoteSegment
}

export interface SegmentOrganizedEvent {
  segment_id: ID
  seg_type: SegmentType
  organized_text: string
  /** true = 模型输出不可解析，organized_text 回退为原文 */
  fallback: boolean
}

/* ---------- 配置与存储 ---------- */

export interface StorageInfo {
  dataDir: string
  dbPath: string
  dbSizeBytes: number
  custom: boolean
}

/* ---------- 功能自检（诊断） ---------- */

export interface DiagAsrResult {
  /** 模型目录 test_wavs 里被识别的文件名 */
  wavFile: string
  text: string
  latencyMs: number
}

export interface DiagChatResult {
  reply: string
  model: string
  latencyMs: number
}

export interface DiagOrganizeResult {
  seg_type: SegmentType
  organized_text: string
  fallback: boolean
  model: string
  latencyMs: number
}

export interface DiagVisionResult {
  reply: string
  model: string
  latencyMs: number
}

/* 材料：原件与版本不可被重解析覆盖，笔记引用稳定块 ID。 */
export type MaterialKind = 'textbook' | 'handout' | 'slides' | 'supplement'
export type MaterialFormat = 'pdf' | 'docx' | 'pptx' | 'doc' | 'ppt'
export type ImportStatus = 'queued' | 'parsing' | 'ready' | 'failed' | 'cancelled'
export interface MaterialVersion {
  id: ID; material_id: ID; file_name: string; format: MaterialFormat; fingerprint: string
  status: ImportStatus; progress: number; error: string | null; warnings_json: string; created_at: number
  parent_version_id: ID | null; derivation: 'original' | 'ocr' | 'correction'
}
export interface OcrInput { version_id: ID; from_page: number; to_page: number }
export interface OcrCorrectionInput { version_id: ID; page: number; text: string }
export interface OcrModelsStatus { ready: boolean; files: { name: string; ready: boolean }[] }
export interface OcrPage {
  page: number; raw_text: string; corrected_text: string | null; confidence: number
  width: number; height: number; lines_json: string; model_json: string
}
export interface Material {
  id: ID; subject_id: ID | null; title: string; kind: MaterialKind; created_at: number
  current_version_id: ID | null; archived: number; version?: MaterialVersion
}
export interface MaterialInput { subject_id: ID; title?: string; kind: MaterialKind; material_id?: ID }
export interface MaterialLocator {
  kind: MaterialFormat; page?: number; slide?: number; paragraph?: number; source?: string
  bbox?: number[]; pageSize?: number[]
}
export interface ParsedBlock { text: string; heading: string; locator: MaterialLocator }
export interface MaterialBlock { id: ID; version_id: ID; ordinal: number; heading: string; text: string; locator_json: string }
export interface MaterialConversion { version_id: ID; format: 'docx' | 'pptx'; fingerprint: string; engine: string; created_at: number }
export interface OfficeConverterStatus { ready: boolean; path: string | null; version: string | null; error: string | null }
export interface MaterialDetail { material: Material; versions: MaterialVersion[]; total: number; conversions: MaterialConversion[] }
export interface MaterialAnchor extends MaterialBlock { material_id: ID; material_title: string; file_name: string; format: MaterialFormat }
export interface ClassroomPosition { note_id: ID; block: MaterialAnchor | null; updated_at: number }
export interface MaterialNoteRef { segment_id: ID; note_id: ID; title: string; raw_text: string }
export interface MaterialLocateInput { version_id: ID; unit: 'block' | 'page' | 'slide'; index: number }

/** 概念身份与教材条目分开；别名确认后参与自动关联。 */
export interface Concept {
  id: ID; subject_id: ID | null; name: string; summary: string | null
  aliases: string[]; revision: number; created_at: number
}
export interface ConceptInput { id?: ID; revision?: number; subject_id: ID | null; name: string; summary: string; aliases: string[] }
export interface ConceptMention { start: number; end: number; text: string; concept_ids: ID[]; status: 'linked' | 'ambiguous' }
export interface ConceptBacklink {
  type: 'material' | 'note'; id: ID; parent_id: ID; title: string; text: string
  field: 'text' | 'raw_text' | 'organized_text'; mention: ConceptMention
  material_id?: ID; ordinal?: number; locator_json?: string
}
export interface ConceptReferences { items: ConceptBacklink[]; next_offset: number | null; scanned: number }
export type EvidenceRole = 'source' | 'definition' | 'proof' | 'example' | 'counterexample' | 'application'
export type EvidenceSource = { kind: 'learning'; material_id: ID; version_id: ID; revision_id: ID; entry_id: ID } | { kind: 'note'; note_id: ID; segment_id: ID; field: 'raw_text' | 'organized_text' }
export interface EvidenceInput { concept_id: ID; source: EvidenceSource; expected_note_text?: string; role: EvidenceRole; memo: string }
export interface Evidence {
  id: ID; concept_id: ID; source: EvidenceSource; role: EvidenceRole; memo: string; quote: string; quote_sha256: string
  source_title: string; source_subject_id: ID | null; location: string; entry_title: string; entry_type: LearningEntryType | null
  created_at: number; source_status: 'current' | 'historical' | 'changed' | 'archived' | 'deleted'
}
export type EvidenceListInput = ({ concept_id: ID } | { source: EvidenceSource }) & { offset?: number }
export interface EvidencePage { items: Evidence[]; total: number; next_offset: number | null }
export type ConceptFromEvidenceInput = Omit<EvidenceInput, 'concept_id'> & { concept: Omit<ConceptInput, 'id' | 'revision'> }
export interface KnowledgeCandidate { name: string; summary: string; aliases: string[]; excerpt: string; role: EvidenceRole }
export interface KnowledgeSuggestInput { source: EvidenceSource; expected_note_text?: string; model_db_id: ID }
export interface KnowledgeAdoption { candidate_index: number; concept_id: ID; evidence_id: ID | null }
export interface KnowledgeSuggestion {
  id: ID; source: EvidenceSource; source_title: string; provider_name: string; model_id: string; created_at: number
  status: 'running' | 'ready' | 'failed' | 'cancelled' | 'applied' | 'dismissed'; error: string | null
}
export interface KnowledgeSuggestionDetail extends KnowledgeSuggestion {
  quote: string; quote_sha256: string; location: string; source_subject_id: ID | null
  candidates: KnowledgeCandidate[] | null; adoptions: KnowledgeAdoption[]
}
export interface KnowledgeAdoptInput {
  suggestion_id: ID; candidate_index: number; role: EvidenceRole; memo: string
  target: { kind: 'existing'; concept_id: ID; expected_revision: number } | { kind: 'new'; concept: Omit<ConceptInput, 'id' | 'revision'> }
}

export type LearningEntryType = 'section' | 'narrative' | 'definition' | 'theorem' | 'proposition' | 'lemma' | 'corollary' | 'proof' | 'example' | 'exercise' | 'solution' | 'figure' | 'table' | 'equation' | 'note'
export interface LearningSource { id: ID; ordinal: number; raw_text: string; heading: string; locator_json: string; extraction: 'native' | 'ocr' | 'manual' }
export interface LearningSourceRef { source_id: ID; text_range?: [number, number] }
export interface LearningFormula { range: [number, number]; latex: string; display: boolean }
export type LearningContentNode = { type: 'text'; text: string } | { type: 'math'; formula: LearningFormula; source_text: string }
export interface LearningEntry {
  id: ID; type: LearningEntryType; title: string; sources: LearningSourceRef[]
  parent_id?: ID | null
  formulas?: LearningFormula[]
  analysis: { method: 'extracted' | 'manual'; review_status: 'unreviewed' | 'confirmed' } | { method: 'ai'; model: string; review_status: 'unreviewed' | 'confirmed' }
}
export interface LearningRelation { from: ID; to: ID; type: 'proves' | 'solves'; review_status: 'unreviewed' | 'confirmed' }
export interface LearningState { entries: LearningEntry[]; relations: LearningRelation[] }
export interface LearningDocument {
  id: ID; version_id: ID; current_revision_id: ID; revision_id: ID; created_at: number
  sources: LearningSource[]; state: LearningState; history: { id: ID; created_at: number }[]
}
export type LearningChange = { version_id: ID; expected_revision_id: ID; entry_id: ID } & (
  { action: 'edit'; type: LearningEntryType; title: string } |
  { action: 'split'; position: number } |
  { action: 'merge' } |
  { action: 'outline'; end_entry_id: ID; parent_id: ID | null } |
  { action: 'formula'; formula: LearningFormula } |
  { action: 'formula-remove'; range: [number, number] } |
  { action: 'relate'; target_id: ID | null }
)
export interface LearningSuggestInput { version_id: ID; expected_revision_id: ID; entry_ids: ID[]; model_db_id: ID }
export type LearningSuggestionStatus = 'running' | 'ready' | 'failed' | 'cancelled' | 'applied' | 'dismissed'
export interface LearningProposal { entries: LearningEntry[]; relations: LearningRelation[] }
export interface LearningSuggestion {
  id: ID; version_id: ID; base_revision_id: ID; entry_ids: ID[]; provider_name: string; model_id: string
  status: LearningSuggestionStatus; error: string | null; created_at: number; applied_revision_id: ID | null
}
export interface LearningSuggestionDetail extends LearningSuggestion { proposal: LearningProposal | null }
