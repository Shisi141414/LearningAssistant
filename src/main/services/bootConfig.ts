/**
 * services/bootConfig.ts —— 引导配置（数据目录等"数据库存在之前就要知道"的信息）
 *
 * 鸡生蛋问题：数据目录不能存进 SQLite（先有目录才有库），
 * 因此用一个独立 JSON 文件（userData/app-config.json）做引导。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface BootConfig {
  /** 用户数据目录（SQLite 与附件所在），空/缺省 = userData 默认位置 */
  dataDir?: string
}

function bootConfigPath(): string {
  return join(app.getPath('userData'), 'app-config.json')
}

export function readBootConfig(): BootConfig {
  try {
    const p = bootConfigPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as BootConfig
  } catch {
    return {}
  }
}

export function writeBootConfig(cfg: BootConfig): void {
  writeFileSync(bootConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8')
}

/** 数据目录：自定义目录（必须已存在且可写）优先，否则回退 userData */
export function resolveDataDir(): string {
  const dir = readBootConfig().dataDir
  if (dir && existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      // 目录不可写等异常 → 回退默认，避免应用无法启动
    }
  }
  return app.getPath('userData')
}
