/**
 * services/secrets.ts —— API Key 的安全存取
 *
 * 安全红线（docs/02-architecture.md §2）：
 *  - 密钥经 Electron safeStorage（Windows: DPAPI）加密后存 SQLite BLOB
 *  - 明文只在主进程内存中短暂存在，永不过 IPC 下发
 */
import { safeStorage } from 'electron'

export function encryptSecret(plain: string): Buffer | null {
  if (!plain) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统密钥加密不可用，未保存 API Key；请恢复系统加密服务后重试')
  }
  return safeStorage.encryptString(plain)
}

export function decryptSecret(encrypted: Buffer | null): string | null {
  if (!encrypted || encrypted.length === 0) return null
  const s = encrypted.toString('utf-8')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，暂时无法使用 API Key')
  if (s.startsWith('plain:')) return s.slice(6) // 仅供主进程兼容读取，调用方立即升级加密。
  try {
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}
