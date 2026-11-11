import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EvidenceSource, KnowledgeAdoptInput, KnowledgeCandidate, KnowledgeSuggestion, KnowledgeSuggestionDetail, ModelInfo, Provider } from '@shared/types'
import { evidenceLookup, evidenceRoles } from '@shared/evidence'
import { knowledgeStatuses } from '@shared/knowledge-suggestions'
import { conceptKey } from '@shared/concept-matcher'
import { useConceptStore } from '../stores/concepts'
import { useAppStore } from '../stores/app'

interface Props { source: EvidenceSource; expectedNoteText?: string; quoteLength: number; disabled: boolean; onAdopted: () => void }
export function KnowledgeSuggestions(props: Props) {
  const [opened, setOpened] = useState(false)
  return <details className="knowledge-suggestions" onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
    <summary>助理提议知识点 <span className="muted">· 逐条核对后采纳</span></summary>
    {opened && <SuggestionEditor key={evidenceLookup(props.source)} {...props} />}
  </details>
}
function SuggestionEditor({ source, expectedNoteText, quoteLength, disabled, onAdopted }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]), [models, setModels] = useState<ModelInfo[]>([]), [modelId, setModelId] = useState('')
  const [jobs, setJobs] = useState<KnowledgeSuggestion[]>([]), [selected, setSelected] = useState(''), [detail, setDetail] = useState<KnowledgeSuggestionDetail | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const lock = useRef(false), requests = useRef(0), sourceJson = JSON.stringify(source)
  const selectedJob = jobs.find(job => job.id === selected)
  const refresh = useCallback(async (): Promise<void> => {
    const token = ++requests.current
    const result = await window.api.knowledgeSuggestions.list(JSON.parse(sourceJson))
    if (token !== requests.current) return
    if (result.ok) { setJobs(result.data); setSelected(previous => result.data.some(job => job.id === previous) ? previous : result.data[0]?.id ?? '') }
    else setError(result.error)
  }, [sourceJson])
  useEffect(() => { void refresh(); return () => { requests.current++ } }, [refresh])
  useEffect(() => {
    let alive = true
    void Promise.all([window.api.providers.list(), window.api.models.list()]).then(([p, m]) => {
      if (!alive) return
      if (p.ok) setProviders(p.data); else setError(p.error)
      if (m.ok) { setModels(m.data); if (p.ok) setModelId(m.data.find(model => p.data.some(provider => provider.enabled && provider.id === model.provider_id))?.id ?? '') }
      else setError(m.error)
    })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!jobs.some(job => job.status === 'running')) return
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
  }, [jobs, refresh])
  useEffect(() => {
    let alive = true
    setDetail(previous => previous?.id === selected ? previous : null)
    if (selected) void window.api.knowledgeSuggestions.get(selected).then(result => {
      if (!alive) return
      if (result.ok) setDetail(result.data); else setError(result.error)
    })
    return () => { alive = false }
  }, [selected, selectedJob?.status, detailVersion])
  const act = async (action: 'start' | 'cancel' | 'dismiss', adoption?: KnowledgeAdoptInput): Promise<void> => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      if (adoption) {
        const result = await window.api.knowledgeSuggestions.adopt(adoption)
        if (!result.ok) { setError(result.error); return }
        setDetail(result.data); onAdopted(); setMessage('已采纳，知识点与来源证据已保存')
      } else if (action === 'start') {
        const result = await window.api.knowledgeSuggestions.start({ source, model_db_id: modelId, ...(source.kind === 'note' ? { expected_note_text: expectedNoteText } : {}) })
        if (!result.ok) { setError(result.error); return }
        await refresh(); setSelected(result.data.id); return
      } else {
        const result = await window.api.knowledgeSuggestions[action](selected)
        if (!result.ok) { setError(result.error); return }
      }
      await refresh()
    } finally { lock.current = false; setBusy(false) }
  }
  const available = models.filter(model => providers.some(provider => provider.id === model.provider_id && provider.enabled))
  const stale = !!detail && source.kind === 'note' && detail.quote !== expectedNoteText
  return <div className="knowledge-suggestion-editor">
    <p className="muted">仅发送此条已保存的文字（{quoteLength} 字符），每次最多 12000 字符。不发送整本材料或已有知识库。模型生成最多 8 个候选，确认前不写入知识点。</p>
    <label>提议模型<select aria-label="知识提议模型" disabled={busy} value={modelId} onChange={event => setModelId(event.target.value)}><option value="">选择模型</option>{available.map(model => <option key={model.id} value={model.id}>{providers.find(provider => provider.id === model.provider_id)?.name} / {model.display_name || model.model_id}</option>)}</select></label>
    {!available.length && <p className="muted">请先在设置添加供应商与模型。</p>}
    <button className="primary" disabled={busy || disabled || !modelId || !quoteLength || quoteLength > 12_000 || jobs.some(job => job.status === 'running')} onClick={() => void act('start')}>生成知识候选（发送文字）</button>
    {quoteLength > 12_000 && <p className="material-error">此条目超过 12000 字符，请先拆分后提议。</p>}
    {error && <p className="material-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!!jobs.length && <label>提议记录<select aria-label="知识提议记录" disabled={busy} value={selected} onChange={event => setSelected(event.target.value)}>{jobs.map(job => <option key={job.id} value={job.id}>{knowledgeStatuses[job.status]} · {job.model_id} · {new Date(job.created_at).toLocaleString()}</option>)}</select></label>}
    <button disabled={busy} onClick={() => { void refresh(); setDetailVersion(value => value + 1) }}>重新载入提议记录</button>
    {detail && <div className="knowledge-suggestion-result">
      <p role="status">{knowledgeStatuses[detail.status]} · {detail.provider_name} / {detail.model_id}</p>
      <p>{detail.source_title} · {detail.location}</p>
      <details><summary>核对本次发送的来源文字</summary><blockquote>{detail.quote}</blockquote></details>
      {detail.error && <p className="material-error">{detail.error}</p>}
      {stale && <p className="material-error">笔记文字与本次来源不同，保留此快照供核对；请保存并重新生成后采纳。</p>}
      {detail.status === 'running' && <button disabled={busy} onClick={() => void act('cancel')}>取消知识提议</button>}
      {detail.candidates?.length === 0 && <p>本次没有找到可核对的知识候选，可以手动建立引用。</p>}
      {detail.candidates?.map((candidate, index) => {
        const adopted = detail.adoptions.find(item => item.candidate_index === index)
        return <article className="knowledge-candidate" key={`${detail.id}:${index}`}>
          <h4>候选 {index + 1} · {candidate.name}</h4><p className="muted">AI 建议，名称相同仍需核对含义与条件。</p><blockquote>{candidate.excerpt}</blockquote>
          {adopted ? <p role="status">已采纳 · <Link to={`/knowledge?concept=${encodeURIComponent(adopted.concept_id)}`}>打开知识点</Link>{!adopted.evidence_id && ' · 证据已另行移除，不会自动重建'}</p>
            : detail.status === 'ready' ? <CandidateReview candidate={candidate} index={index} suggestion={detail} disabled={busy || disabled || stale} onAdopt={input => void act('start', input)} />
              : <p>{candidate.summary}</p>}
        </article>
      })}
      {detail.status === 'ready' && <button disabled={busy} onClick={() => void act('dismiss')}>放弃剩余知识候选</button>}
    </div>}
  </div>
}
function CandidateReview({ candidate, index, suggestion, disabled, onAdopt }: { candidate: KnowledgeCandidate; index: number; suggestion: KnowledgeSuggestionDetail; disabled: boolean; onAdopt: (input: KnowledgeAdoptInput) => void }) {
  const { items, load } = useConceptStore(), subjects = useAppStore(state => state.subjects)
  const [target, setTarget] = useState(''), [name, setName] = useState(candidate.name), [summary, setSummary] = useState(candidate.summary), [aliases, setAliases] = useState(candidate.aliases.join('\n'))
  const [subject, setSubject] = useState(suggestion.source_subject_id ?? ''), [role, setRole] = useState(candidate.role), [memo, setMemo] = useState('')
  useEffect(() => { void load() }, [load])
  const names = [candidate.name, ...candidate.aliases].map(conceptKey)
  const matches = items.filter(item => (!suggestion.source_subject_id || !item.subject_id || item.subject_id === suggestion.source_subject_id) && [item.name, ...item.aliases].some(value => names.includes(conceptKey(value))))
  const existing = items.find(item => item.id === target)
  return <form className="knowledge-candidate-review" onSubmit={event => {
    event.preventDefault()
    if (disabled || (target !== 'new' && !existing)) return
    onAdopt({ suggestion_id: suggestion.id, candidate_index: index, role, memo, target: target === 'new' ? { kind: 'new', concept: { name, summary, aliases: aliases.split(/\r?\n/).map(value => value.trim()).filter(Boolean), subject_id: subject || null } } : { kind: 'existing', concept_id: existing!.id, expected_revision: existing!.revision } })
  }}>
    {!!matches.length && <p>同名或别名匹配：{matches.map(item => item.name).join('、')}。请先核对已有知识点。</p>}
    <label>采纳到<select aria-label={`候选 ${index + 1} 处理方式`} disabled={disabled} value={target} onChange={event => setTarget(event.target.value)}><option value="">选择已有知识点或新建</option><option value="new">新建知识点并保留证据</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {subjects.find(s => s.id === item.subject_id)?.name ?? '通用概念'}</option>)}</select></label>
    {target === 'new' && <>
      <label>名称<input aria-label={`候选 ${index + 1} 名称`} disabled={disabled} value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label>学科<select aria-label={`候选 ${index + 1} 学科`} disabled={disabled} value={subject} onChange={event => setSubject(event.target.value)}><option value="">通用概念</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>释义<textarea aria-label={`候选 ${index + 1} 释义`} disabled={disabled} value={summary} maxLength={4000} onChange={event => setSummary(event.target.value)} /></label>
      <label>核对后的别名<textarea aria-label={`候选 ${index + 1} 别名`} disabled={disabled} value={aliases} maxLength={2500} onChange={event => setAliases(event.target.value)} placeholder="每行一个；仅保留含义一致的名字" /></label>
    </>}
    {existing && <div><strong>{existing.name}</strong><p>{existing.summary || '暂无释义，请先核对含义。'}</p><p className="muted">本次只增加来源证据；已有释义和别名保留。<Link to={`/knowledge?concept=${encodeURIComponent(existing.id)}`}>打开核对</Link></p><button type="button" disabled={disabled} onClick={() => void load()}>重新载入知识点</button></div>}
    <label>引用角色<select aria-label={`候选 ${index + 1} 引用角色`} disabled={disabled} value={role} onChange={event => setRole(event.target.value as KnowledgeCandidate['role'])}>{Object.entries(evidenceRoles).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    <label>引用说明<textarea aria-label={`候选 ${index + 1} 引用说明`} disabled={disabled} maxLength={2000} value={memo} onChange={event => setMemo(event.target.value)} /></label>
    <button className="primary" disabled={disabled || !target || (target === 'new' ? !name.trim() : !existing)}>确认并采纳候选 {index + 1}</button>
  </form>
}
