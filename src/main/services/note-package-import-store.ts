import { nanoid } from 'nanoid'
import type { LearningState, SegmentType } from '@shared/types'
import type { NotePackage, NotePackageImportResult } from '@shared/note-package'
import type { DecodedDocumentArchive } from './learning-package-codec'
import { getDb } from './db'
import { getNoteLearning, publishNoteLearningState } from './note-learning'
import { insertConcepts } from './learning-package-import-store'
import { evidenceLookup } from '@shared/evidence'
import type { NoteImportMapping } from './note-package-receipts'

/** 只接受主进程保留的已校验清单。无外部文件安装，全部登记使用同一 SQLite 事务。 */
export function installNotePackage(decoded: DecodedDocumentArchive<NotePackage>, subject: string, includeConcepts: boolean, aborted = () => false): NotePackageImportResult {
  return getDb().transaction(() => {
    const db = getDb(), manifest = decoded.manifest
    if (aborted()) throw new Error('笔记文档包导入已取消')
    if (!db.prepare('SELECT id FROM subjects WHERE id=?').get(subject)) throw new Error('请选择已有目标学科')
    const old = db.prepare('SELECT note_id,include_concepts FROM note_package_imports WHERE package_sha256=? AND subject_id=?').get(decoded.sha256, subject) as { note_id: string | null; include_concepts: number } | undefined
    if (old) {
      if (!old.note_id) throw new Error('此学科中先前导入的笔记已删除；原始出处仍保留，请选择其他学科导入独立副本')
      const doc = getNoteLearning({ note_id: old.note_id })
      return { note_id: old.note_id, revision_id: doc.revision_id, created: false, concepts_created: 0, concepts_reused: 0, concept_conflicts: 0, include_concepts: !!old.include_concepts }
    }
    const noteId = nanoid(), now = Date.now(), mapping: NoteImportMapping = { segments: {}, sources: {}, entries: {}, concepts: {} }
    db.prepare('INSERT INTO notes(id,subject_id,title,source,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(noteId, subject, manifest.document.title, 'import', manifest.document.created_at, now)
    const insert = db.prepare(`INSERT INTO note_segments(id,note_id,sort_order,seg_type,raw_text,organized_text,image_path,created_at,updated_at,revision,organized_by,organized_model,organize_status,learning_heading) VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,'idle',?)`)
    const firstType = new Map<string, string>(), ordinals = new Map(manifest.sources.map(source => [source.id, source.ordinal]))
    for (const entry of manifest.state.entries) for (const ref of entry.sources) if (!firstType.has(ref.source_id)) firstType.set(ref.source_id, entry.type)
    for (const source of manifest.sources) {
      const origin = manifest.origins[source.id], id = nanoid(); mapping.segments[origin.segment_id] = id
      const kind = firstType.get(source.id)
      const segType: SegmentType = kind && ['definition','proposition','example','proof','solution','note'].includes(kind) ? kind as SegmentType : 'other'
      insert.run(id, noteId, source.ordinal, segType, origin.raw_text, source.raw_text, origin.recorded_at, origin.updated_at, origin.segment_revision, origin.organized_by, origin.model, source.heading)
    }
    // 让既有捕获器生成来源与指纹；避免导入后第一次读取把外来快照误判成新课堂内容。
    const base = getNoteLearning({ note_id: noteId })
    for (const source of manifest.sources) mapping.sources[source.id] = base.sources[source.ordinal].id
    for (const entry of manifest.state.entries) mapping.entries[entry.id] = nanoid()
    const state: LearningState = { entries: structuredClone(manifest.state.entries).map(entry => ({ ...entry, id: mapping.entries[entry.id],
      ...(entry.parent_id ? { parent_id: mapping.entries[entry.parent_id] } : {}), sources: entry.sources.map(ref => ({ ...ref, source_id: mapping.sources[ref.source_id] })) })),
      relations: manifest.state.relations.map(relation => ({ ...relation, from: mapping.entries[relation.from], to: mapping.entries[relation.to] })) }
    const doc = publishNoteLearningState(noteId, base.revision_id, state)
    const annotation = db.prepare('INSERT INTO annotations(id,segment_id,kind,anchor_json,comment,created_at) VALUES (?,?,?,?,?,?)')
    for (const item of manifest.annotations.filter(item => item.matches_revision)) annotation.run(nanoid(), mapping.segments[manifest.origins[item.source_id].segment_id], item.kind, item.anchor_json, item.comment, item.created_at)
    const concepts = includeConcepts ? insertConcepts(manifest, subject) : { map: new Map<string, string>(), created: 0, reused: 0, conflicts: 0 }
    mapping.concepts = Object.fromEntries(concepts.map)
    const evidence = db.prepare(`INSERT INTO knowledge_evidence(id,concept_id,note_segment_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,source_subject_id,location,entry_title,entry_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    if (includeConcepts) for (const item of manifest.evidence.filter(item => item.matches_revision)) {
      const concept = concepts.map.get(item.concept_id)!, segmentId = mapping.segments[manifest.origins[item.source_id].segment_id]
      if ((db.prepare('SELECT count(*) AS n FROM knowledge_evidence WHERE concept_id=?').get(concept) as { n: number }).n >= 100) throw new Error('每个知识点最多保留 100 个证据，请整理知识库或不携带相关概念')
      const source = { kind: 'note' as const, note_id: noteId, segment_id: segmentId, field: item.field }, lookup = evidenceLookup(source)
      evidence.run(nanoid(), concept, segmentId, JSON.stringify(source), lookup, `${lookup}:${item.quote_sha256}`, item.role, item.memo, item.quote, item.quote_sha256, manifest.document.title, subject, `导入笔记段落 ${ordinals.get(item.source_id)! + 1}`, '', null, item.created_at)
    }
    if (aborted()) throw new Error('笔记文档包导入已取消')
    db.prepare(`INSERT INTO note_package_imports(id,package_sha256,subject_id,note_id,document_id,include_concepts,manifest_json,mapping_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(nanoid(), decoded.sha256, subject, noteId, doc.id, +includeConcepts, JSON.stringify(manifest), JSON.stringify(mapping), now)
    return { note_id: noteId, revision_id: doc.revision_id, created: true, concepts_created: concepts.created, concepts_reused: concepts.reused, concept_conflicts: concepts.conflicts, include_concepts: includeConcepts }
  })()
}
