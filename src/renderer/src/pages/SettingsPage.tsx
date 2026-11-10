/**
 * pages/SettingsPage.tsx —— 设置：模型服务（ccswitch 风格）
 *
 * 供应商表单 = 名称 + baseURL + 上游格式 + API Key（cc-switch 同构）
 * 模型管理 = 从上游 /models 一键导入 + 能力备注（上下文/识图/速度/备注）可编辑
 * 预设（DeepSeek/智谱/通义/Kimi/SiliconFlow/OpenAI/Anthropic）一键填充
 */
import { useCallback, useEffect, useState } from 'react'
import type { Provider, ProviderInput, ModelInfo, ApiFormat, SpeedTier } from '@shared/types'
import { PROVIDER_PRESETS } from '@shared/presets'
import { useAppStore } from '../stores/app'

type ProviderTestState = Record<string, 'testing' | { ok: boolean; latencyMs: number; error?: string }>

export function SettingsPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tests, setTests] = useState<ProviderTestState>({})

  const reload = useCallback(async () => {
    const res = await window.api.providers.list()
    if (res.ok) {
      setProviders(res.data)
      setSelectedId((cur) => cur ?? res.data[0]?.id ?? null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const test = async (id: string): Promise<void> => {
    setTests((t) => ({ ...t, [id]: 'testing' }))
    const res = await window.api.providers.test(id)
    if (res.ok) {
      setTests((t) => ({ ...t, [id]: res.data }))
    } else {
      setTests((t) => ({ ...t, [id]: { ok: false, latencyMs: 0, error: res.error } }))
    }
  }

  const selected = providers.find((p) => p.id === selectedId) ?? null

  return (
    <div className="page">
      <h1>设置 · 模型服务</h1>
      <div className="muted" style={{ marginBottom: 14 }}>
        ccswitch 风格配置：填 baseURL、上游格式与 API Key，再从供应商导入模型列表；密钥加密存储在本机，仅在本地使用。
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'start' }}>
        {/* 左列：供应商 */}
        <div>
          <ProviderForm
            onSaved={async (id) => {
              await reload()
              if (id) setSelectedId(id)
              showToast('供应商已保存')
            }}
            showToast={showToast}
          />
          <div className="row-list" style={{ marginTop: 10 }}>
            {providers.map((p) => {
              const t = tests[p.id]
              return (
                <div
                  key={p.id}
                  className="row-item"
                  style={{ cursor: 'pointer', borderColor: p.id === selectedId ? 'var(--accent)' : undefined, flexDirection: 'column', alignItems: 'stretch' }}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="grow" style={{ fontWeight: 700 }}>
                      {p.name}
                    </div>
                    <span className="pill">{p.api_format}</span>
                    {!p.has_key && <span className="pill" style={{ background: '#fee2e2', color: '#b91c1c' }}>无 Key</span>}
                    {!p.enabled && <span className="pill">停用</span>}
                  </div>
                  <div className="meta" style={{ marginTop: 2 }}>
                    {p.base_url}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        void test(p.id)
                      }}
                    >
                      {t === 'testing' ? '测试中…' : '测试连通'}
                    </button>
                    <button
                      style={{ fontSize: 12, padding: '2px 8px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (window.confirm(`删除供应商「${p.name}」及其模型配置？`)) {
                          void window.api.providers.remove(p.id).then(() => void reload())
                        }
                      }}
                    >
                      删除
                    </button>
                    {t && t !== 'testing' && (
                      <span className={`pill${t.ok ? '' : ' err'}`} style={t.ok ? { background: '#dcfce7', color: '#15803d' } : { background: '#fee2e2', color: '#b91c1c' }}>
                        {t.ok ? `连通 ${t.latencyMs}ms` : `失败：${t.error?.slice(0, 60)}`}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 右列：所选供应商的模型管理 */}
        <div>{selected ? <ModelsPanel provider={selected} showToast={showToast} /> : <div className="empty">先添加或选择一个供应商</div>}</div>
      </div>
    </div>
  )
}

/* ================= 供应商表单 ================= */

const EMPTY_FORM: ProviderInput = { name: '', base_url: '', api_format: 'openai', api_key: '' }

function ProviderForm({ onSaved, showToast }: { onSaved: (id?: string) => Promise<void>; showToast: (m: string) => void }) {
  const [form, setForm] = useState<ProviderInput>(EMPTY_FORM)
  const [presetKey, setPresetKey] = useState('')
  const [saving, setSaving] = useState(false)

  const applyPreset = (key: string): void => {
    setPresetKey(key)
    const p = PROVIDER_PRESETS.find((x) => x.key === key)
    if (p) setForm({ name: p.label, base_url: p.base_url, api_format: p.api_format, api_key: '' })
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim() || !form.base_url.trim()) {
      showToast('名称与 baseURL 必填')
      return
    }
    setSaving(true)
    const res = await window.api.providers.save(form)
    setSaving(false)
    if (res.ok) {
      setForm(EMPTY_FORM)
      setPresetKey('')
      await onSaved(res.data.id)
    } else {
      showToast(`保存失败：${res.error}`)
    }
  }

  return (
    <div className="card">
      <h3 style={{ margin: '0 0 10px' }}>添加供应商</h3>
      <div className="form-grid">
        <label>预设</label>
        <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
          <option value="">— 手动填写 —</option>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}（{p.hint}）
            </option>
          ))}
        </select>

        <label>名称</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：DeepSeek 官方" />

        <label>baseURL</label>
        <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.deepseek.com/v1（openai 格式一般以 /v1 结尾）" />

        <label>上游格式</label>
        <select value={form.api_format} onChange={(e) => setForm({ ...form, api_format: e.target.value as ApiFormat })}>
          <option value="openai">OpenAI 兼容（DeepSeek / Qwen / GLM / Kimi / GPT…）</option>
          <option value="anthropic">Anthropic（Claude 系）</option>
        </select>

        <label>API Key</label>
        <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-…（加密存储于本机）" />
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存供应商'}
        </button>
        <button onClick={() => { setForm(EMPTY_FORM); setPresetKey('') }}>清空</button>
      </div>
    </div>
  )
}

/* ================= 模型管理面板 ================= */

function ModelsPanel({ provider, showToast }: { provider: Provider; showToast: (m: string) => void }) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [remoteIds, setRemoteIds] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<ModelInfo | 'new' | null>(null)

  const reload = useCallback(async () => {
    const res = await window.api.models.list(provider.id)
    if (res.ok) setModels(res.data)
  }, [provider.id])

  useEffect(() => {
    setRemoteIds([])
    setEditing(null)
    void reload()
  }, [reload])

  const importModels = async (): Promise<void> => {
    setImporting(true)
    const res = await window.api.models.import(provider.id)
    setImporting(false)
    if (res.ok) {
      const existing = new Set(models.map((m) => m.model_id))
      setRemoteIds(res.data.filter((id) => !existing.has(id)))
      showToast(`拉取到 ${res.data.length} 个模型，${res.data.length - (res.data.length - (res.data.filter((id) => !existing.has(id)).length))} 个已存在`)
    } else {
      showToast(`导入失败：${res.error}`)
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{provider.name} · 模型</h3>
        <span className="spacer" style={{ flex: 1 }} />
        <button onClick={() => void importModels()} disabled={importing}>
          {importing ? '拉取中…' : '从上游导入模型'}
        </button>
        <button className="primary" onClick={() => setEditing('new')}>
          + 手动添加
        </button>
      </div>

      {remoteIds.length > 0 && (
        <div style={{ marginBottom: 12, padding: 10, border: '1px dashed var(--border)', borderRadius: 8 }}>
          <div className="muted" style={{ marginBottom: 6 }}>点选要添加的模型（已存在的不再显示）：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {remoteIds.map((id) => (
              <button
                key={id}
                style={{ fontSize: 12 }}
                onClick={() => {
                  void window.api.models
                    .save({ provider_id: provider.id, model_id: id, display_name: id })
                    .then(() => {
                      setRemoteIds((cur) => cur.filter((x) => x !== id))
                      void reload()
                    })
                }}
              >
                + {id}
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && <ModelEditForm providerId={provider.id} model={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void reload() }} showToast={showToast} />}

      <div className="row-list">
        {models.length === 0 && <div className="empty">还没有模型。点击「从上游导入模型」拉取，或手动添加</div>}
        {models.map((m) => (
          <div key={m.id} className="row-item">
            <div className="grow">
              <div style={{ fontWeight: 700 }}>
                {m.display_name} <span className="muted">（{m.model_id}）</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                {m.context_length && <span className="pill">上下文 {(m.context_length / 1000).toFixed(0)}K</span>}
                {m.supports_vision && <span className="pill vision">识图</span>}
                {m.speed_tier && <span className="pill">{m.speed_tier === 'fast' ? '快' : m.speed_tier === 'medium' ? '中' : '慢'}</span>}
                {m.notes && <span className="pill" title={m.notes}>{m.notes.slice(0, 24)}</span>}
              </div>
            </div>
            <button style={{ fontSize: 12 }} onClick={() => setEditing(m)}>
              编辑
            </button>
            <button
              style={{ fontSize: 12 }}
              onClick={() => {
                void window.api.models.remove(m.id).then(() => void reload())
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ModelEditForm({
  providerId,
  model,
  onDone,
  showToast
}: {
  providerId: string
  model: ModelInfo | null
  onDone: () => void
  showToast: (m: string) => void
}) {
  const [modelId, setModelId] = useState(model?.model_id ?? '')
  const [displayName, setDisplayName] = useState(model?.display_name ?? '')
  const [contextLength, setContextLength] = useState(model?.context_length?.toString() ?? '')
  const [vision, setVision] = useState(model?.supports_vision ?? false)
  const [speed, setSpeed] = useState<SpeedTier | ''>(model?.speed_tier ?? '')
  const [notes, setNotes] = useState(model?.notes ?? '')

  const save = async (): Promise<void> => {
    if (!modelId.trim()) {
      showToast('model id 必填')
      return
    }
    const res = await window.api.models.save({
      id: model?.id,
      provider_id: providerId,
      model_id: modelId.trim(),
      display_name: displayName.trim() || modelId.trim(),
      context_length: contextLength ? parseInt(contextLength, 10) : null,
      supports_vision: vision,
      speed_tier: speed || null,
      notes
    })
    if (res.ok) onDone()
    else showToast(`保存失败：${res.error}`)
  }

  return (
    <div style={{ marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
      <div className="form-grid" style={{ gridTemplateColumns: '110px 1fr' }}>
        <label>model id</label>
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="如 deepseek-chat" disabled={!!model} />

        <label>显示名</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 DeepSeek Chat" />

        <label>上下文长度</label>
        <input value={contextLength} onChange={(e) => setContextLength(e.target.value.replace(/\D/g, ''))} placeholder="128000（token 数，选填）" />

        <label>能力</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> 支持识图
          </label>
          <select value={speed} onChange={(e) => setSpeed(e.target.value as SpeedTier | '')} style={{ width: 100 }}>
            <option value="">速度未标</option>
            <option value="fast">快</option>
            <option value="medium">中</option>
            <option value="slow">慢</option>
          </select>
        </div>

        <label>备注</label>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="自由备注：擅长什么、价格、坑…" />
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button className="primary" onClick={() => void save()}>
          保存模型
        </button>
        <button onClick={onDone}>取消</button>
      </div>
    </div>
  )
}
