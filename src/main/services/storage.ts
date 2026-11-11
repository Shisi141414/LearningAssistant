/**
 * services/storage.ts —— 数据存储位置管理（用户需求：设置页可选存储位置）
 *
 * 迁移流程：WAL checkpoint 截断 → 复制 .db 到新目录 → 写引导配置 → 热切换连接。
 * 旧目录文件保留（不删，作为回滚保险），用户确认无误后可手动删除。
 */
import { constants, copyFileSync, cpSync, existsSync, statSync, realpathSync, mkdtempSync, renameSync, unlinkSync, rmdirSync } from 'fs'
import { join, resolve } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { closeDb, dbFilePath, getDb } from './db'
import { readBootConfig, writeBootConfig, resolveDataDir } from './bootConfig'
import { assertIdle } from './work'

export interface StorageInfo {
  dataDir: string
  dbPath: string
  dbSizeBytes: number
  custom: boolean // 是否用户自定义目录
}

export function storageInfo(): StorageInfo {
  const dbPath = dbFilePath()
  let dbSizeBytes = 0
  try {
    dbSizeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0
  } catch {
    /* ignore */
  }
  return {
    dataDir: resolveDataDir(),
    dbPath,
    dbSizeBytes,
    custom: readBootConfig().dataDir === resolveDataDir() && !!readBootConfig().dataDir
  }
}

/** 迁移到新目录（目录必须已存在）。成功后数据库连接已指向新位置。 */
export function migrateStorage(newDir: string): StorageInfo {
  return moveStorage(newDir, false)
}

/** 重置为默认位置（userData）——同样走复制迁移 */
export function resetStorage(): StorageInfo {
  return moveStorage(app.getPath('userData'), true)
}

function moveStorage(directory: string, reset: boolean): StorageInfo {
  assertIdle()
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error('目标必须是已存在的目录')
  getDb()
  const previous = readBootConfig()
  const sourceDir = realpathSync(resolveDataDir())
  const newDir = realpathSync(resolve(directory))
  const canonical = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p
  if (canonical(sourceDir) === canonical(newDir)) return storageInfo()
  const src = dbFilePath()
  const dst = join(newDir, 'learning-assistant.db')
  const attachments = join(newDir, 'materials')
  if ([dst, dst + '-wal', dst + '-shm', attachments].some(existsSync)) throw new Error('目标目录已有数据库或材料，未覆盖；请选择空的数据目录，或先自行备份并移走已有数据')
  const staging = mkdtempSync(join(newDir, '.learning-assistant-move-'))
  let publishedDb = false
  let publishedMaterials = false
  try {
    closeDb()
    const stagedDb = join(staging, 'learning-assistant.db')
    copyFileSync(src, stagedDb, constants.COPYFILE_EXCL)
    const verify = new Database(stagedDb, { readonly: true })
    try {
      if (verify.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('迁移副本完整性检查失败')
    } finally { verify.close() }
    if (existsSync(join(sourceDir, 'materials'))) {
      cpSync(join(sourceDir, 'materials'), join(staging, 'materials'), { recursive: true, force: false, errorOnExist: true })
      renameSync(join(staging, 'materials'), attachments)
      publishedMaterials = true
    }
    copyFileSync(stagedDb, dst, constants.COPYFILE_EXCL)
    publishedDb = true
    writeBootConfig({ ...previous, dataDir: reset ? undefined : newDir })
    getDb()
    for (const file of [stagedDb, stagedDb + '-wal', stagedDb + '-shm']) if (existsSync(file)) unlinkSync(file)
    rmdirSync(staging)
    return storageInfo()
  } catch (error) {
    closeDb()
    if (JSON.stringify(readBootConfig()) !== JSON.stringify(previous)) writeBootConfig(previous)
    getDb()
    // 仅撤回本次创建的目标；原库和原附件一直保留。失败的暂存副本保留供排查。
    if (publishedMaterials) renameSync(attachments, join(staging, 'materials'))
    if (publishedDb) {
      for (const file of [dst, dst + '-wal', dst + '-shm']) if (existsSync(file)) unlinkSync(file)
    }
    throw error
  }
}
