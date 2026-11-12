import { mkdir, copyFile, chmod, unlink, rmdir, lstat, realpath, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { nanoid } from 'nanoid'
import type { LearningPackage, LearningPackageImportResult } from '@shared/learning-package'
import type { ParsedBlock, Concept, EvidenceSource } from '@shared/types'
import { remapLearningPackage } from '@shared/learning-package-remap'
import { entryText } from '@shared/learning-document'
import { conceptKey } from '@shared/concept-matcher'
import { evidenceLookup } from '@shared/evidence'
import { getDb, dbFilePath } from './db'
import { listConcepts } from './concepts'
import type { DecodedLearningPackage } from './learning-package-codec'

type Journal = { id: string; status: string; planned_version_id: string; directory_created: number; inventory_json: string; result_json: string | null; owner_pid: number }
export function existingLearningPackage(sha: string, subject: string): LearningPackageImportResult | null {
  const row = getDb().prepare('SELECT * FROM learning_package_imports WHERE package_sha256=? AND subject_id=?').get(sha, subject) as Journal | undefined
  if (!row) return null
  if (row.status !== 'ready' || !row.result_json) throw new Error('同一文档包仍在导入，或上次中断文件尚未清理，请稍后重试')
  const result = JSON.parse(row.result_json) as LearningPackageImportResult
  const current = getDb().prepare('SELECT current_revision_id FROM learning_documents WHERE version_id=?').get(result.version_id) as { current_revision_id: string } | undefined
  if (!current) throw new Error('已导入副本缺少学习修订，请检查数据后重试')
  return { ...result, revision_id: current.current_revision_id, created: false }
}
/** 仅清理日志登记、本批独占目录中的已知文件；未知文件保留，不递归删除。 */
async function cleanupJournal(row: Journal): Promise<void> {
  if (!/^[A-Za-z0-9_-]{21}$/.test(row.planned_version_id) || row.status !== 'staging' || getDb().prepare('SELECT id FROM material_versions WHERE id=?').get(row.planned_version_id)) throw new Error('导入恢复记录无效，保留文件待检查')
  const inventory: unknown = JSON.parse(row.inventory_json)
  if (!Array.isArray(inventory) || inventory.length > 102 || !inventory.every(name => typeof name === 'string' && /^(source\.(pdf|docx|pptx|doc|ppt)|converted\.(docx|pptx)|asset-[A-Za-z0-9_-]{21}\.(png|jpg))$/.test(name))) throw new Error('导入恢复文件清单无效')
  if (row.directory_created) {
    const root = await realpath(join(dirname(dbFilePath()), 'materials')), directory = join(root, row.planned_version_id)
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (info) {
      const rel = relative(root, await realpath(directory))
      if (!info.isDirectory() || info.isSymbolicLink() || !rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('导入恢复目录越界，保留文件待检查')
      for (const name of inventory) {
        const file = join(directory, name)
        // unlink 链接本身，绝不跟随链接改变其他文件权限。
        const item = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
        if (!item) continue
        if (!item.isFile() && !item.isSymbolicLink()) throw new Error('登记附件变为其他类型，保留文件待检查')
        if (!item.isSymbolicLink()) await chmod(file, 0o644)
        await unlink(file)
      }
      await rmdir(directory)
    }
  }
  getDb().prepare("DELETE FROM learning_package_imports WHERE id=? AND status='staging'").run(row.id)
}
export async function recoverLearningPackageImports(): Promise<void> {
  const rows = getDb().prepare("SELECT * FROM learning_package_imports WHERE status='staging'").all() as Journal[]
  for (const row of rows) {
    if (row.owner_pid > 0) { try { process.kill(row.owner_pid, 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue } }
    try { await cleanupJournal(row) } catch (error) { console.error('保留未清理的学习文档包导入记录', row.id, error) }
  }
}
function conceptSignature(concept: Pick<Concept, 'name' | 'summary' | 'aliases'>): string {
  return JSON.stringify([conceptKey(concept.name), concept.summary ?? '', concept.aliases.map(conceptKey).sort()])
}
function insertConcepts(manifest: LearningPackage, subject: string) {
  const db = getDb(), existing = listConcepts(), applicable = existing.filter(concept => !concept.subject_id || concept.subject_id === subject)
  const bySignature = new Map<string, Concept[]>(), names = new Set(applicable.flatMap(concept => [concept.name, ...concept.aliases].map(conceptKey)))
  for (const concept of applicable) { const key = conceptSignature(concept); if (!bySignature.has(key)) bySignature.set(key, []); bySignature.get(key)!.push(concept) }
  const used = new Set<string>(), map = new Map<string, string>(); let created = 0, reused = 0, conflicts = 0
  let dictionarySize = existing.reduce((n, concept) => n + concept.name.length + concept.aliases.reduce((m, name) => m + name.length, 0), 0)
  const insert = db.prepare('INSERT INTO knowledge_points(id,subject_id,name,summary,created_at) VALUES (?,?,?,?,?)'), alias = db.prepare('INSERT INTO concept_aliases(concept_id,name,normalized) VALUES (?,?,?)')
  for (const concept of manifest.concepts) {
    const old = bySignature.get(conceptSignature(concept))?.find(row => !used.has(row.id))
    if (old) { used.add(old.id); map.set(concept.id, old.id); reused++; continue }
    if ([concept.name, ...concept.aliases].some(name => names.has(conceptKey(name)))) conflicts++
    dictionarySize += concept.name.length + concept.aliases.reduce((n, name) => n + name.length, 0)
    if (existing.length + created >= 2000 || dictionarySize > 100_000) throw new Error('携带概念后超过词典容量，请整理知识库或不携带相关概念')
    const id = nanoid(); map.set(concept.id, id); created++
    insert.run(id, subject, concept.name, concept.summary, Date.now())
    for (const name of concept.aliases) alias.run(id, name, conceptKey(name))
    for (const name of [concept.name, ...concept.aliases]) names.add(conceptKey(name))
  }
  return { map, created, reused, conflicts }
}
/** decoded 与 blocks 必须来自校验工作线程；主进程仅登记，不从渲染进程接受这些内容。 */
export async function installLearningPackage(decoded: DecodedLearningPackage, blocks: ParsedBlock[], subject: string, includeConcepts: boolean, verify: (manifest: LearningPackage, files: [string, string][]) => Promise<void>, aborted: () => boolean = () => false): Promise<LearningPackageImportResult> {
  const check = (): void => { if (aborted()) throw new Error('文档包导入已取消') }
  check()
  const db = getDb(), duplicate = existingLearningPackage(decoded.sha256, subject)
  if (duplicate) return duplicate
  if (!db.prepare('SELECT id FROM subjects WHERE id=?').get(subject)) throw new Error('请选择已有目标学科')
  if (!blocks.length || blocks.length > 50_000) throw new Error('导入检索块数量超出限制')
  const manifest = decoded.manifest, remap = remapLearningPackage(manifest, nanoid), material = nanoid(), version = nanoid(), document = nanoid(), revision = nanoid(), attempt = nanoid(), now = Date.now()
  const root = join(dirname(dbFilePath()), 'materials'), directory = join(root, version)
  const names = new Map<string, string>([[manifest.original.path, `source.${manifest.original.format}`]])
  if (manifest.conversion) names.set(manifest.conversion.path, `converted.${manifest.conversion.format}`)
  for (const asset of manifest.assets) names.set(asset.path, `asset-${remap.assets.get(asset.id)}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}`)
  db.prepare(`INSERT INTO learning_package_imports(id,package_sha256,subject_id,status,planned_version_id,inventory_json,origin_document_id,origin_version_id,origin_revision_id,include_concepts,created_at,owner_pid)
    VALUES (?,?,?,'staging',?,?,?,?,?,?,?,?)`).run(attempt, decoded.sha256, subject, version, JSON.stringify([...names.values()]), manifest.document.id, manifest.document.version_id, manifest.document.revision_id, +includeConcepts, now, process.pid)
  let published = false, ownedDirectory = false
  try {
    await mkdir(root, { recursive: true }); check(); await mkdir(directory); ownedDirectory = true
    db.prepare('UPDATE learning_package_imports SET directory_created=1 WHERE id=?').run(attempt)
    const files: [string, string][] = []
    for (const [path, name] of names) {
      check(); const source = decoded.files.find(row => row.path === path)
      if (!source) throw new Error('缺少已校验的导入附件')
      const file = join(directory, name); await copyFile(source.file, file, constants.COPYFILE_EXCL); files.push([path, file])
    }
    await verify(manifest, files); check()
    for (const [, file] of files) {
      check(); const handle = await open(file, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await chmod(file, 0o444)
    }
    check()
    const result = db.transaction(() => {
      if (!db.prepare('SELECT id FROM subjects WHERE id=?').get(subject)) throw new Error('目标学科已删除，请重新选择')
      const relativeFile = (path: string): string => join('materials', version, names.get(path)!)
      db.prepare('INSERT INTO materials(id,subject_id,title,kind,created_at) VALUES (?,?,?,?,?)').run(material, subject, manifest.document.title, manifest.document.kind, now)
      db.prepare(`INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,progress,warnings_json,created_at,derivation) VALUES (?,?,?,?,?,?,'ready',100,'[]',?,?)`).run(version, material, manifest.original.file_name, relativeFile(manifest.original.path), manifest.original.format, manifest.original.sha256, now, manifest.original.derivation === 'native' ? 'original' : manifest.original.derivation)
      db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
      if (manifest.conversion) { const c = manifest.conversion; db.prepare('INSERT INTO material_conversions(version_id,format,file_path,fingerprint,engine,created_at) VALUES (?,?,?,?,?,?)').run(version, c.format, relativeFile(c.path), c.sha256, c.engine, c.created_at) }
      db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,?)').run(document, version, now)
      const insertSource = db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)')
      for (const source of remap.units) insertSource.run(source.id, document, source.ordinal, source.raw_text, source.heading, source.locator_json, source.extraction)
      db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,?)').run(revision, document, JSON.stringify(remap.state), now)
      db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
      const insertAsset = db.prepare('INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const a of manifest.assets) insertAsset.run(remap.assets.get(a.id), document, a.mime_type, a.sha256, relativeFile(a.path), a.width, a.height, a.locator_json, a.alt_text, now)
      if (manifest.asset_extraction) { const e = manifest.asset_extraction; db.prepare('INSERT INTO learning_asset_extractions(document_id,engine,warnings_json,created_at) VALUES (?,?,?,?)').run(document, e.engine, JSON.stringify(e.warnings), e.created_at) }
      const insertPage = db.prepare('INSERT INTO material_ocr_pages(version_id,page,raw_text,corrected_text,confidence,width,height,lines_json,model_json) VALUES (?,?,?,?,?,?,?,?,?)')
      for (const p of manifest.ocr_pages) insertPage.run(version, p.page, p.raw_text, p.corrected_text, p.confidence, p.width, p.height, p.lines_json, p.model_json)
      const insertBlock = db.prepare('INSERT INTO material_blocks(id,version_id,ordinal,text,heading,locator_json) VALUES (?,?,?,?,?,?)')
      blocks.forEach((block, ordinal) => insertBlock.run(nanoid(), version, ordinal, block.text, block.heading, JSON.stringify(block.locator)))
      const concepts = includeConcepts ? insertConcepts(manifest, subject) : { map: new Map<string, string>(), created: 0, reused: 0, conflicts: 0 }
      const sources = new Map(remap.units.map(source => [source.id, source])), entries = new Map(remap.state.entries.map(entry => [entry.id, entry]))
      const insertEvidence = db.prepare(`INSERT INTO knowledge_evidence(id,concept_id,version_id,revision_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,source_subject_id,location,entry_title,entry_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      const evidenceCounts = new Map<string, number>()
      for (const e of includeConcepts ? manifest.evidence : []) {
        const concept = concepts.map.get(e.concept_id)!, entry = entries.get(remap.entries.get(e.entry_id)!)!
        const count = evidenceCounts.get(concept) ?? (db.prepare('SELECT count(*) AS n FROM knowledge_evidence WHERE concept_id=?').get(concept) as { n: number }).n
        if (count >= 100) throw new Error('某个概念的证据已达 100 条，请整理后再导入，或不携带概念')
        evidenceCounts.set(concept, count + 1)
        const source: EvidenceSource = { kind: 'learning', material_id: material, version_id: version, revision_id: revision, entry_id: entry.id }, lookup = evidenceLookup(source)
        const labels = [...new Set(entry.sources.map(ref => { const locator = JSON.parse(sources.get(ref.source_id)!.locator_json); return locator.page ? `PDF 第 ${locator.page} 页` : locator.slide ? `幻灯片 ${locator.slide}` : `来源段落 ${sources.get(ref.source_id)!.ordinal + 1}` }))]
        insertEvidence.run(nanoid(), concept, version, revision, JSON.stringify(source), lookup, lookup, e.role, e.memo, entryText(entry, sources), e.quote_sha256, manifest.document.title, subject, `修订 1 · ${labels.slice(0, 4).join('、')}${labels.length > 4 ? '…' : ''}`, entry.title, entry.type, now)
      }
      const result: LearningPackageImportResult = { material_id: material, version_id: version, revision_id: revision, created: true, concepts_created: concepts.created, concepts_reused: concepts.reused, concept_conflicts: concepts.conflicts, include_concepts: includeConcepts }
      const ids = { sources: Object.fromEntries(remap.sources), entries: Object.fromEntries(remap.entries), assets: Object.fromEntries(remap.assets), concepts: Object.fromEntries(concepts.map) }
      db.prepare("UPDATE learning_package_imports SET status='ready',material_id=?,version_id=?,revision_id=?,id_map_json=?,result_json=? WHERE id=? AND status='staging'").run(material, version, revision, JSON.stringify(ids), JSON.stringify(result), attempt)
      return result
    })()
    published = true; return result
  } finally {
    if (!published) {
      const row = db.prepare('SELECT * FROM learning_package_imports WHERE id=?').get(attempt) as Journal
      // mkdir 成功后、日志更新前失败时，仍只清理本人已创建的空目录。
      if (ownedDirectory && !row.directory_created) await rmdir(directory).catch(() => undefined)
      await cleanupJournal(row)
    }
  }
}
