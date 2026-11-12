import type { LearningSource, MaterialAnchor, NoteLearningOrigin } from '@shared/types'
import type { NotePackage, NotePackageReceipt } from '@shared/note-package'
import { getDb } from './db'

export interface NoteImportMapping { segments: Record<string, string>; sources: Record<string, string>; entries: Record<string, string>; concepts: Record<string, string> }
type Row = { manifest_json: string; mapping_json: string; package_sha256: string; include_concepts: number }
function receipt(documentId: string): (Row & { manifest: NotePackage; mapping: NoteImportMapping }) | undefined {
  const row = getDb().prepare('SELECT * FROM note_package_imports WHERE document_id=?').get(documentId) as Row | undefined
  return row ? { ...row, manifest: JSON.parse(row.manifest_json), mapping: JSON.parse(row.mapping_json) } : undefined
}
/** 按持久化段落映射查找，不拿外部来源 ID 与本机表进行连接。旧修订/已删段落仍能溯源。 */
export function externalNoteMaterials(documentId: string, sources: LearningSource[], origins: Record<string, NoteLearningOrigin>): Record<string, MaterialAnchor> | undefined {
  const row = receipt(documentId)
  if (!row) return undefined
  const bySegment = new Map(Object.values(row.manifest.origins).filter(origin => origin.material_ref).map(origin => [row.mapping.segments[origin.segment_id], origin.material_ref!]))
  return Object.fromEntries(sources.flatMap(source => { const anchor = bySegment.get(origins[source.id].segment_id); return anchor ? [[source.id, anchor]] : [] }))
}
export function notePackageReceipt(noteId: string): NotePackageReceipt | null {
  const doc = getDb().prepare('SELECT id FROM note_learning_documents WHERE note_id=?').get(noteId) as { id: string } | undefined
  if (!doc) return null
  const row = receipt(doc.id)
  if (!row) return null
  const names = new Map(row.manifest.concepts.map(concept => [concept.id, concept.name]))
  return { title: row.manifest.document.title, revision_id: row.manifest.document.revision_id, sha256: row.package_sha256, include_concepts: !!row.include_concepts,
    annotations: row.manifest.annotations.filter(item => !item.matches_revision),
    evidence: row.include_concepts ? row.manifest.evidence.filter(item => !item.matches_revision).map(item => ({ ...item, concept_name: names.get(item.concept_id)! })) : [] }
}
