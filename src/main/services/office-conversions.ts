import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, readFile, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { MaterialConversion, MaterialFormat, OfficeConverterStatus } from '@shared/types'
import { configGet, configSet } from './config'
import { getDb, dbFilePath } from './db'
import { cleanOfficeAttempt, convertOffice, officeProcess } from './office-converter'
import { managedMaterialFile } from './material-files'

function converterFile(file: string): string {
  if (!['soffice', 'soffice.exe', 'soffice.com'].includes(basename(file).toLowerCase())) throw new Error('请选择 LibreOffice program 目录的 soffice 程序')
  const console = join(dirname(file), 'soffice.com')
  return process.platform === 'win32' && existsSync(console) ? console : file
}
export function findOfficeConverter(): string | null {
  const configured = configGet('materials.libreoffice')
  if (configured) return converterFile(configured)
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(root => join(root!, 'LibreOffice', 'program', 'soffice.com'))
    : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
  return candidates.find(file => existsSync(file)) ?? null
}
export async function officeConverterStatus(): Promise<OfficeConverterStatus> {
  const path = findOfficeConverter()
  if (!path) return { ready: false, path: null, version: null, error: '未找到 LibreOffice。安装后选择其 program 目录中的 soffice 程序。' }
  try {
    const version = (await officeProcess(path, ['--version'], new AbortController().signal, 15_000)).slice(0, 300)
    if (!/LibreOffice/i.test(version)) throw new Error('程序未返回 LibreOffice 版本')
    return { ready: true, path, version, error: null }
  } catch (error) { return { ready: false, path, version: null, error: error instanceof Error ? error.message : String(error) } }
}
export async function configureOfficeConverter(path: string | null): Promise<OfficeConverterStatus> {
  if (path) {
    path = converterFile(path)
    if (!(await stat(path)).isFile()) throw new Error('转换程序不存在')
  }
  configSet('materials.libreoffice', path)
  return officeConverterStatus()
}
interface ConversionRow extends MaterialConversion { file_path: string }
export function materialConversion(versionId: string): MaterialConversion | null {
  const row = getDb().prepare('SELECT version_id, format, fingerprint, engine, created_at FROM material_conversions WHERE version_id = ?').get(versionId) as MaterialConversion | undefined
  return row ?? null
}
export function convertedMaterialFile(versionId: string): { file: string; format: 'docx' | 'pptx'; expectedFingerprint: string } {
  const row = getDb().prepare('SELECT * FROM material_conversions WHERE version_id = ?').get(versionId) as ConversionRow | undefined
  if (!row) throw new Error('旧版材料尚未完成转换，请配置 LibreOffice 后重新解析')
  return { file: managedMaterialFile(row.file_path), format: row.format, expectedFingerprint: row.fingerprint }
}
export function materialParseInput(versionId: string, file: string, format: MaterialFormat): { file: string; format: 'pdf' | 'docx' | 'pptx'; expectedFingerprint?: string } {
  return format === 'doc' || format === 'ppt' ? convertedMaterialFile(versionId) : { file, format }
}
export async function ensureMaterialConversion(versionId: string, file: string, format: 'doc' | 'ppt', signal: AbortSignal): Promise<void> {
  if (materialConversion(versionId)) { convertedMaterialFile(versionId); return }
  const executable = findOfficeConverter()
  if (!executable) throw new Error('导入旧版 DOC/PPT 需要 LibreOffice。请在材料库“旧版 Office 转换”配置后重新解析；原件已保留。')
  const root = join(dirname(dbFilePath()), 'materials', '.conversion')
  const converted = await convertOffice(executable, file, format, root, signal)
  const path = join('materials', versionId, `converted.${converted.format}`), target = join(dirname(dbFilePath()), path)
  let registered = false
  try {
    const fingerprint = createHash('sha256').update(await readFile(converted.file)).digest('hex')
    // 仅未登记的上次中断副本可被替换；已登记的产物在函数入口直接复用。
    await chmod(target, 0o644).catch(error => { if (error.code !== 'ENOENT') throw error })
    await copyFile(converted.file, target)
    await chmod(target, 0o444)
    if (signal.aborted) throw new Error('转换已取消')
    getDb().prepare('INSERT INTO material_conversions (version_id, format, file_path, fingerprint, engine, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(versionId, converted.format, path, fingerprint, converted.engine, Date.now())
    registered = true
  } finally {
    if (!registered) {
      await chmod(target, 0o644).catch(() => undefined)
      await unlink(target).catch(() => undefined)
    }
    await cleanOfficeAttempt(root, converted.directory)
  }
}
