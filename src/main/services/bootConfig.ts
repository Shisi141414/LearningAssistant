/**
 * services/bootConfig.ts —— 引导配置（数据目录等"数据库存在之前就要知道"的信息）
 *
 * 鸡生蛋问题：数据目录不能存进 SQLite（先有目录才有库），
 * 因此用一个独立 JSON 文件（userData/app-config.json）做引导。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'

export interface BootConfig {
  /** 用户数据目录（SQLite 与附件所在），空/缺省 = userData 默认位置 */
  dataDir?: string
}

function bootConfigPath(): string {
  return join(app.getPath('userData'), 'app-config.json')
}

export function readBootConfig(): BootConfig {
  const p = bootConfigPath()
  if (!existsSync(p)) return {}
  const parsed = JSON.parse(readFileSync(p, 'utf-8')) as BootConfig
  if (!parsed || typeof parsed !== 'object' || (parsed.dataDir !== undefined && typeof parsed.dataDir !== 'string')) throw new Error('数据目录配置无效，请检查 app-config.json')
  return parsed
}

export function writeBootConfig(cfg: BootConfig): void {
  const file = bootConfigPath()
  const temporary = file + '.tmp-' + Date.now()
  try {
    writeFileSync(temporary, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', flag: 'wx' })
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** 数据目录：自定义目录（必须已存在且可写）优先，否则回退 userData */
export function resolveDataDir(): string {
  const dir = readBootConfig().dataDir
  if (dir) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('自定义数据目录不可用；请连接对应磁盘或恢复目录，不会自动创建另一份数据库')
    return dir
  }
  return app.getPath('userData')
}
