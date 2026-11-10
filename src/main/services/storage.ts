/**
 * services/storage.ts —— 数据存储位置管理（用户需求：设置页可选存储位置）
 *
 * 迁移流程：WAL checkpoint 截断 → 复制 .db 到新目录 → 写引导配置 → 热切换连接。
 * 旧目录文件保留（不删，作为回滚保险），用户确认无误后可手动删除。
 */
import { copyFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { closeDb, dbFilePath, getDb } from './db'
import { readBootConfig, writeBootConfig, resolveDataDir } from './bootConfig'

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
  if (!existsSync(newDir)) throw new Error('目标目录不存在')
  closeDb() // 内部做 WAL 截断，.db 单文件自洽
  const src = dbFilePath() // closeDb 之后 resolveDataDir 仍指向旧目录
  const dst = join(newDir, 'learning-assistant.db')
  if (src === dst) throw new Error('新目录与当前目录相同')
  if (!existsSync(src)) throw new Error('当前数据库文件不存在')
  copyFileSync(src, dst)
  writeBootConfig({ ...readBootConfig(), dataDir: newDir })
  getDb() // 立即重开（新目录），失败会抛错
  return storageInfo()
}

/** 重置为默认位置（userData）——同样走复制迁移 */
export function resetStorage(): StorageInfo {
  closeDb()
  const src = dbFilePath()
  const dst = join(app.getPath('userData'), 'learning-assistant.db')
  if (src !== dst && existsSync(src)) {
    copyFileSync(src, dst)
  }
  writeBootConfig({ ...readBootConfig(), dataDir: undefined })
  getDb()
  return storageInfo()
}
