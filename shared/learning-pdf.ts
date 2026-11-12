import type { LearningAsset, LearningSource, LearningState, NoteLearningOrigin } from './types'

export type LearningPdfSource = { kind: 'material'; version_id: string; revision_id: string } | { kind: 'note'; note_id: string; revision_id: string }
export interface LearningPdfInput { source: LearningPdfSource; landscape: boolean; include_original_text: boolean }
export interface LearningPdfDocument {
  title: string; subject_name: string | null; source_name: string; revision_id: string; revision_number: number; saved_at: number
  sources: LearningSource[]; state: LearningState; assets: LearningAsset[]; origins: Record<string, NoteLearningOrigin>
  landscape: boolean; include_original_text: boolean
}
export interface LearningPdfReport { entry_count: number; image_count: number; scaled_formulas: number; empty_sources: number }
export interface LearningPdfResult extends LearningPdfReport { file_name: string; byte_length: number; revision_id: string }
export function learningPdfSourceLabel(source: LearningSource): string {
  try {
    const locator = JSON.parse(source.locator_json) as { page?: number; slide?: number; paragraph?: number; kind?: string }
    return locator.page ? `PDF 第 ${locator.page} 页` : locator.slide ? `幻灯片 ${locator.slide}` : `第 ${source.ordinal + 1} 段`
  } catch { return `来源 ${source.ordinal + 1}` }
}
