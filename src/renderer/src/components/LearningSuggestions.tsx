import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LearningDocument, LearningSuggestion, LearningSuggestionDetail, NoteLearningDocument, NoteLearningSuggestion, NoteLearningSuggestionDetail, ModelInfo, Provider } from '@shared/types'
import { entryText, learningTypes } from '@shared/learning-document'
import { MarkdownSegment } from './MarkdownSegment'

const statuses: Record<LearningSuggestion['status'], string> = { running: '正在生成', ready: '等待审核', failed: '生成失败', cancelled: '已取消', applied: '已采纳', dismissed: '已放弃' }
type Props = { subjectId: string | null; disabled?: boolean; onReviewChange?: (opened: boolean) => void; onBusy?: (busy: boolean) => void } & (
  { kind?: 'material'; document: LearningDocument; onApplied: (document: LearningDocument) => void } |
  { kind: 'note'; document: NoteLearningDocument; onApplied: (document: NoteLearningDocument) => void }
)
export function LearningSuggestions(props: Props) {
  const [opened, setOpened] = useState(false)
  useEffect(() => { props.onReviewChange?.(opened); return () => props.onReviewChange?.(false) }, [opened, props.onReviewChange])
  return <details className="learning-suggestions" onToggle={event => setOpened(event.currentTarget.open)}><summary>AI 整理建议 <span className="muted">· 核对后采纳 · 保留人工确认内容</span></summary>{opened && <SuggestionEditor {...props} />}</details>
}
function SuggestionEditor(props: Props) {
  const { document, subjectId, disabled = false } = props
  const noteId = props.kind === 'note' ? props.document.note_id : undefined
  const versionId = props.kind !== 'note' ? props.document.version_id : undefined
  const [providers, setProviders] = useState<Provider[]>([]), [models, setModels] = useState<ModelInfo[]>([]), [modelId, setModelId] = useState('')
  const [jobs, setJobs] = useState<(LearningSuggestion | NoteLearningSuggestion)[]>([]), [selected, setSelected] = useState(''), [detail, setDetail] = useState<LearningSuggestionDetail | NoteLearningSuggestionDetail | null>(null)
  const [from, setFrom] = useState(1), [to, setTo] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sources = useMemo(() => new Map(document.sources.map(source => [source.id, source])), [document.sources])
  const available = models.filter(model => providers.some(provider => provider.id === model.provider_id && provider.enabled))
  const selectedJob = jobs.find(job => job.id === selected)
  const refresh = useCallback(async (): Promise<void> => {
    const result = noteId ? await window.api.notes.learningSuggestList(noteId) : await window.api.learning.suggestList(versionId!)
    if (result.ok) { setJobs(result.data); setSelected(previous => result.data.some(job => job.id === previous) ? previous : result.data[0]?.id ?? '') }
    else setError(result.error)
  }, [noteId, versionId])
  useEffect(() => {
    let alive = true
    void Promise.all([window.api.providers.list(), window.api.models.list()]).then(([p, m]) => {
      if (!alive) return
      if (p.ok) setProviders(p.data); else setError(p.error)
      if (m.ok) { setModels(m.data); if (p.ok) setModelId(m.data.find(model => p.data.some(provider => provider.id === model.provider_id && provider.enabled))?.id ?? '') }
      else setError(m.error)
    })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const first = document.state.entries.findIndex(entry => entry.analysis.review_status === 'unreviewed')
    setFrom(Math.max(1, first + 1)); setTo(Math.max(1, first + 1))
    void refresh()
  }, [document.current_revision_id, refresh])
  useEffect(() => {
    if (!jobs.some(job => job.status === 'running')) return
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
  }, [jobs, refresh])
  useEffect(() => {
    let alive = true
    setDetail(null)
    if (selected) void (noteId ? window.api.notes.learningSuggestGet(selected) : window.api.learning.suggestGet(selected)).then(result => { if (alive) { if (result.ok) setDetail(result.data); else setError(result.error) } })
    return () => { alive = false }
  }, [selected, selectedJob?.status, noteId])
  const valid = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from && to <= document.state.entries.length && to - from < 20
  const chosen = valid ? document.state.entries.slice(from - 1, to) : []
  const protectedRange = chosen.some(entry => entry.analysis.review_status === 'confirmed')
  const chapterConflict = chosen.some(entry => (entry.parent_id ?? null) !== (chosen[0]?.parent_id ?? null)) || document.state.entries.some(entry => entry.parent_id && chosen.some(parent => parent.id === entry.parent_id))
  const generate = async (): Promise<void> => {
    setBusy(true); props.onBusy?.(true); setError('')
    try {
      const input = { expected_revision_id: document.current_revision_id, entry_ids: chosen.map(entry => entry.id), model_db_id: modelId }
      const result = noteId ? await window.api.notes.learningSuggestStart({ ...input, note_id: noteId }) : await window.api.learning.suggestStart({ ...input, version_id: versionId! })
      if (result.ok) { setSelected(result.data.id); await refresh() } else setError(result.error)
    } finally { setBusy(false); props.onBusy?.(false) }
  }
  const act = async (action: 'apply' | 'dismiss' | 'cancel'): Promise<void> => {
    setBusy(true); props.onBusy?.(true); setError('')
    try {
      if (action === 'apply') {
        if (props.kind === 'note') {
          const result = await window.api.notes.learningSuggestApply(selected)
          if (result.ok) props.onApplied(result.data); else setError(result.error)
        } else {
          const result = await window.api.learning.suggestApply(selected)
          if (result.ok) props.onApplied(result.data); else setError(result.error)
        }
      } else {
        const api = noteId ? { dismiss: window.api.notes.learningSuggestDismiss, cancel: window.api.notes.learningSuggestCancel } : { dismiss: window.api.learning.suggestDismiss, cancel: window.api.learning.suggestCancel }
        const result = await api[action](selected)
        if (!result.ok) setError(result.error)
      }
      await refresh()
    } finally { setBusy(false); props.onBusy?.(false) }
  }
  return <div className="learning-suggestion-editor">
    <p className="muted">仅把所选待整理条目的文字发送给下方模型。每批最多 20 条、12000 字符；生成不改变当前文档。请先核对 OCR 错误。</p>
    <div className="toolbar"><label>模型 <select aria-label="语义整理模型" value={modelId} disabled={busy} onChange={e => setModelId(e.target.value)}><option value="">选择模型</option>{available.map(model => <option key={model.id} value={model.id}>{providers.find(provider => provider.id === model.provider_id)?.name} / {model.display_name || model.model_id}</option>)}</select></label></div>
    {!available.length && <p className="muted">请先到设置添加供应商并导入可用模型。</p>}
    <div className="toolbar"><label>从第 <input aria-label="AI 整理起始条目" type="number" min={1} max={document.state.entries.length} value={from} onChange={e => setFrom(Number(e.target.value))} /> 条</label><label>至第 <input aria-label="AI 整理结束条目" type="number" min={from} max={Math.min(from + 19, document.state.entries.length)} value={to} onChange={e => setTo(Number(e.target.value))} /> 条</label>
      <button className="primary" disabled={disabled || busy || !valid || !modelId || protectedRange || chapterConflict || jobs.some(job => job.status === 'running')} onClick={() => void generate()}>生成本批建议（发送文字）</button></div>
    {protectedRange && <p className="muted">范围内有已确认条目，请改选待整理内容。已确认内容不会交给 AI 重写。</p>}
    {chapterConflict && <p className="muted">请选同一父章节内的条目，不含仍有子项的章节；AI 不会改变已设置的目录。</p>}
    {error && <p className="material-error" role="alert">{error}</p>}
    {!!jobs.length && <div className="toolbar"><label>建议记录 <select aria-label="AI 整理建议记录" value={selected} onChange={e => setSelected(e.target.value)}>{jobs.map(job => <option key={job.id} value={job.id}>{statuses[job.status]} · {job.model_id} · {new Date(job.created_at).toLocaleTimeString()}</option>)}</select></label></div>}
    {detail && <div className="learning-suggestion-result">
      <p role="status">{statuses[detail.status]} · {detail.provider_name} / {detail.model_id}</p>
      {detail.error && <p className="material-error">{detail.error}</p>}
      {detail.status === 'running' && <button disabled={busy} onClick={() => void act('cancel')}>取消 AI 生成</button>}
      {detail.status === 'ready' && detail.proposal && <>
        <p className="muted">下方为本批候选。正文来自原始来源，AI 仅建议边界、类型、标题和证明/解答归属。</p>
        {detail.proposal.entries.map((entry, index) => {
          const relation = detail.proposal!.relations.find(r => r.from === entry.id), target = relation && detail.proposal!.entries.find(e => e.id === relation.to)
          return <article className={`learning-entry learning-${entry.type}`} key={entry.id}><div className="learning-entry-heading"><span className="learning-type">{learningTypes[entry.type]}</span><h3>{entry.title || `候选 ${index + 1}`}</h3><span className="muted">AI 建议 · 待核对</span></div><div className="learning-entry-text"><MarkdownSegment text={entryText(entry, sources)} subjectId={subjectId} /></div>{target && <p className="learning-relation">{relation.type === 'proves' ? '证明' : '解答'}对象：{target.title || learningTypes[target.type]}</p>}</article>
        })}
        {detail.base_revision_id !== document.current_revision_id && <p className="material-error">文档已更新，这份旧建议不能覆盖当前修订，请重新生成。</p>}
        <div className="toolbar"><button className="primary" disabled={disabled || busy || detail.base_revision_id !== document.current_revision_id} onClick={() => void act('apply')}>采纳为新修订</button><button disabled={busy} onClick={() => void act('dismiss')}>放弃建议</button></div>
      </>}
    </div>}
  </div>
}
