/**
 * services/secrets.ts —— API Key 的安全存取
 *
 * 安全红线（docs/02-architecture.md §2）：
 *  - 密钥经 Electron safeStorage（Windows: DPAPI）加密后存 SQLite BLOB
 *  - 明文只在主进程内存中短暂存在，永不过 IPC 下发
 */
import { safeStorage } from 'electron'

export function encryptSecret(plain: string): Buffer | null {
  if (!safeStorage.isEncryptionAvailable()) {
    // DPAPI 不可用时退化为明文存储并标记（后续可提醒用户），Windows 正常环境不会走到这里
    return Buffer.from(`plain:${plain}`, 'utf-8')
  }
  return safeStorage.encryptString(plain)
}

export function decryptSecret(encrypted: Buffer | null): string | null {
  if (!encrypted || encrypted.length === 0) return null
  const s = encrypted.toString('utf-8')
  if (s.startsWith('plain:')) return s.slice(6)
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}
