/**
 * pages/SettingsPage.tsx —— 设置：模型服务 / 语音引擎 / 数据与存储
 *
 * 布局（2026-11-10 修复）：添加供应商表单为全宽卡片（.form-grid2 响应式字段），
 * 不再挤在窄列里；下方左列供应商列表、右列模型管理。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Provider, ProviderInput, ModelInfo, ApiFormat, SpeedTier, AsrStatus, StorageInfo } from '@shared/types'
import { PROVIDER_PRESETS } from '@shared/presets'
import { chunkText } from '@shared/textChunk'
import { DIAG_CHUNK_SAMPLE } from '@shared/diagSamples'
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
    if (res.ok) setTests((t) => ({ ...t, [id]: res.data }))
    else setTests((t) => ({ ...t, [id]: { ok: false, latencyMs: 0, error: res.error } }))
  }

  const selected = providers.find((p) => p.id === selectedId) ?? null

  return (
    <div className="page">
      <h1>设置</h1>

      <div className="section-title">模型服务</div>
      <div className="muted" style={{ marginBottom: 12 }}>
        ccswitch 风格配置：填 baseURL、上游格式与 API Key，再从供应商导入模型列表；密钥加密存储在本机，仅在本地使用。
      </div>

      <ProviderForm
        onSaved={async (id) => {
          await reload()
          if (id) setSelectedId(id)
          showToast('供应商已保存')
        }}
        showToast={showToast}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start', marginTop: 14 }}>
        {/* 左列：供应商列表 */}
        <div className="row-list">
          {providers.length === 0 && <div className="empty">还没有供应商，用上方表单添加</div>}
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
                <div className="meta" style={{ marginTop: 2, wordBreak: 'break-all' }}>
                  {p.base_url}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
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
                    <span style={t.ok ? { fontSize: 11, color: '#15803d' } : { fontSize: 11, color: '#b91c1c' }}>
                      {t.ok ? `连通 ${t.latencyMs}ms` : `失败：${t.error?.slice(0, 50)}`}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 右列：所选供应商的模型管理 */}
        <div>{selected ? <ModelsPanel provider={selected} showToast={showToast} /> : <div className="empty">先添加或选择一个供应商</div>}</div>
      </div>

      <AsrCard />
      <StorageCard />
      <DiagnosticsCard />
    </div>
  )
}

/* ================= 麦克风测试（硬件排查） ================= */

interface MicStats {
  frames: number
  sumRms: number
  maxRms: number
  silentFrames: number
  clipFrames: number
}

type MicPhase = 'idle' | 'recording' | 'recorded'

function MicTestRow() {
  const [phase, setPhase] = useState<MicPhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0) // 0~1 实时电平
  const [stats, setStats] = useState<MicStats | null>(null)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [sampleRate, setSampleRate] = useState(0)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refs = useRef<{
    recorder: MediaRecorder | null
    chunks: Blob[]
    ctx: AudioContext | null
    stream: MediaStream | null
    analyser: AnalyserNode | null
    timer: number | null
    raf: number | null
    stats: MicStats
  }>({ recorder: null, chunks: [], ctx: null, stream: null, analyser: null, timer: null, raf: null, stats: { frames: 0, sumRms: 0, maxRms: 0, silentFrames: 0, clipFrames: 0 } })

  const cleanup = (): void => {
    const r = refs.current
    if (r.timer) clearInterval(r.timer)
    if (r.raf) cancelAnimationFrame(r.raf)
    r.recorder?.stream.getTracks().forEach((t) => t.stop())
    void r.ctx?.close().catch(() => undefined)
    refs.current = { ...r, recorder: null, ctx: null, stream: null, analyser: null, timer: null, raf: null }
  }

  useEffect(() => cleanup, [])

  const start = async (): Promise<void> => {
    setError(null)
    setBlobUrl(null)
    setStats(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      const track = stream.getAudioTracks()[0]
      setDeviceLabel(track.label || '（未获取设备名）')

      // 采集链路 A：MediaRecorder 录制（回放用）
      const chunks: Blob[] = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        setBlobUrl(URL.createObjectURL(blob))
      }
      recorder.start(250)

      // 采集链路 B：AnalyserNode 电平统计（质量分析用）
      const ctx = new AudioContext()
      setSampleRate(ctx.sampleRate)
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const s: MicStats = { frames: 0, sumRms: 0, maxRms: 0, silentFrames: 0, clipFrames: 0 }

      const loop = (): void => {
        analyser.getFloatTimeDomainData(buf)
        let sumSq = 0
        let clipped = 0
        for (let i = 0; i < buf.length; i++) {
          sumSq += buf[i] * buf[i]
          if (Math.abs(buf[i]) > 0.985) clipped++
        }
        const rms = Math.sqrt(sumSq / buf.length)
        s.frames++
        s.sumRms += rms
        s.maxRms = Math.max(s.maxRms, rms)
        if (rms < 0.005) s.silentFrames++
        s.clipFrames += clipped
        setLevel(Math.min(1, rms * 4)) // 放大显示
        refs.current.raf = requestAnimationFrame(loop)
      }

      refs.current = { ...refs.current, recorder, chunks, ctx, stream, analyser, stats: s, raf: requestAnimationFrame(loop) }
      setSeconds(0)
      refs.current.timer = window.setInterval(() => setSeconds((v) => v + 1), 1000)
      setPhase('recording')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const stop = (): void => {
    refs.current.recorder?.stop()
    setStats(refs.current.stats)
    cleanup()
    setLevel(0)
    setPhase('recorded')
  }

  /** 质量结论 */
  const verdict = (s: MicStats): { ok: boolean; text: string } => {
    if (s.frames === 0) return { ok: false, text: '未采集到音频帧' }
    const avgRms = s.sumRms / s.frames
    const silentRatio = s.silentFrames / s.frames
    const clipRatio = s.clipFrames / (s.frames * 2048)
    if (s.maxRms < 0.01 || silentRatio > 0.98) return { ok: false, text: `疑似无声（峰值 ${s.maxRms.toFixed(3)}，静音占比 ${(silentRatio * 100).toFixed(0)}%）——检查麦克风开关、系统输入设备选择或换设备` }
    if (clipRatio > 0.01) return { ok: false, text: `削波（削波采样占比 ${(clipRatio * 100).toFixed(1)}%）——系统里调低麦克风增益，否则识别率会显著下降` }
    if (avgRms < 0.02) return { ok: true, text: `电平偏低（均值 ${avgRms.toFixed(3)}）——建议离麦克风更近或调高增益，可正常使用` }
    return { ok: true, text: `音频质量正常（均值 ${avgRms.toFixed(3)}，峰值 ${s.maxRms.toFixed(3)}），适合语音识别` }
  }

  return (
    <div className="row-item" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div style={{ fontWeight: 700 }}>⑥ 麦克风与音频质量（硬件排查）</div>
        <div className="meta" style={{ marginBottom: 4 }}>录几句话 → 回放试听 + 电平统计。若测试①识别异常，先跑这项排除麦克风问题</div>

        {phase === 'recording' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
            <span className="rec-indicator">
              <span className="dot" /> {seconds}s
            </span>
            <div style={{ flex: 1, height: 8, background: '#f1f2f4', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${level * 100}%`, height: '100%', background: level > 0.9 ? 'var(--danger)' : 'var(--accent)', transition: 'width 0.08s' }} />
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: '#b91c1c', padding: '4px 0' }}>启动失败：{error}</div>}

        {stats && (
          <div style={{ fontSize: 12.5, lineHeight: 1.7, padding: '6px 10px', borderRadius: 6, background: verdict(stats).ok ? '#f0fdf4' : '#fef2f2', color: verdict(stats).ok ? '#166534' : '#b91c1c' }}>
            {verdict(stats).text}
            <br />
            <span style={{ opacity: 0.75 }}>
              设备：{deviceLabel || '未知'} · 采样率 {sampleRate}Hz · 采集 {stats.frames} 帧
            </span>
          </div>
        )}

        {blobUrl && (
          <div style={{ marginTop: 6 }}>
            {/* Chromium 原生支持 webm/opus 回放 */}
            <audio controls src={blobUrl} style={{ width: '100%', height: 34 }} />
          </div>
        )}
      </div>
      {phase === 'recording' ? (
        <button style={{ minWidth: 88 }} onClick={stop}>
          停止（{seconds}s）
        </button>
      ) : (
        <button style={{ minWidth: 88 }} onClick={() => void start()}>
          {phase === 'recorded' ? '重新录制' : '开始录制'}
        </button>
      )}
    </div>
  )
}

/* ================= 功能自检 ================= */

type DiagState = { running: boolean; ok?: boolean; text?: string }

function DiagRow({
  title,
  desc,
  state,
  onRun,
  disabled
}: {
  title: string
  desc: string
  state: DiagState
  onRun: () => void
  disabled?: boolean
}) {
  return (
    <div className="row-item" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div className="meta" style={{ marginBottom: 4 }}>{desc}</div>
        {state.text && (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.6,
              padding: '6px 10px',
              borderRadius: 6,
              background: state.ok ? '#f0fdf4' : '#fef2f2',
              color: state.ok ? '#166534' : '#b91c1c',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 160,
              overflowY: 'auto'
            }}
          >
            {state.text}
          </div>
        )}
      </div>
      <button disabled={state.running || disabled} onClick={onRun} style={{ minWidth: 88 }}>
        {state.running ? '测试中…' : '运行测试'}
      </button>
    </div>
  )
}

function DiagnosticsCard() {
  const [asr, setAsr] = useState<DiagState>({})
  const [chat, setChat] = useState<DiagState>({})
  const [organize, setOrganize] = useState<DiagState>({})
  const [vision, setVision] = useState<DiagState>({})
  const [chunk, setChunk] = useState<DiagState>({})

  const wrap = async (setter: (s: DiagState) => void, fn: () => Promise<string>): Promise<void> => {
    setter({ running: true })
    try {
      const text = await fn()
      setter({ running: false, ok: true, text })
    } catch (e) {
      setter({ running: false, ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <>
      <div className="section-title">功能自检</div>
      <div className="card">
        <div className="muted" style={{ marginBottom: 10 }}>
          逐项验证各能力链路（引擎加载、模型服务、整理管线、识图、切块），排查配置问题。语音链路用模型自带测试音频，不经过麦克风——麦克风需在课堂页实测。
        </div>
        <div className="row-list">
          <MicTestRow />
          <DiagRow
            title="① 语音识别（本地引擎）"
            desc="加载 sherpa-onnx 引擎并转写模型自带的测试音频，验证模型目录完整性与引擎可用"
            state={asr}
            onRun={() =>
              void wrap(setAsr, async () => {
                const r = await window.api.diag.asr()
                if (!r.ok) throw new Error(r.error)
                return `识别文件：${r.data.wavFile}\n耗时：${r.data.latencyMs}ms（含引擎加载）\n识别结果：${r.data.text || '（空）'}`
              })
            }
          />
          <DiagRow
            title="② 文本对话（LLM 服务）"
            desc="向默认模型发送最小补全请求，验证供应商 baseURL / API Key / 网络"
            state={chat}
            onRun={() =>
              void wrap(setChat, async () => {
                const r = await window.api.diag.chat()
                if (!r.ok) throw new Error(r.error)
                return `模型：${r.data.model}\n耗时：${r.data.latencyMs}ms\n回复：${r.data.reply.slice(0, 100)}`
              })
            }
          />
          <DiagRow
            title="③ 笔记整理（转写→分类纠错管线）"
            desc="用含同音错字的固定样例（科西中值定理样例）走完整整理管线，应返回 JSON 分类与纠错文本"
            state={organize}
            onRun={() =>
              void wrap(setOrganize, async () => {
                const r = await window.api.diag.organize()
                if (!r.ok) throw new Error(r.error)
                return `模型：${r.data.model} · 耗时 ${r.data.latencyMs}ms · 分类：${r.data.seg_type}${r.data.fallback ? '（回退原文）' : ''}\n整理结果：${r.data.organized_text.slice(0, 300)}`
              })
            }
          />
          <DiagRow
            title="④ 识图（vision 多模态）"
            desc="发送内嵌 64×64 红色方块图给第一个识图模型，应回答红色类描述"
            state={vision}
            onRun={() =>
              void wrap(setVision, async () => {
                const r = await window.api.diag.vision()
                if (!r.ok) throw new Error(r.error)
                return `模型：${r.data.model} · 耗时 ${r.data.latencyMs}ms\n回答：${r.data.reply}`
              })
            }
          />
          <DiagRow
            title="⑤ 文件切分（知识库切块器）"
            desc="本地运行（不联网）：把样例教材文本按标题/段落切块，预览块结构"
            state={chunk}
            onRun={() => {
              setChunk({ running: true })
              // 纯共享逻辑，渲染层直接跑（同步计算，微任务展示）
              setTimeout(() => {
                const chunks = chunkText(DIAG_CHUNK_SAMPLE)
                const sizes = chunks.map((c) => c.text.length)
                setChunk({
                  running: false,
                  ok: true,
                  text: `共 ${chunks.length} 块（长度 ${Math.min(...sizes)}~${Math.max(...sizes)} 字符）\n` +
                    chunks
                      .slice(0, 4)
                      .map((c, i) => `[${i + 1}] ${c.heading || '（无标题）'}：${c.text.slice(0, 40)}…`)
                      .join('\n')
                })
              }, 30)
            }}
          />
        </div>
      </div>
    </>
  )
}

/* ================= 供应商表单（全宽） ================= */

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
      <h3 style={{ margin: '0 0 12px' }}>添加供应商</h3>
      <div className="form-grid2">
        <div className="field">
          <label>预设</label>
          <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">— 手动填写 —</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}（{p.hint}）
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>名称</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：DeepSeek 官方" />
        </div>
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>baseURL</label>
          <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.deepseek.com/v1（openai 格式一般以 /v1 结尾）" />
        </div>
        <div className="field">
          <label>上游格式</label>
          <select value={form.api_format} onChange={(e) => setForm({ ...form, api_format: e.target.value as ApiFormat })}>
            <option value="openai">OpenAI 兼容（DeepSeek / Qwen / GLM / Kimi…）</option>
            <option value="anthropic">Anthropic（Claude 系）</option>
          </select>
        </div>
        <div className="field">
          <label>API Key</label>
          <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-…（加密存储于本机）" />
        </div>
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
      showToast(`拉取到 ${res.data.length} 个模型，其中 ${res.data.length - res.data.filter((id) => !existing.has(id)).length} 个已存在`)
    } else {
      showToast(`导入失败：${res.error}`)
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>{provider.name} · 模型</h3>
        <span style={{ flex: 1 }} />
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
      <div className="form-grid2">
        <div className="field">
          <label>model id</label>
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="如 deepseek-chat" disabled={!!model} />
        </div>
        <div className="field">
          <label>显示名</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 DeepSeek Chat" />
        </div>
        <div className="field">
          <label>上下文长度（token）</label>
          <input value={contextLength} onChange={(e) => setContextLength(e.target.value.replace(/\D/g, ''))} placeholder="128000（选填）" />
        </div>
        <div className="field">
          <label>速度档</label>
          <select value={speed} onChange={(e) => setSpeed(e.target.value as SpeedTier | '')}>
            <option value="">未标</option>
            <option value="fast">快</option>
            <option value="medium">中</option>
            <option value="slow">慢</option>
          </select>
        </div>
        <div className="field">
          <label>能力</label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> 支持识图
          </label>
        </div>
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>备注</label>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="自由备注：擅长什么、价格、坑…" />
        </div>
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

/* ================= 语音引擎（课堂模式） ================= */

function AsrCard() {
  const showToast = useAppStore((s) => s.showToast)
  const [status, setStatus] = useState<AsrStatus | null>(null)
  const [modelDir, setModelDir] = useState('')
  const [hotwords, setHotwords] = useState('')
  const [saving, setSaving] = useState(false)

  const reloadStatus = useCallback(async () => {
    const res = await window.api.classroom.asrStatus()
    if (res.ok) setStatus(res.data)
  }, [])

  useEffect(() => {
    void reloadStatus()
    void window.api.config.get('asr.model_dir').then((r) => {
      if (r.ok && r.data) setModelDir(r.data)
    })
    void window.api.config.get('asr.hotwords').then((r) => {
      if (r.ok && r.data) setHotwords(r.data)
    })
  }, [reloadStatus])

  const pick = async (): Promise<void> => {
    const dir = await window.api.classroom.pickModelDir().then((r) => (r.ok ? r.data : null))
    if (dir) setModelDir(dir)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    await window.api.config.set('asr.model_dir', modelDir.trim() || null)
    await window.api.config.set('asr.hotwords', hotwords.trim() || null)
    await reloadStatus()
    setSaving(false)
    showToast(status?.modelReady ? '语音引擎配置已保存' : '已保存（引擎仍需安装/模型文件才可用）')
  }

  return (
    <>
      <div className="section-title">语音引擎（课堂模式）</div>
      <div className="card">
        <div className="form-grid2">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>模型目录（sherpa-onnx 流式 zipformer，含 enc/dec/join .onnx 与 tokens.txt）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={modelDir} onChange={(e) => setModelDir(e.target.value)} placeholder="如 D:\\models\\sherpa-onnx-streaming-zipformer-zh-en-2023-11-20" style={{ flex: 1 }} />
              <button onClick={() => void pick()}>浏览…</button>
            </div>
          </div>
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>热词表（每行一个，学科术语提升识别率；需 transducer 系模型）</label>
            <textarea value={hotwords} onChange={(e) => setHotwords(e.target.value)} placeholder={'柯西中值定理\n哈密顿原理\n变分法'} style={{ minHeight: 72 }} />
          </div>
        </div>

        <div style={{ marginTop: 10, fontSize: 13 }}>
          {status === null ? (
            <span className="muted">状态检查中…</span>
          ) : status.installed ? (
            <span style={{ color: '#15803d' }}>sherpa-onnx-node 已安装</span>
          ) : (
            <span style={{ color: '#b45309' }}>未安装 sherpa-onnx-node —— 在项目目录执行 npm install sherpa-onnx-node</span>
          )}
          {status?.modelDir && (
            <span style={{ marginLeft: 12, color: status.modelReady ? '#15803d' : '#b45309' }}>
              {status.modelReady ? `模型就绪（${status.modelDir}）` : `模型缺文件：${status.missingFiles.join('、')}`}
            </span>
          )}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          模型下载：GitHub k2-fsa/sherpa-onnx 的 asr-models Release（推荐 streaming-zipformer 中英双语 int8 版，约几百 MB），解压后选目录即可。详见 README。
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存语音配置'}
          </button>
        </div>
      </div>
    </>
  )
}

/* ================= 数据与存储 ================= */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function StorageCard() {
  const showToast = useAppStore((s) => s.showToast)
  const [info, setInfo] = useState<StorageInfo | null>(null)

  const reload = useCallback(async () => {
    const res = await window.api.storage.info()
    if (res.ok) setInfo(res.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const migrate = async (): Promise<void> => {
    const dir = await window.api.storage.pickDir().then((r) => (r.ok ? r.data : null))
    if (!dir) return
    if (!window.confirm(`把全部数据（数据库 ${info ? formatBytes(info.dbSizeBytes) : ''}）迁移到：\n${dir}\n\n原位置文件保留作保险，确认后继续？`)) return
    const res = await window.api.storage.migrate(dir)
    if (res.ok) {
      setInfo(res.data)
      showToast(`已迁移到 ${res.data.dataDir}（建议重启应用）`)
    } else {
      showToast(`迁移失败：${res.error}`)
    }
  }

  const reset = async (): Promise<void> => {
    if (!window.confirm('恢复到默认存储位置（应用数据目录）？当前自定义目录的数据会复制回去并保留。')) return
    const res = await window.api.storage.resetToDefault()
    if (res.ok) {
      setInfo(res.data)
      showToast('已恢复默认位置（建议重启应用）')
    } else {
      showToast(`操作失败：${res.error}`)
    }
  }

  return (
    <>
      <div className="section-title">数据与存储</div>
      <div className="card">
        <div className="form-grid2">
          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>数据目录（SQLite 数据库与后续附件所在）</label>
            <input value={info?.dataDir ?? '读取中…'} readOnly style={{ background: '#fafafa' }} />
          </div>
          <div className="field">
            <label>数据库文件</label>
            <div className="muted" style={{ padding: '6px 0' }}>{info ? `${info.dbPath}（${formatBytes(info.dbSizeBytes)}）` : '—'}</div>
          </div>
          <div className="field">
            <label>来源</label>
            <div className="muted" style={{ padding: '6px 0' }}>{info ? (info.custom ? '自定义位置' : '应用默认（userData）') : '—'}</div>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="primary" onClick={() => void migrate()}>
            更改存储位置…
          </button>
          {info?.custom && <button onClick={() => void reset()}>恢复默认位置</button>}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          迁移过程：数据库自动检查点后复制到新目录，旧位置文件保留，确认无误后可手动删除。切换后建议重启应用。
        </div>
      </div>
    </>
  )
}
