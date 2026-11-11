import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { dbFilePath } from './db'

export function managedMaterialFile(path: string): string {
  const root = realpathSync(join(dirname(dbFilePath()), 'materials'))
  const file = realpathSync(resolve(dirname(dbFilePath()), path))
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('材料路径超出托管目录')
  return file
}
