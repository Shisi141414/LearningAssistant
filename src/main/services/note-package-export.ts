import { createHash } from 'node:crypto'
import type { Annotation, Evidence, EvidenceSource } from '@shared/types'
import type { NotePackage, NotePackageExportInput, NotePackageExportResult } from '@shared/note-package'
import { getDb } from './db'
import { getNoteLearning } from './note-learning'
import { listConcepts } from './concepts'
import { exportPreparedPackage, cancelLearningPackageExport } from './learning-package-export'

/** 只读所选修订；不自动同步最新转写或把最新段落混入旧修订。 */
export function notePackageSnapshot(input: NotePackageExportInput): NotePackage {
  return getDb().transaction((): NotePackage => {
    const db = getDb(), doc = getNoteLearning({ note_id: input.note_id, revision_id: input.revision_id })
    if (!doc.sources.length) throw new Error('空笔记没有可导出的来源，请先添加记录')
    const sourceIds = new Map(Object.entries(doc.origins).map(([id, origin]) => [origin.segment_id, id]))
    const annotations = (db.prepare('SELECT a.*,s.revision AS segment_revision FROM annotations a JOIN note_segments s ON s.id=a.segment_id WHERE s.note_id=? ORDER BY a.created_at,a.id').all(input.note_id) as (Annotation & { segment_revision: number })[])
      .filter(item => sourceIds.has(item.segment_id)).map(({ id, segment_id, kind, anchor_json, comment, created_at, segment_revision }) => {
        const source_id = sourceIds.get(segment_id)!
        return { id, source_id, kind, anchor_json, comment, created_at, segment_revision, matches_revision: segment_revision === doc.origins[source_id].segment_revision }
      })
    const sources = new Map(doc.sources.map(source => [source.id, source]))
    // 已删除段落的证据仍有 source_json；不能靠可空的当前段落外键筛掉历史出处。
    const evidence = (db.prepare("SELECT * FROM knowledge_evidence WHERE json_extract(source_json,'$.kind')='note' AND json_extract(source_json,'$.note_id')=? ORDER BY created_at,id").all(input.note_id) as (Evidence & { source_json: string })[])
      .map(item => ({ item, source: JSON.parse(item.source_json) as EvidenceSource }))
      .filter(({ source }) => source.kind === 'note' && sourceIds.has(source.segment_id)).map(({ item, source }) => {
        if (source.kind !== 'note' || source.note_id !== input.note_id) throw new Error('笔记知识证据来源不一致')
        const source_id = sourceIds.get(source.segment_id)!
        const quote = source.field === 'raw_text' ? doc.origins[source_id].raw_text : sources.get(source_id)!.raw_text
        return { concept_id: item.concept_id, source_id, field: source.field, quote: item.quote, quote_sha256: item.quote_sha256, role: item.role, memo: item.memo, created_at: item.created_at, matches_revision: createHash('sha256').update(quote).digest('hex') === item.quote_sha256 }
      })
    const evidenceIds = new Set(evidence.map(item => item.concept_id))
    const concepts = listConcepts().filter(concept => !doc.subject_id || !concept.subject_id || concept.subject_id === doc.subject_id || evidenceIds.has(concept.id)).map(({ id, name, summary, aliases }) => ({ id, name, summary: summary ?? '', aliases }))
    const subject = doc.subject_id ? db.prepare('SELECT name FROM subjects WHERE id=?').get(doc.subject_id) as { name: string } | undefined : undefined
    return { format: 'learning-assistant/note', schema_version: '0.1', document: { id: doc.id, note_id: doc.note_id, revision_id: doc.revision_id, title: doc.title, created_at: doc.created_at, subject_name: subject?.name ?? null }, exported_at: Date.now(), sources: doc.sources, state: doc.state, origins: doc.origins, assets: [], annotations, concepts, evidence }
  })()
}
export async function exportNotePackage(input: NotePackageExportInput, output: string): Promise<NotePackageExportResult> {
  let manifest: NotePackage | undefined
  const result = await exportPreparedPackage(`note:${input.note_id}`, output, async () => {
    manifest = notePackageSnapshot(input)
    return { action: 'note-write', manifest, files: [], selectRelatedConcepts: true }
  })
  return { ...result, sources: manifest!.sources.length, entries: manifest!.state.entries.length, annotations: manifest!.annotations.length, evidence: manifest!.evidence.length, unmatched_annotations: manifest!.annotations.filter(item => !item.matches_revision).length, unmatched_evidence: manifest!.evidence.filter(item => !item.matches_revision).length }
}
export function cancelNotePackageExport(noteId: string): boolean { return cancelLearningPackageExport(`note:${noteId}`) }
