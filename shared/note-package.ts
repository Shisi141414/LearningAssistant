import type { AnnotationKind, LearningSource, LearningState, NoteLearningOrigin, EvidenceRole } from './types'
import type { LearningPackage, LearningPackageExportResult } from './learning-package'

/** 与教材包共用 .ladoc ZIP 容器；公开契约不包含磁盘路径、密钥或整个数据库。 */
export interface NotePackage {
  format: 'learning-assistant/note'
  schema_version: '0.1'
  document: { id: string; note_id: string; revision_id: string; title: string; created_at: number; subject_name: string | null }
  exported_at: number
  sources: LearningSource[]
  state: LearningState
  origins: Record<string, NoteLearningOrigin>
  // 笔记暂未支持配图附件；空列表便于共用容器契约，不能冒充已打包录音/教材。
  assets: []
  annotations: { id: string; source_id: string; kind: AnnotationKind; anchor_json: string | null; comment: string; created_at: number; segment_revision: number; matches_revision: boolean }[]
  concepts: LearningPackage['concepts']
  evidence: { concept_id: string; source_id: string; field: 'raw_text' | 'organized_text'; quote: string; quote_sha256: string; role: EvidenceRole; memo: string; created_at: number; matches_revision: boolean }[]
}
export interface NotePackageExportInput { note_id: string; revision_id: string }
export interface NotePackageExportResult extends LearningPackageExportResult { sources: number; entries: number; annotations: number; evidence: number; unmatched_annotations: number; unmatched_evidence: number }
