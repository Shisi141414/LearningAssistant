/**
 * services/config.ts —— 应用内 KV 配置（存 app_config 表，migration 003）
 * 已知键：
 *   asr.model_dir  本地语音模型目录（sherpa-onnx zipformer）
 *   asr.hotwords   热词表（每行一个，力学等学科术语）
 */
import { getDb } from './db'

export function configGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function configSet(key: string, value: string | null): void {
  const db = getDb()
  if (value === null || value === '') {
    db.prepare('DELETE FROM app_config WHERE key = ?').run(key)
  } else {
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }
}
