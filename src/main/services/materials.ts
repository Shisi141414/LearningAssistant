import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, stat, unlink, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { nanoid } from 'nanoid'
import type { Material, MaterialBlock, MaterialDetail, MaterialFormat, MaterialInput, MaterialVersion, OcrInput, OcrPage, ParsedBlock } from '@shared/types'
import { getDb, dbFilePath } from './db'
import { beginWork, withWork } from './work'
import { completeOcrVersion, derivedParent, insertDerived, validateOcrRange } from './material-derivations'
import { OCR_MODEL_COMMIT, OCR_MODELS, ocrModelDirectory, ocrModelsStatus } from './ocr-models'
import { managedMaterialFile } from './material-files'
import { ensureMaterialConversion, materialParseInput } from './office-conversions'

const versionFields = 'id, material_id, file_name, format, fingerprint, status, progress, error, warnings_json, created_at, parent_version_id, derivation'
const materialFields = 'id, subject_id, title, kind, created_at, current_version_id, archived'
interface VersionRow extends MaterialVersion { file_path: string; processing_json: string }
interface ParseResult { blocks: ParsedBlock[]; warnings: string[]; pages?: OcrPage[] }
let active: { id: string; worker: Worker; finish: (status: 'ready' | 'failed' | 'cancelled' | 'queued', error?: string, result?: ParseResult) => void } | undefined
let stopping = false
let starting: string | undefined
let converting: AbortController | undefined

function version(id: string): VersionRow {
  const row = getDb().prepare('SELECT * FROM material_versions WHERE id = ?').get(id) as VersionRow | undefined
  if (!row) throw new Error('材料版本不存在')
  return row
}
export function listMaterials(subjectId?: string): Material[] {
  const db = getDb()
  const rows = db.prepare(`SELECT ${materialFields} FROM materials WHERE archived = 0 ${subjectId ? 'AND subject_id = ?' : ''} ORDER BY created_at DESC, id`).all(...(subjectId ? [subjectId] : [])) as Material[]
  return rows.map(row => ({ ...row, version: row.current_version_id ? db.prepare(`SELECT ${versionFields} FROM material_versions WHERE id = ?`).get(row.current_version_id) as MaterialVersion : undefined }))
}
export function materialDetail(id: string): MaterialDetail {
  const db = getDb()
  const material = db.prepare(`SELECT ${materialFields} FROM materials WHERE id = ?`).get(id) as Material | undefined
  if (!material) throw new Error('材料不存在')
  return { material, versions: db.prepare(`SELECT ${versionFields} FROM material_versions WHERE material_id = ? ORDER BY created_at DESC, id`).all(id) as MaterialVersion[], total: (db.prepare('SELECT COUNT(*) AS n FROM material_blocks WHERE version_id = ?').get(material.current_version_id) as { n: number }).n, conversions: db.prepare('SELECT c.version_id, c.format, c.fingerprint, c.engine, c.created_at FROM material_conversions c JOIN material_versions v ON v.id = c.version_id WHERE v.material_id = ?').all(id) as MaterialDetail['conversions'] }
}
export function materialBlocks(input: { version_id: string; query?: string; offset?: number }): { blocks: MaterialBlock[]; total: number } {
  version(input.version_id)
  const db = getDb(), query = input.query?.trim() ?? ''
  const where = 'version_id = ? AND (? = \'\' OR instr(lower(text), lower(?)) > 0 OR instr(lower(heading), lower(?)) > 0)'
  const args = [input.version_id, query, query, query]
  return { blocks: db.prepare(`SELECT * FROM material_blocks WHERE ${where} ORDER BY ordinal LIMIT 100 OFFSET ?`).all(...args, input.offset ?? 0) as MaterialBlock[], total: (db.prepare(`SELECT COUNT(*) AS n FROM material_blocks WHERE ${where}`).get(...args) as { n: number }).n }
}
export function materialPath(id: string): string {
  return managedMaterialFile(version(id).file_path)
}
/** 文件头魔数嗅探：ZIP(PK..) / OLE2(旧 Office) / PDF。
 *  背景：曾发生扩展名 .docx 但实为旧 .doc 或损坏文件的导入，officeparser 在
 *  异步解析阶段才抛晦涩的 ZIP_NO_ENTRIES_FOUND，材料已入库成失败记录。 */
async function sniff(file: string): Promise<'zip' | 'ole2' | 'pdf' | 'unknown' | 'empty'> {
  const handle = await open(file, 'r')
  try {
    const buf = Buffer.alloc(8)
    const { bytesRead } = await handle.read(buf, 0, 8, 0)
    if (bytesRead === 0) return 'empty'
    if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'zip'
    if (buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole2'
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
    return 'unknown'
  } finally {
    await handle.close()
  }
}

/** 扩展名与实际内容一致性校验；不符时给出可操作的修复指引。 */
async function assertFormatMatches(source: string, format: string): Promise<void> {
  const actual = await sniff(source)
  const expect: Record<string, 'zip' | 'ole2' | 'pdf'> = { docx: 'zip', pptx: 'zip', doc: 'ole2', ppt: 'ole2', pdf: 'pdf' }
  const wanted = expect[format]
  if (actual === 'empty') throw new Error('文件内容为空，可能未下载完成')
  if (actual === wanted) return
  const actualLabel: Record<string, string> = { zip: '新版 Office（.docx/.pptx 的 ZIP 容器）', ole2: '旧版 Office 二进制（.doc/.ppt）', pdf: 'PDF', unknown: '未识别的格式' }
  if (actual === 'ole2' && wanted === 'zip') {
    throw new Error(`这个文件实际是旧版 Office 二进制格式（.doc/.ppt），只是扩展名被改成了 .${format}。请把扩展名改回 .doc/.ppt 后重新导入（将走 LibreOffice 转换），或用 Office/WPS 打开另存为 .${format}`)
  }
  if (actual === 'pdf' && wanted !== 'pdf') {
    throw new Error(`这个文件实际是 PDF，只是扩展名被改成了 .${format}。请把扩展名改回 .pdf 后按 PDF 导入`)
  }
  throw new Error(`文件内容与扩展名 .${format} 不符（实际为：${actualLabel[actual]}）。文件可能已损坏、被截断或下载不完整，请核对原件`)
}

/** 此入口仅供主进程文件选择器使用，渲染进程不能指定磁盘路径。 */
export async function importMaterial(input: MaterialInput, source: string): Promise<Material> {
  return withWork('材料导入', async () => {
    const db = getDb()
    if (!db.prepare('SELECT id FROM subjects WHERE id = ?').get(input.subject_id)) throw new Error('请先选择已有学科')
    if (input.material_id) {
      const old = materialDetail(input.material_id).material
      if (old.archived || old.subject_id !== input.subject_id) throw new Error('新版本必须归属同一学科的未归档材料')
    }
    const format = extname(source).slice(1).toLowerCase() as MaterialFormat
    if (!['pdf', 'docx', 'pptx', 'doc', 'ppt'].includes(format)) throw new Error('目前支持 PDF、DOCX、PPTX、DOC、PPT')
    const info = await stat(source)
    if (!info.isFile() || info.size > 50 * 1024 * 1024 || info.size === 0) throw new Error('请选择非空且不超过 50 MiB 的文件')
    // 先保留托管副本，再基于副本计算指纹，避免解析用户正在改写的原文件。
    const id = nanoid(), filePath = join('materials', id, `source.${format}`)
    const target = join(dirname(dbFilePath()), filePath)
    await mkdir(dirname(target), { recursive: true })
    let retained = false
    try {
      await copyFile(source, target)
      if ((await stat(target)).size > 50 * 1024 * 1024) throw new Error('复制后的文件超过 50 MiB')
      // 入库前校验内容与扩展名一致，避免"复制成功、解析失败"的僵尸材料记录
      await assertFormatMatches(target, format)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(target)) hash.update(chunk)
      const fingerprint = hash.digest('hex')
      const duplicate = db.prepare(`SELECT m.id FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.fingerprint = ? AND m.subject_id = ? AND m.archived = 0 ${input.material_id ? 'AND m.id = ?' : ''} LIMIT 1`).get(fingerprint, input.subject_id, ...(input.material_id ? [input.material_id] : [])) as { id: string } | undefined
      if (duplicate) {
        return materialDetail(duplicate.id).material
      }
      const materialId = input.material_id ?? nanoid(), now = Date.now()
      db.transaction(() => {
        if (!input.material_id) db.prepare('INSERT INTO materials (id, subject_id, title, kind, created_at) VALUES (?, ?, ?, ?, ?)').run(materialId, input.subject_id, input.title?.trim() || basename(source, extname(source)), input.kind, now)
        db.prepare('INSERT INTO material_versions (id, material_id, file_name, file_path, format, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, materialId, basename(source), filePath, format, fingerprint, now)
        db.prepare('UPDATE materials SET current_version_id = ? WHERE id = ?').run(id, materialId)
      })()
      retained = true
      void pump()
      return materialDetail(materialId).material
    } finally {
      // 只清理本次生成且未被数据库接管的文件，不递归删除目录。
      if (!retained) {
        await unlink(target).catch(error => { if (error.code !== 'ENOENT') console.warn('未入库材料副本清理失败', error.message) })
        await rmdir(dirname(target)).catch(error => { if (error.code !== 'ENOENT') console.warn('材料临时目录清理失败', error.message) })
      }
    }
  })
}

export async function startMaterialOcr(input: OcrInput): Promise<string> {
  return withWork('OCR 任务准备', async () => {
    if (stopping) throw new Error('应用正在退出，暂不创建新任务')
    validateOcrRange(input)
    if (!(await ocrModelsStatus()).ready) throw new Error('请先准备中英文 OCR 语言包')
    if (stopping) throw new Error('应用正在退出，暂不创建新任务')
    const parent = derivedParent(input.version_id)
    const id = getDb().transaction(() => insertDerived(parent, 'ocr', input, 'queued'))()
    void pump()
    return id
  })
}

async function pump(): Promise<void> {
  if (active || starting || stopping) return
  const next = getDb().prepare("SELECT v.* FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.status = 'queued' AND m.archived = 0 ORDER BY v.created_at, v.id LIMIT 1").get() as VersionRow | undefined
  if (!next) return
  starting = next.id
  // 路径解析前就占据队列位置；同时持有工作锁，避免目录迁移。
  const release = beginWork('材料解析')
  getDb().prepare("UPDATE material_versions SET status = 'parsing', error = NULL, progress = 1 WHERE id = ?").run(next.id)
  let worker: Worker
  try {
    if (next.format === 'doc' || next.format === 'ppt') {
      converting = new AbortController()
      await ensureMaterialConversion(next.id, materialPath(next.id), next.format, converting.signal)
      converting = undefined
      if (stopping || version(next.id).status !== 'parsing') { starting = undefined; release(); queueMicrotask(() => void pump()); return }
    }
    const ocr = next.derivation === 'ocr' ? JSON.parse(next.processing_json) as OcrInput : undefined
    if (ocr) {
      validateOcrRange(ocr)
      if (!(await ocrModelsStatus()).ready) throw new Error('OCR 语言包缺失或校验失败，请重新准备')
      // await 期间取消、退出或归档后，不得重新启动已失效的任务。
      if (stopping || version(next.id).status !== 'parsing') { starting = undefined; release(); queueMicrotask(() => void pump()); return }
    }
    // 只把 realpath 校验后的托管文件交给解析线程。
    const require = createRequire(__filename)
    const modelJson = ocr ? JSON.stringify({ engine: 'tesseract.js', engineVersion: require('tesseract.js/package.json').version, coreVersion: require('tesseract.js-core/package.json').version, languages: ['chi_sim', 'eng'], source: 'tessdata_fast', commit: OCR_MODEL_COMMIT, files: OCR_MODELS }) : undefined
    worker = new Worker(join(__dirname, 'material-worker.js'), { workerData: { ...materialParseInput(next.id, materialPath(next.id), next.format), ocr, modelDirectory: ocr ? ocrModelDirectory() : undefined, modelJson }, resourceLimits: { maxOldGenerationSizeMb: 512 } })
  } catch (error) {
    if (!stopping) getDb().prepare("UPDATE material_versions SET status = 'failed', error = ? WHERE id = ? AND status = 'parsing'").run(String(error), next.id)
    converting = undefined; starting = undefined; release(); queueMicrotask(() => void pump()); return
  }
  let settled = false
  const timer = setTimeout(() => active?.id === next.id && active.finish('failed', next.derivation === 'ocr' ? '识别超过十分钟，请减少页数后重试' : '解析超过两分钟，请拆分文件或转换后重试'), next.derivation === 'ocr' ? 600_000 : 120_000)
  const finish = (status: 'ready' | 'failed' | 'cancelled' | 'queued', error?: string, result?: ParseResult): void => {
    if (settled) return
    settled = true; clearTimeout(timer)
    try {
      getDb().transaction(() => {
        if (result && status === 'ready') {
          if (next.derivation === 'ocr') result.warnings = completeOcrVersion(next.id, JSON.parse(next.processing_json), result.pages ?? [], result.warnings)
          else {
            const insert = getDb().prepare('INSERT INTO material_blocks (id, version_id, ordinal, heading, text, locator_json) VALUES (?, ?, ?, ?, ?, ?)')
            result.blocks.forEach((block, ordinal) => insert.run(nanoid(), next.id, ordinal, block.heading, block.text, JSON.stringify(block.locator)))
          }
        }
        getDb().prepare('UPDATE material_versions SET status = ?, progress = ?, error = ?, warnings_json = ? WHERE id = ?').run(status, status === 'ready' ? 100 : 0, error ?? null, JSON.stringify(result?.warnings ?? []), next.id)
      })()
    } catch (failure) {
      getDb().prepare("UPDATE material_versions SET status = 'failed', error = ? WHERE id = ?").run(String(failure), next.id)
    } finally {
      void worker.terminate(); active = undefined; release()
      if (!stopping) queueMicrotask(() => void pump())
    }
  }
  active = { id: next.id, worker, finish }
  starting = undefined
  worker.on('message', (message) => {
    if (settled) return
    if (message.type === 'progress') getDb().prepare('UPDATE material_versions SET progress = ? WHERE id = ?').run(Math.min(99, Math.max(1, message.progress)), next.id)
    if (message.type === 'done') finish('ready', undefined, message)
    if (message.type === 'error') finish('failed', message.error)
  })
  worker.on('error', error => { console.error('材料线程异常', error); finish('failed', error instanceof Error ? error.message : String(error)) })
  worker.on('exit', code => { if (!settled) finish('failed', `解析进程退出（${code}）`) })
}
export function cancelMaterial(id: string): boolean {
  const row = version(id)
  if (active?.id === id) active.finish('cancelled')
  else if (row.status === 'queued' || starting === id) {
    getDb().prepare("UPDATE material_versions SET status = 'cancelled', progress = 0 WHERE id = ?").run(id)
    if (starting === id) converting?.abort()
  }
  return true
}
export function retryMaterial(id: string): boolean {
  const row = version(id)
  if (!['failed', 'cancelled'].includes(row.status)) throw new Error('只可重试失败或取消的版本')
  if (materialDetail(row.material_id).material.archived) throw new Error('材料已归档')
  getDb().prepare("UPDATE material_versions SET status = 'queued', error = NULL, progress = 0 WHERE id = ?").run(id)
  void pump(); return true
}
export function archiveMaterial(id: string): boolean {
  materialDetail(id)
  getDb().prepare('UPDATE materials SET archived = 1 WHERE id = ?').run(id)
  const rows = getDb().prepare('SELECT id FROM material_versions WHERE material_id = ?').all(id) as Array<{ id: string }>
  rows.forEach(row => cancelMaterial(row.id))
  return true
}
export function startMaterialRecovery(): void {
  stopping = false
  getDb().prepare("UPDATE material_versions SET status = 'queued', progress = 0 WHERE status = 'parsing'").run()
  void pump()
}
export function stopMaterialJobs(): void {
  stopping = true
  converting?.abort()
  if (starting) getDb().prepare("UPDATE material_versions SET status = 'queued', progress = 0 WHERE id = ? AND status = 'parsing'").run(starting)
  active?.finish('queued')
}
