import { Worker } from 'node:worker_threads'
import { mkdir, mkdtemp, writeFile, chmod, unlink, rmdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { LearningAsset, LearningAssetExtraction, LearningDocument, MaterialVersion } from '@shared/types'
import type { ParsedLearningAssets } from './learning-asset-parser'
import { dbFilePath, getDb } from './db'
import { beginWork } from './work'
import { managedMaterialFile } from './material-files'
import { materialPath } from './materials'
import { materialParseInput } from './office-conversions'
import { getLearningDocument } from './learning-documents'

const engine = 'officeparser 8.7.1 / learning-images-v1'
let stopping = false
let active: { version: string; promise: Promise<LearningDocument>; cancel: () => void } | undefined
export function learningAssets(documentId: string): LearningAsset[] {
  return getDb().prepare('SELECT id,mime_type,sha256,width,height,locator_json,alt_text FROM learning_assets WHERE document_id=? ORDER BY created_at,rowid').all(documentId) as LearningAsset[]
}
export function learningAssetExtraction(documentId: string): LearningAssetExtraction | null {
  const row = getDb().prepare('SELECT engine,warnings_json,created_at FROM learning_asset_extractions WHERE document_id=?').get(documentId) as { engine: string; warnings_json: string; created_at: number } | undefined
  return row ? { engine: row.engine, warnings: JSON.parse(row.warnings_json), created_at: row.created_at } : null
}
function editableDocument(version: string): LearningDocument {
  const row = getDb().prepare('SELECT m.archived,v.status FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?').get(version) as { archived: number; status: string } | undefined
  const document = getLearningDocument({ version_id: version })
  if (!document || !row || row.archived || row.status !== 'ready') throw new Error('请先建立未归档材料的学习文档')
  return document
}
/** 全部文件落盘后才登记。文件名只用程序生成的 ID，失败清理本批已知文件。 */
export async function storeLearningAssets(version: string, result: ParsedLearningAssets, aborted: () => boolean = () => false): Promise<void> {
  const document = editableDocument(version)
  if (learningAssetExtraction(document.id)) throw new Error('已有配图提取记录，不能覆盖已保存附件')
  if (!Array.isArray(result.assets) || result.assets.length > 100 || result.assets.reduce((n, a) => n + a.bytes.byteLength, 0) > 50 * 1024 * 1024 || !Array.isArray(result.warnings)) throw new Error('图片提取结果超出限制')
  const base = dirname(dbFilePath()), directory = join(base, 'materials', 'learning-assets')
  await mkdir(directory, { recursive: true })
  const stage = await mkdtemp(join(directory, 'extract-')), files: string[] = [], rows: Array<LearningAsset & { file_path: string }> = []
  let registered = false
  try {
    for (const asset of result.assets) {
      if (aborted() || stopping) throw new Error('配图提取已取消，文档保持原样')
      if (!['image/png', 'image/jpeg'].includes(asset.mime_type) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.bytes.byteLength || asset.bytes.byteLength > 8 * 1024 * 1024 || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width < 1 || asset.height < 1 || asset.width * asset.height > 16_000_000 || asset.locator_json.length > 2000 || asset.alt_text.length > 1000) throw new Error('图片结果格式无效')
      const locator = JSON.parse(asset.locator_json)
      if (!['docx', 'pptx'].includes(locator.kind) || !/^image:\d+(\.\d+)*$/.test(locator.source) || locator.slide !== undefined && (!Number.isSafeInteger(locator.slide) || locator.slide < 1)) throw new Error('图片来源无效')
      const id = nanoid(), file = join(stage, `${id}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}`)
      files.push(file)
      await writeFile(file, asset.bytes, { flag: 'wx' }); await chmod(file, 0o444)
      rows.push({ id, file_path: relative(base, file), mime_type: asset.mime_type, sha256: asset.sha256, width: asset.width, height: asset.height, locator_json: asset.locator_json, alt_text: asset.alt_text })
    }
    if (aborted() || stopping) throw new Error('配图提取已取消，文档保持原样')
    editableDocument(version)
    getDb().transaction(() => {
      if (learningAssetExtraction(document.id)) throw new Error('配图已被其他操作保存，请刷新')
      const now = Date.now(), put = getDb().prepare('INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const row of rows) put.run(row.id, document.id, row.mime_type, row.sha256, row.file_path, row.width, row.height, row.locator_json, row.alt_text, now)
      getDb().prepare('INSERT INTO learning_asset_extractions(document_id,engine,warnings_json,created_at) VALUES (?,?,?,?)').run(document.id, engine, JSON.stringify(result.warnings.slice(0, 300).map(w => String(w).slice(0, 1000))), now)
    })()
    registered = true
  } finally {
    if (!registered) { for (const file of files) { await chmod(file, 0o644).catch(() => undefined); await unlink(file).catch(() => undefined) }; await rmdir(stage).catch(() => undefined) }
    else if (!rows.length) await rmdir(stage).catch(() => undefined)
  }
}
export function prepareLearningAssets(version: string): Promise<LearningDocument> {
  if (stopping) return Promise.reject(new Error('应用正在退出'))
  const document = editableDocument(version)
  if (learningAssetExtraction(document.id)) return Promise.resolve(document)
  if (active) return active.version === version ? active.promise : Promise.reject(new Error('已有配图提取任务，请等待或取消后再试'))
  const versionRow = getDb().prepare('SELECT * FROM material_versions WHERE id=?').get(version) as MaterialVersion
  const input = materialParseInput(version, materialPath(version), versionRow.format)
  if (input.format === 'pdf') return Promise.reject(new Error('PDF 页内配图提取尚未接入，请先对照原页'))
  const release = beginWork('学习文档配图提取')
  let worker: Worker
  try { worker = new Worker(join(__dirname, 'learning-asset-worker.js'), { workerData: { file: input.file, format: input.format, fingerprint: input.expectedFingerprint ?? versionRow.fingerprint }, resourceLimits: { maxOldGenerationSizeMb: 512 } }) }
  catch (error) { release(); return Promise.reject(error) }
  let cancelled = false, finishing = false, cancel = (): void => undefined
  const promise = new Promise<LearningDocument>((resolve, reject) => {
    const finish = async (error?: Error, result?: ParsedLearningAssets): Promise<void> => {
      if (finishing) return
      finishing = true; clearTimeout(timer); void worker.terminate()
      try {
        if (error) throw error
        if (cancelled || stopping) throw new Error('配图提取已取消，文档保持原样')
        await storeLearningAssets(version, result!, () => cancelled)
        resolve(getLearningDocument({ version_id: version })!)
      } catch (failure) { reject(failure) }
      finally { active = undefined; release() }
    }
    const timer = setTimeout(() => { cancelled = true; void finish(new Error('配图提取超过两分钟，请拆分材料后重试')) }, 120_000)
    cancel = () => { cancelled = true; void finish(new Error('配图提取已取消，文档保持原样')) }
    worker.on('message', message => { if (message.type === 'done') void finish(undefined, message); else if (message.type === 'error') void finish(new Error(message.error)) })
    worker.on('error', error => void finish(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => { if (!finishing) void finish(new Error(`图片提取线程退出（${code}）`)) })
  })
  active = { version, promise, cancel }
  return promise
}
export function cancelLearningAssets(version: string): boolean { if (active?.version !== version) return false; active.cancel(); return true }
export function stopLearningAssets(): void { stopping = true; active?.cancel() }
export async function learningAssetResponse(id: string): Promise<Response> {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('无效 ID')
    const row = getDb().prepare('SELECT mime_type,sha256,file_path FROM learning_assets WHERE id=?').get(id) as { mime_type: string; sha256: string; file_path: string } | undefined
    if (!row || !['image/png', 'image/jpeg'].includes(row.mime_type)) throw new Error('无附件')
    const file = managedMaterialFile(row.file_path)
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('图片容量超限')
    const bytes = await readFile(file)
    if (bytes.length > 8 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('图片完整性校验失败')
    return new Response(bytes, { headers: { 'Content-Type': row.mime_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
  } catch { return new Response(null, { status: 404 }) }
}
