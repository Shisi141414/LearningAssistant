import { Worker } from 'node:worker_threads'
import { stat, rename, unlink, mkdtemp, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EvidenceSource, MaterialFormat, MaterialKind, OcrPage } from '@shared/types'
import type { LearningPackage, LearningPackageExportInput, LearningPackageExportResult } from '@shared/learning-package'
import type { NotePackage } from '@shared/note-package'
import { getDb } from './db'
import { externalExportTarget } from './export-target'
import { getLearningDocument } from './learning-documents'
import { listConcepts } from './concepts'
import { materialPath } from './materials'
import { managedMaterialFile } from './material-files'
import { beginWork } from './work'

let stopping = false
let active: { version: string; cancel: () => void } | undefined
type FileRef = { path: string; file: string; sha256: string }
function snapshot(input: LearningPackageExportInput): { manifest: LearningPackage; refs: FileRef[] } {
  return getDb().transaction(() => {
    const db = getDb(), document = getLearningDocument(input)
    const version = db.prepare(`SELECT v.file_name,v.format,v.fingerprint,v.derivation,m.title,m.kind,m.subject_id,s.name AS subject_name
      FROM material_versions v JOIN materials m ON m.id=v.material_id LEFT JOIN subjects s ON s.id=m.subject_id WHERE v.id=? AND v.status='ready'`).get(input.version_id) as
      { file_name: string; format: MaterialFormat; fingerprint: string; derivation: string; title: string; kind: MaterialKind; subject_id: string | null; subject_name: string | null } | undefined
    if (!document || !version) throw new Error('请选择可阅读的学习文档修订')
    const conversion = db.prepare('SELECT * FROM material_conversions WHERE version_id=?').get(input.version_id) as { format: 'docx' | 'pptx'; file_path: string; fingerprint: string; engine: string; created_at: number } | undefined
    const refs: FileRef[] = [{ path: `source/original.${version.format}`, file: materialPath(input.version_id), sha256: version.fingerprint }]
    if (conversion) refs.push({ path: `source/converted.${conversion.format}`, file: managedMaterialFile(conversion.file_path), sha256: conversion.fingerprint })
    const paths = db.prepare('SELECT id,file_path FROM learning_assets WHERE document_id=?').all(document.id) as { id: string; file_path: string }[]
    const assets = (document.assets ?? []).map(asset => {
      const path = `assets/${asset.id}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}`
      refs.push({ path, file: managedMaterialFile(paths.find(row => row.id === asset.id)!.file_path), sha256: asset.sha256 })
      return { ...asset, path, byte_length: 0 }
    })
    const evidence = (db.prepare('SELECT concept_id,source_json,role,memo,quote_sha256 FROM knowledge_evidence WHERE revision_id=? AND version_id=? ORDER BY created_at,id').all(document.revision_id, document.version_id) as
      { concept_id: string; source_json: string; role: LearningPackage['evidence'][number]['role']; memo: string; quote_sha256: string }[]).map(row => {
      const source = JSON.parse(row.source_json) as EvidenceSource
      if (source.kind !== 'learning') throw new Error('知识证据来源无效')
      return { concept_id: row.concept_id, entry_id: source.entry_id, role: row.role, memo: row.memo, quote_sha256: row.quote_sha256 }
    })
    const evidenceIds = new Set(evidence.map(row => row.concept_id))
    const concepts = listConcepts().filter(concept => !version.subject_id || !concept.subject_id || concept.subject_id === version.subject_id || evidenceIds.has(concept.id))
      .map(({ id, name, summary, aliases }) => ({ id, name, summary: summary ?? '', aliases }))
    const manifest: LearningPackage = {
      format: 'learning-assistant/document', schema_version: '0.2',
      document: { id: document.id, version_id: document.version_id, revision_id: document.revision_id, title: version.title, kind: version.kind, created_at: document.created_at, subject_name: version.subject_name },
      original: { path: refs[0].path, sha256: version.fingerprint, byte_length: 0, format: version.format, file_name: version.file_name, derivation: version.derivation === 'original' ? 'native' : version.derivation as 'ocr' | 'correction' },
      conversion: conversion ? { format: conversion.format, path: refs[1].path, sha256: conversion.fingerprint, byte_length: 0, engine: conversion.engine, created_at: conversion.created_at } : null,
      sources: document.sources, state: document.state, assets, asset_extraction: document.asset_extraction ?? null,
      ocr_pages: db.prepare('SELECT page,raw_text,corrected_text,confidence,width,height,lines_json,model_json FROM material_ocr_pages WHERE version_id=? ORDER BY page').all(document.version_id) as OcrPage[], concepts, evidence
    }
    return { manifest, refs }
  })()
}
/** 仅主进程可指定输出；新临时文件完成后替换，失败不触碰既有目标。 */
export async function exportLearningPackage(input: LearningPackageExportInput, output: string): Promise<LearningPackageExportResult> {
  return exportPreparedPackage(input.version_id, output, async () => {
    const { manifest, refs } = snapshot(input)
    const lengths = await Promise.all(refs.map(async ref => { const info = await stat(ref.file); if (!info.isFile()) throw new Error('附件不是普通文件'); return info.size }))
    manifest.original.byte_length = lengths[0]
    if (manifest.conversion) manifest.conversion.byte_length = lengths[1]
    for (const asset of manifest.assets) asset.byte_length = lengths[refs.findIndex(ref => ref.path === asset.path)]
    return { action: 'write', manifest, files: refs.map(ref => [ref.path, ref.file]), selectRelatedConcepts: true }
  })
}
export async function exportPreparedPackage(key: string, output: string, prepare: () => Promise<{ action: 'write' | 'note-write'; manifest: LearningPackage | NotePackage; files: [string, string][]; selectRelatedConcepts: boolean }>): Promise<LearningPackageExportResult> {
  if (stopping) throw new Error('应用正在退出')
  if (active) throw new Error('已有文档正在导出，请等待完成或取消')
  const release = beginWork('学习文档包导出')
  let cancelled = false, worker: Worker | undefined, temporary: string | undefined, temporaryDirectory: string | undefined
  const job = { version: key, cancel: () => { cancelled = true; void worker?.terminate() } }
  active = job
  const check = (): void => { if (cancelled || stopping) throw new Error('文档导出已取消，已有文件保留') }
  try {
    const { directory, target } = await externalExportTarget(output, '.ladoc')
    check()
    const prepared = await prepare(), { manifest } = prepared
    check(); temporaryDirectory = await mkdtemp(join(directory, '.ladoc-export-')); temporary = join(temporaryDirectory, 'document.ladoc')
    check()
    worker = new Worker(join(__dirname, 'learning-package-worker.js'), { workerData: { ...prepared, output: temporary }, resourceLimits: { maxOldGenerationSizeMb: 512 } })
    const result = await new Promise<{ sha256: string; byte_length: number }>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: { sha256: string; byte_length: number }): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(result!) }
      const timer = setTimeout(() => { job.cancel(); finish(new Error('文档导出超过两分钟，请拆分材料后重试')) }, 120_000)
      worker!.on('message', message => { if (message.type === 'done') finish(undefined, message.result); else if (message.type === 'error') finish(new Error(message.error)) })
      worker!.on('error', error => finish(error instanceof Error ? error : new Error(String(error))))
      worker!.on('exit', code => finish(new Error(cancelled ? '文档导出已取消，已有文件保留' : `文档导出线程退出（${code}）`)))
    })
    check(); await rename(temporary, target)
    return { file_name: basename(target), ...result, revision_id: manifest.document.revision_id }
  } finally {
    await worker?.terminate().catch(() => undefined)
    if (temporary) await unlink(temporary).catch(() => undefined)
    if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => undefined)
    if (active === job) active = undefined
    release()
  }
}
export function cancelLearningPackageExport(version: string): boolean { if (active?.version !== version) return false; active.cancel(); return true }
export function stopLearningPackageExports(): void { stopping = true; active?.cancel() }
