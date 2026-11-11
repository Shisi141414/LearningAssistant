/**
 * ipc/providers.ipc.ts —— 供应商与模型管理（ccswitch 风格配置的核心后端）
 *
 * 安全：api_key 只接收、加密入库；list 下发 Provider（仅 has_key 布尔）。
 */
import { IPC } from '@shared/ipc-channels'
import type { Provider, ProviderInput, ProviderTestResult, ModelInfo, ModelInput, ID } from '@shared/types'
import { getDb } from '../services/db'
import { encryptSecret, decryptSecret } from '../services/secrets'
import { testProvider, listRemoteModels } from '../services/llm'
import { ipcMain, handleResult } from './helpers'
import { nanoid } from 'nanoid'

interface ProviderRow {
  id: string
  name: string
  base_url: string
  api_format: 'openai' | 'anthropic'
  api_key_encrypted: Buffer | null
  enabled: number
  created_at: number
  updated_at: number
}

function rowToProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    name: r.name,
    base_url: r.base_url,
    api_format: r.api_format,
    has_key: !!r.api_key_encrypted && r.api_key_encrypted.length > 0,
    enabled: r.enabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at
  }
}

/** 主进程内部使用：取供应商 + 解密后的 Key（供 chat/测试） */
export function getProviderWithKey(id: ID): { provider: Provider; apiKey: string | null } {
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
  if (!row) throw new Error('供应商不存在')
  const apiKey = decryptSecret(row.api_key_encrypted)
  if (apiKey && row.api_key_encrypted?.subarray(0, 6).toString() === 'plain:') {
    getDb().prepare('UPDATE providers SET api_key_encrypted = ? WHERE id = ?').run(encryptSecret(apiKey), id)
  }
  return { provider: rowToProvider(row), apiKey }
}

interface ModelRow {
  id: string
  provider_id: string
  model_id: string
  display_name: string
  context_length: number | null
  supports_vision: number
  speed_tier: string | null
  notes: string
  created_at: number
}

function rowToModel(r: ModelRow): ModelInfo {
  return {
    id: r.id,
    provider_id: r.provider_id,
    model_id: r.model_id,
    display_name: r.display_name,
    context_length: r.context_length,
    supports_vision: r.supports_vision === 1,
    speed_tier: (r.speed_tier as ModelInfo['speed_tier']) ?? null,
    notes: r.notes,
    created_at: r.created_at
  }
}

export function registerProvidersIpc(): void {
  /* ---------- 供应商 ---------- */

  ipcMain.handle(IPC.ProvidersList, () =>
    handleResult(() => {
      const rows = getDb().prepare('SELECT * FROM providers ORDER BY created_at').all() as ProviderRow[]
      return rows.map(rowToProvider)
    })
  )

  ipcMain.handle(IPC.ProvidersSave, (_e, input: ProviderInput & { id?: ID }) =>
    handleResult(() => {
      const db = getDb()
      const now = Date.now()

      if (input.id) {
        // 更新：Key 留空则保持原 Key
        const cur = db.prepare('SELECT * FROM providers WHERE id = ?').get(input.id) as ProviderRow | undefined
        if (!cur) throw new Error('供应商不存在')
        const keyBlob = input.api_key ? encryptSecret(input.api_key) : cur.api_key_encrypted
        db.prepare('UPDATE providers SET name = ?, base_url = ?, api_format = ?, api_key_encrypted = ?, enabled = ?, updated_at = ? WHERE id = ?').run(
          input.name, input.base_url, input.api_format, keyBlob, (input.enabled ?? cur.enabled === 1) ? 1 : 0, now, input.id
        )
        return rowToProvider(db.prepare('SELECT * FROM providers WHERE id = ?').get(input.id) as ProviderRow)
      }

      const id = nanoid()
      db.prepare('INSERT INTO providers (id, name, base_url, api_format, api_key_encrypted, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, input.name, input.base_url, input.api_format, encryptSecret(input.api_key ?? ''), input.enabled === false ? 0 : 1, now, now
      )
      return rowToProvider(db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow)
    })
  )

  ipcMain.handle(IPC.ProvidersRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM providers WHERE id = ?').run(id) // models 级联删除
      return true
    })
  )

  ipcMain.handle(IPC.ProvidersTest, (_e, id: ID) =>
    handleResult(async (): Promise<ProviderTestResult> => {
      const { provider, apiKey } = getProviderWithKey(id)
      if (!apiKey) return { ok: false, latencyMs: 0, error: '未配置 API Key' }
      return testProvider({ base_url: provider.base_url, api_format: provider.api_format, apiKey })
    })
  )

  /* ---------- 模型 ---------- */

  ipcMain.handle(IPC.ModelsList, (_e, providerId?: ID) =>
    handleResult(() => {
      const db = getDb()
      const rows = providerId
        ? (db.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY display_name').all(providerId) as ModelRow[])
        : (db.prepare('SELECT * FROM models ORDER BY display_name').all() as ModelRow[])
      return rows.map(rowToModel)
    })
  )

  /** 从上游 {base}/models 拉取模型 id 列表（不直接入库，由用户确认后 ModelsSave） */
  ipcMain.handle(IPC.ModelsImport, (_e, providerId: ID) =>
    handleResult(async () => {
      const { provider, apiKey } = getProviderWithKey(providerId)
      if (!apiKey) throw new Error('未配置 API Key')
      return listRemoteModels({ base_url: provider.base_url, api_format: provider.api_format, apiKey })
    })
  )

  ipcMain.handle(IPC.ModelsSave, (_e, input: ModelInput & { id?: ID }) =>
    handleResult(() => {
      const db = getDb()
      if (input.id) {
        db.prepare('UPDATE models SET model_id = ?, display_name = ?, context_length = ?, supports_vision = ?, speed_tier = ?, notes = ? WHERE id = ?').run(
          input.model_id,
          input.display_name ?? input.model_id,
          input.context_length ?? null,
          input.supports_vision ? 1 : 0,
          input.speed_tier ?? null,
          input.notes ?? '',
          input.id
        )
        return rowToModel(db.prepare('SELECT * FROM models WHERE id = ?').get(input.id) as ModelRow)
      }
      const id = nanoid()
      db.prepare('INSERT INTO models (id, provider_id, model_id, display_name, context_length, supports_vision, speed_tier, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        id, input.provider_id, input.model_id, input.display_name ?? input.model_id,
        input.context_length ?? null, input.supports_vision ? 1 : 0, input.speed_tier ?? null, input.notes ?? '', Date.now()
      )
      return rowToModel(db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow)
    })
  )

  ipcMain.handle(IPC.ModelsRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM models WHERE id = ?').run(id)
      return true
    })
  )
}
