import type { NoteLearningBlock, NoteSegment, LearningEntryType } from './types'
import { validateLearningState } from './learning-document'

/** 原文与整理稿互不回填；空整理稿也是用户保存的有效内容。 */
export function noteLearningBlock(segment: NoteSegment, newId: () => string): NoteLearningBlock {
  const source = { id: newId(), ordinal: 0, raw_text: segment.organized_text, heading: segment.learning_heading ?? '', extraction: 'native' as const,
    locator_json: JSON.stringify({ kind: 'note', note_id: segment.note_id, segment_id: segment.id, segment_revision: segment.revision ?? 0, field: 'organized_text', recorded_at: segment.created_at }) }
  const method = segment.organized_by === 'user' ? { method: 'manual' as const, review_status: 'confirmed' as const }
    : segment.organized_by === 'ai' && segment.organized_model ? { method: 'ai' as const, model: segment.organized_model, review_status: 'unreviewed' as const }
      : { method: 'extracted' as const, review_status: 'unreviewed' as const }
  const block: NoteLearningBlock = { source, state: { entries: [{ id: newId(), type: segment.seg_type === 'other' ? 'narrative' : segment.seg_type as LearningEntryType, title: '', sources: [{ source_id: source.id }], analysis: method }], relations: [] },
    origin: { segment_id: segment.id, segment_revision: segment.revision ?? 0, raw_text: segment.raw_text, organized_by: segment.organized_by ?? 'initial', model: segment.organized_model ?? null,
      recorded_at: segment.created_at, updated_at: segment.updated_at, material_ref: segment.material_ref ?? null } }
  validateLearningState(block.state, [source])
  return block
}
