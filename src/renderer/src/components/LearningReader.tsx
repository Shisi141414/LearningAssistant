import { useEffect, useMemo, useState } from 'react'
import type { LearningChange, LearningDocument, LearningEntry, LearningEntryType, LearningSource, MaterialLocator } from '@shared/types'
import { entryText, learningTypes, relationAllowed } from '@shared/learning-document'
import { MarkdownSegment } from './MarkdownSegment'
import { PdfPage } from './PdfPage'
import './learning-reader.css'

function sourceLabel(source: LearningSource): string {
  const locator = JSON.parse(source.locator_json) as MaterialLocator
  return locator.page ? `PDF 第 ${locator.page} 页` : locator.slide ? `幻灯片 ${locator.slide}` : `来源段落 ${source.ordinal + 1}`
}
export function LearningReader({ versionId, subjectId }: { versionId: string; subjectId: string | null }) {
  const [document, setDocument] = useState<LearningDocument | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [type, setType] = useState('')
  const [offset, setOffset] = useState(0), [editing, setEditing] = useState<string | null>(null)
  const [preview, setPreview] = useState<LearningSource | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.learning.get({ version_id: versionId }).then(result => {
      if (!alive) return
      setLoading(false); if (result.ok) setDocument(result.data); else setError(result.error)
    })
    return () => { alive = false }
  }, [versionId])
  const sources = useMemo(() => new Map(document?.sources.map(source => [source.id, source]) ?? []), [document])
  const rows = useMemo(() => document?.state.entries.map((entry, index) => ({ entry, index, text: entryText(entry, sources) })) ?? [], [document, sources])
  const filtered = useMemo(() => rows.filter(row => (!type || row.entry.type === type) && (!query.trim() || (row.text + '\n' + row.entry.title).toLowerCase().includes(query.trim().toLowerCase()))), [rows, type, query])
  const current = document?.current_revision_id === document?.revision_id
  const prepare = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.prepare(versionId); if (result.ok) setDocument(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const revision = async (id?: string): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.get({ version_id: versionId, ...(id ? { revision_id: id } : {}) }); if (result.ok) { setDocument(result.data); setEditing(null); setOffset(0) } else setError(result.error) }
    finally { setBusy(false) }
  }
  const change = async (input: LearningChange): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.change(input); if (result.ok) { setDocument(result.data); setEditing(null) } else setError(result.error) }
    finally { setBusy(false) }
  }
  if (loading) return <p role="status">正在读取学习文档…</p>
  return <section className="learning-reader" aria-label="学习文档">
    {error && <p className="material-error" role="alert">{error}</p>}
    {!document ? <div className="learning-intro"><h3>先保留来源，再整理语义</h3><p>从原件建立连续的来源文字，再把同页内容拆为定义、定理、证明等条目。原有课堂引用会保留。</p><p className="muted">扫描 PDF 请先识别需要的页面；本步不会自动 OCR，也不会自动判断内容类型。</p><button className="primary" disabled={busy} onClick={() => void prepare()}>{busy ? '正在建立来源文字…' : '建立学习文档'}</button></div> : <>
      <div className="toolbar learning-toolbar">
        <label>修订 <select aria-label="学习文档修订" disabled={busy} value={document.revision_id} onChange={e => void revision(e.target.value)}>{document.history.map((item, i) => <option key={item.id} value={item.id}>修订 {document.history.length - i}{item.id === document.current_revision_id ? '（当前）' : ''} · {new Date(item.created_at).toLocaleTimeString()}</option>)}</select></label>
        <select aria-label="学习条目类型筛选" value={type} onChange={e => { setType(e.target.value); setOffset(0) }}><option value="">全部类型</option>{Object.entries(learningTypes).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
        <input aria-label="搜索学习条目" value={query} placeholder="搜索标题或正文…" onChange={e => { setQuery(e.target.value); setOffset(0) }} />
        <button disabled={busy} onClick={() => void revision()}>刷新当前修订</button>
      </div>
      <p className="muted">{filtered.length} 个条目 · {document.state.entries.filter(e => e.analysis.review_status === 'unreviewed').length} 个待整理{!current && ' · 历史修订只读'}</p>
      {!current && <button disabled={busy} onClick={() => void revision()}>回到当前修订</button>}
      {preview && <aside className="learning-source-preview"><div className="toolbar"><strong>{sourceLabel(preview)} · 原件对照</strong><button onClick={() => setPreview(null)}>关闭对照</button></div>{(JSON.parse(preview.locator_json) as MaterialLocator).kind === 'pdf' ? <PdfPage versionId={versionId} pageNumber={(JSON.parse(preview.locator_json) as MaterialLocator).page!} /> : <button onClick={() => void window.api.materials.open(versionId).then(r => { if (!r.ok) setError(r.error) })}>打开原件查看</button>}</aside>}
      {filtered.slice(offset, offset + 100).map(({ entry, index, text }) => {
        const related = document.state.relations.find(relation => relation.from === entry.id)
        const target = related && document.state.entries.find(e => e.id === related.to)
        return <article className={`learning-entry learning-${entry.type}`} id={`learning-${entry.id}`} key={entry.id}>
          <div className="learning-entry-heading"><span className="learning-type">{learningTypes[entry.type]}</span><h3>{entry.title || (entry.type === 'narrative' ? '待整理正文' : learningTypes[entry.type])}</h3><span className="muted">{entry.analysis.review_status === 'confirmed' ? '人工确认' : '待整理'}</span></div>
          <div className="learning-source-links">{entry.sources.map((ref, i) => <button key={`${ref.source_id}-${i}`} onClick={() => setPreview(sources.get(ref.source_id)!)}>{sourceLabel(sources.get(ref.source_id)!)}</button>)}</div>
          {text.trim() ? <div className="learning-entry-text"><MarkdownSegment text={text} subjectId={subjectId} /></div> : <p className="muted">此来源尚无可提取文字，请对照原件；扫描页可先完成 OCR 后建立新版学习文档。</p>}
          {target && <p className="learning-relation">{related.type === 'proves' ? '证明' : '解答'}对象：<button onClick={() => { setType(''); setQuery(''); setOffset(Math.floor(document.state.entries.findIndex(e => e.id === target.id) / 100) * 100); setTimeout(() => window.document.getElementById(`learning-${target.id}`)?.scrollIntoView({ block: 'center' }), 50) }}>{target.title || learningTypes[target.type]}</button></p>}
          {current && <button disabled={busy} onClick={() => setEditing(editing === entry.id ? null : entry.id)}>{editing === entry.id ? '收起整理' : '整理条目'}</button>}
          {current && editing === entry.id && <EntryEditor key={document.revision_id + entry.id} entry={entry} text={text} document={document} first={index === 0} busy={busy} onChange={change} />}
        </article>
      })}
      {!filtered.length && <p className="empty">没有匹配的学习条目。</p>}
      <div className="toolbar"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>上一组条目</button><span className="muted">{filtered.length ? offset + 1 : 0}–{Math.min(offset + 100, filtered.length)} / {filtered.length}</span><button disabled={offset + 100 >= filtered.length} onClick={() => setOffset(offset + 100)}>下一组条目</button></div>
    </>}
  </section>
}
function EntryEditor({ entry, text, document, first, busy, onChange }: { entry: LearningEntry; text: string; document: LearningDocument; first: boolean; busy: boolean; onChange: (input: LearningChange) => Promise<void> }) {
  const [type, setType] = useState(entry.type), [title, setTitle] = useState(entry.title)
  const [position, setPosition] = useState<number | null>(null)
  const [target, setTarget] = useState(document.state.relations.find(r => r.from === entry.id)?.to ?? '')
  const base = { version_id: document.version_id, expected_revision_id: document.current_revision_id, entry_id: entry.id }
  const targets = document.state.entries.filter(e => e.id !== entry.id && relationAllowed(entry.type, e.type))
  const readPosition = (input: HTMLTextAreaElement): void => { setPosition(input.selectionStart === input.selectionEnd ? input.selectionStart : null) }
  return <div className="learning-editor">
    <div className="toolbar"><label>类型 <select aria-label="条目语义类型" value={type} disabled={busy} onChange={e => setType(e.target.value as LearningEntryType)}>{Object.entries(learningTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <input aria-label="学习条目标题" maxLength={500} placeholder="条目标题（可留空）" value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
      <button className="primary" disabled={busy} onClick={() => void onChange({ ...base, action: 'edit', type, title })}>保存类型与标题</button></div>
    <label>在来源文字中放置光标，确定拆分点<textarea aria-label="选择学习条目拆分位置" readOnly value={text} onSelect={e => readPosition(e.currentTarget)} onMouseUp={e => readPosition(e.currentTarget)} onKeyUp={e => readPosition(e.currentTarget)} /></label>
    <div className="toolbar"><button disabled={busy || position === null || position <= 0 || position >= text.length} onClick={() => void onChange({ ...base, action: 'split', position: position! })}>在光标处拆分</button><button disabled={busy || first} onClick={() => void onChange({ ...base, action: 'merge' })}>合并到上一条</button></div>
    <p className="muted">合并保留前一条的类型和标题；涉及证明/解答关联时，请先解除关联。每次保存生成新修订，来源正文保持不变。</p>
    {['proof', 'solution'].includes(entry.type) && <div className="toolbar"><label>{entry.type === 'proof' ? '证明对象' : '解答对象'} <select aria-label="学习条目关联目标" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="">未指定 / 解除关联</option>{targets.map(e => <option key={e.id} value={e.id}>{learningTypes[e.type]} · {e.title || `第 ${document.state.entries.indexOf(e) + 1} 条`}</option>)}</select></label><button disabled={busy} onClick={() => void onChange({ ...base, action: 'relate', target_id: target || null })}>保存关联</button></div>}
  </div>
}
