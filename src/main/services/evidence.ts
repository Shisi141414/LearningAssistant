import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { Concept, ConceptFromEvidenceInput, Evidence, EvidenceInput, EvidenceListInput, EvidencePage, EvidenceSource, MaterialLocator } from '@shared/types'
import { evidenceLookup, evidenceRoles } from '@shared/evidence'
import { entryText } from '@shared/learning-document'
import { getDb } from './db'
import { getLearningDocument } from './learning-documents'
import { saveConcept } from './concepts'

interface EvidenceRow extends Omit<Evidence, 'source' | 'source_status'> {
  source_json: string; source_key: string; source_lookup: string; version_id: string | null; revision_id: string | null; note_segment_id: string | null
  archived: number | null; material_current: string | null; learning_current: string | null; note_raw: string | null; note_organized: string | null
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const select = `SELECT e.*, m.archived, m.current_version_id AS material_current, d.current_revision_id AS learning_current,
  s.raw_text AS note_raw, s.organized_text AS note_organized
  FROM knowledge_evidence e LEFT JOIN material_versions v ON v.id=e.version_id LEFT JOIN materials m ON m.id=v.material_id
  LEFT JOIN learning_documents d ON d.version_id=e.version_id LEFT JOIN note_segments s ON s.id=e.note_segment_id`
function publicEvidence(row: EvidenceRow): Evidence {
  const source = JSON.parse(row.source_json) as EvidenceSource
  const source_status = source.kind === 'learning'
    ? row.archived ? 'archived' : row.material_current !== source.version_id || row.learning_current !== source.revision_id ? 'historical' : 'current'
    : !row.note_segment_id ? 'deleted' : hash((source.field === 'raw_text' ? row.note_raw : row.note_organized) ?? '') !== row.quote_sha256 ? 'changed' : 'current'
  return { id: row.id, concept_id: row.concept_id, source, role: row.role, memo: row.memo, quote: row.quote, quote_sha256: row.quote_sha256, source_title: row.source_title, source_subject_id: row.source_subject_id, location: row.location, entry_title: row.entry_title, entry_type: row.entry_type, created_at: row.created_at, source_status }
}
export function captureEvidenceSource(input: Pick<EvidenceInput, 'source' | 'expected_note_text'>): Pick<Evidence, 'quote' | 'source_title' | 'source_subject_id' | 'location' | 'entry_title' | 'entry_type'> {
  const source = input.source, db = getDb()
  if (source.kind === 'learning') {
    if (input.expected_note_text !== undefined) throw new Error('学习条目不接受外部正文')
    const material = db.prepare("SELECT m.title, m.subject_id FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=? AND m.id=? AND v.status='ready'").get(source.version_id, source.material_id) as { title: string; subject_id: string | null } | undefined
    const document = getLearningDocument({ version_id: source.version_id, revision_id: source.revision_id })
    const entry = document?.state.entries.find(entry => entry.id === source.entry_id)
    if (!material || !document || !entry) throw new Error('引用的学习修订或条目不存在，或不属于该材料')
    const sources = new Map(document.sources.map(item => [item.id, item]))
    const labels = [...new Set(entry.sources.map(ref => {
      const unit = sources.get(ref.source_id)!, locator = JSON.parse(unit.locator_json) as MaterialLocator
      return locator.page ? `PDF 第 ${locator.page} 页` : locator.slide ? `幻灯片 ${locator.slide}` : `来源段落 ${unit.ordinal + 1}`
    }))]
    const revisionNumber = document.history.length - document.history.findIndex(item => item.id === source.revision_id)
    return { quote: entryText(entry, sources), source_title: material.title, source_subject_id: material.subject_id, location: `修订 ${revisionNumber} · ${labels.slice(0, 4).join('、')}${labels.length > 4 ? '…' : ''}`, entry_title: entry.title, entry_type: entry.type }
  }
  const segment = db.prepare('SELECT n.title, n.subject_id, s.raw_text, s.organized_text, s.sort_order FROM note_segments s JOIN notes n ON n.id=s.note_id WHERE s.id=? AND n.id=?').get(source.segment_id, source.note_id) as { title: string; subject_id: string | null; raw_text: string; organized_text: string; sort_order: number } | undefined
  if (!segment) throw new Error('引用的笔记段落不存在，或归属已改变')
  const quote = segment[source.field]
  if (input.expected_note_text === undefined || quote !== input.expected_note_text) throw new Error('笔记文字尚未保存或已有更新，请刷新并核对后引用')
  return { quote, source_title: segment.title, source_subject_id: segment.subject_id, location: `段落 ${segment.sort_order + 1} · ${source.field === 'raw_text' ? '原文' : '整理'}`, entry_title: '', entry_type: null }
}
export function addEvidence(input: EvidenceInput): { evidence: Evidence; created: boolean } {
  return getDb().transaction(() => {
    const db = getDb()
    if (!db.prepare('SELECT id FROM knowledge_points WHERE id=?').get(input.concept_id)) throw new Error('知识点不存在')
    if (!Object.hasOwn(evidenceRoles, input.role) || input.memo.length > 2000 || input.memo.includes('\0')) throw new Error('引用角色或说明无效')
    const capture = captureEvidenceSource(input)
    if (!capture.quote.trim() || capture.quote.length > 40_000) throw new Error('证据文字须非空且最多 40000 字符，请先拆分长条目')
    const lookup = evidenceLookup(input.source), fingerprint = hash(capture.quote)
    const key = input.source.kind === 'learning' ? lookup : `${lookup}:${fingerprint}`
    const old = db.prepare(select + ' WHERE e.concept_id=? AND e.source_key=?').get(input.concept_id, key) as EvidenceRow | undefined
    if (old) return { evidence: publicEvidence(old), created: false }
    if ((db.prepare('SELECT count(*) AS n FROM knowledge_evidence WHERE concept_id=?').get(input.concept_id) as { n: number }).n >= 100) throw new Error('每个知识点最多保留 100 个证据，请先整理引用')
    const source = input.source, id = nanoid()
    db.prepare(`INSERT INTO knowledge_evidence(id,concept_id,version_id,revision_id,note_segment_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,source_subject_id,location,entry_title,entry_type,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.concept_id, source.kind === 'learning' ? source.version_id : null, source.kind === 'learning' ? source.revision_id : null, source.kind === 'note' ? source.segment_id : null,
      JSON.stringify(source), lookup, key, input.role, input.memo.trim(), capture.quote, fingerprint, capture.source_title, capture.source_subject_id, capture.location, capture.entry_title, capture.entry_type, Date.now())
    return { evidence: publicEvidence(db.prepare(select + ' WHERE e.id=?').get(id) as EvidenceRow), created: true }
  })()
}
export function createConceptWithEvidence(input: ConceptFromEvidenceInput): { concept: Concept; evidence: Evidence } {
  return getDb().transaction(() => {
    const concept = saveConcept(input.concept)
    return { concept, evidence: addEvidence({ source: input.source, role: input.role, memo: input.memo, expected_note_text: input.expected_note_text, concept_id: concept.id }).evidence }
  })()
}
export function listEvidence(input: EvidenceListInput): EvidencePage {
  const db = getDb(), offset = input.offset ?? 0
  const byConcept = 'concept_id' in input
  const column = byConcept ? 'e.concept_id' : 'e.source_lookup', value = byConcept ? input.concept_id : evidenceLookup(input.source)
  const total = (db.prepare(`SELECT count(*) AS n FROM knowledge_evidence e WHERE ${column}=?`).get(value) as { n: number }).n
  const items = (db.prepare(select + ` WHERE ${column}=? ORDER BY e.created_at DESC, e.rowid DESC LIMIT 20 OFFSET ?`).all(value, offset) as EvidenceRow[]).map(publicEvidence)
  return { items, total, next_offset: offset + items.length < total ? offset + items.length : null }
}
export function removeEvidence(id: string): boolean { getDb().prepare('DELETE FROM knowledge_evidence WHERE id=?').run(id); return true }
