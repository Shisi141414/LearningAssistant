import type { Evidence, EvidenceRole, EvidenceSource } from './types'

export const evidenceRoles: Record<EvidenceRole, string> = { source: '来源', definition: '定义', proof: '证明', example: '例题', counterexample: '反例', application: '应用' }
export const evidenceStatuses: Record<Evidence['source_status'], string> = { current: '来源当前可用', historical: '引用时的历史修订', changed: '笔记已变化 · 保留引用时文字', archived: '材料已归档 · 仍保留证据', deleted: '笔记来源已删除 · 保留引用时文字' }
/** 显式字段顺序保证同一来源无论对象序列化顺序如何都能去重。 */
export function evidenceLookup(source: EvidenceSource): string {
  return JSON.stringify(source.kind === 'learning' ? ['learning', source.material_id, source.version_id, source.revision_id, source.entry_id] : ['note', source.note_id, source.segment_id, source.field])
}
export function evidenceHref(evidence: Evidence): string | null {
  const source = evidence.source
  if (evidence.source_status === 'deleted') return null
  return source.kind === 'learning'
    ? `/library?material=${encodeURIComponent(source.material_id)}&version=${encodeURIComponent(source.version_id)}&revision=${encodeURIComponent(source.revision_id)}&entry=${encodeURIComponent(source.entry_id)}`
    : `/notes/${encodeURIComponent(source.note_id)}?segment=${encodeURIComponent(source.segment_id)}&view=${source.field === 'raw_text' ? 'raw' : 'organized'}`
}
