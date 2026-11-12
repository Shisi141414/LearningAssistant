import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dbFilePath } from './db'

function inside(root: string, file: string): boolean { const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) }
/** 系统保存框指定目标；阻止覆盖应用托管数据，包括指向托管数据的链接。 */
export async function externalExportTarget(output: string, extension: string): Promise<{ target: string; directory: string }> {
  if (!output.toLowerCase().endsWith(extension)) throw new Error(`请使用 ${extension} 扩展名`)
  const directory = await realpath(dirname(resolve(output))), data = await realpath(dirname(dbFilePath()))
  if (inside(data, directory)) throw new Error('请选择应用数据目录以外的保存位置')
  const target = join(directory, basename(output))
  const actual = await realpath(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (actual && inside(data, actual)) throw new Error('保存目标指向应用数据，请选择其他位置')
  return { target, directory }
}
