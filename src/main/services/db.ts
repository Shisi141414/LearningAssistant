/**
 * services/db.ts —— SQLite 连接、迁移与种子数据
 *
 * 设计（docs/02-architecture.md）：
 *  - better-sqlite3 同步 API，主进程唯一写入口
 *  - 迁移：PRAGMA user_version 记录当前版本，按序执行 db/migrations.ts 中的内嵌 SQL
 *  - 首次启动写入种子学科（可删改——种子是数据不是代码，ADR-3）
 */
import Database from 'better-sqlite3'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { MIGRATIONS } from '../db/migrations'
import { resolveDataDir } from './bootConfig'

let db: Database.Database | null = null

export function dbFilePath(): string {
  return join(resolveDataDir(), 'learning-assistant.db')
}

export function getDb(): Database.Database {
  if (db) return db
  const filePath = dbFilePath()
  db = new Database(filePath)
  db.pragma('journal_mode = WAL') // 课堂高频写入场景，WAL 提高并发与耐久性
  db.pragma('foreign_keys = ON')
  migrate(db)
  seed(db)
  return db
}

export function closeDb(): void {
  if (db) {
    // 截断 WAL，让 .db 单文件自洽（迁移/备份场景依赖这一点）
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    db.close()
  }
  db = null
}

function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  const todo = [...MIGRATIONS].sort((a, b) => a.version - b.version).filter((m) => m.version > current)
  if (todo.length === 0) return
  const run = database.transaction(() => {
    for (const m of todo) {
      database.exec(m.sql)
      database.pragma(`user_version = ${m.version}`)
    }
  })
  run()
}

/** 首次启动（无任何学科）时写入示例学科，用户可自由修改/删除 */
function seed(database: Database.Database): void {
  const count = (database.prepare('SELECT COUNT(*) AS c FROM subjects').get() as { c: number }).c
  if (count > 0) return
  const now = Date.now()
  const insert = database.prepare(
    'INSERT INTO subjects (id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  const defaults: Array<[string, string, string]> = [
    ['数学分析', '#2563eb', '极限、微分、积分与级数'],
    ['高等代数', '#7c3aed', '线性空间、矩阵与二次型'],
    ['大学物理', '#16a34a', '力学、热学、电磁学'],
    ['理论与应用力学', '#ea580c', '本专业主课']
  ]
  for (const [name, color, description] of defaults) {
    insert.run(nanoid(), name, color, description, now)
  }
}
