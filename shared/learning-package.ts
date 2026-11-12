import type { LearningAsset, LearningAssetExtraction, LearningSource, LearningState, MaterialFormat, MaterialKind, OcrPage, EvidenceRole } from './types'

export interface LearningPackageFile { path: string; sha256: string; byte_length: number }
export interface LearningPackageExportInput { version_id: string; revision_id: string }
export interface LearningPackageExportResult { file_name: string; sha256: string; byte_length: number; revision_id: string }
export interface LearningPackagePreview { ticket: string; title: string; file_name: string; format: MaterialFormat; kind: MaterialKind; subject_name: string | null; sources: number; entries: number; assets: number; concepts: number; evidence: number; sha256: string }
export interface LearningPackageImportInput { ticket: string; subject_id: string; include_concepts: boolean }
export interface LearningPackageImportResult { material_id: string; version_id: string; revision_id: string; created: boolean; concepts_created: number; concepts_reused: number; concept_conflicts: number; include_concepts: boolean }
/** 标准 ZIP 中 document.json 的公开固定修订快照；不是整个应用数据库备份。 */
export interface LearningPackage {
  format: 'learning-assistant/document'
  schema_version: '0.2'
  document: { id: string; version_id: string; revision_id: string; title: string; kind: MaterialKind; created_at: number; subject_name: string | null }
  original: LearningPackageFile & { format: MaterialFormat; file_name: string; derivation: 'native' | 'ocr' | 'correction' }
  conversion: (LearningPackageFile & { format: 'docx' | 'pptx'; engine: string; created_at: number }) | null
  sources: LearningSource[]
  state: LearningState
  assets: (LearningAsset & LearningPackageFile)[]
  asset_extraction: LearningAssetExtraction | null
  ocr_pages: OcrPage[]
  concepts: { id: string; name: string; summary: string; aliases: string[] }[]
  evidence: { concept_id: string; entry_id: string; role: EvidenceRole; memo: string; quote_sha256: string }[]
}
export const learningPackageLimits = { archiveBytes: 192 * 1024 * 1024, unpackedBytes: 176 * 1024 * 1024, manifestBytes: 16 * 1024 * 1024, fileBytes: 50 * 1024 * 1024, assetBytes: 8 * 1024 * 1024, assetsBytes: 50 * 1024 * 1024, entries: 103 } as const
export function learningPackageFiles(document: LearningPackage): LearningPackageFile[] {
  return [document.original, ...(document.conversion ? [document.conversion] : []), ...document.assets]
}
