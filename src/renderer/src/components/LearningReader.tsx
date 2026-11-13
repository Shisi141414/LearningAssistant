import { LearningEntryEditor } from './LearningEntryEditor'
import { LearningPdfExport } from './LearningPdfExport'
import { useEffect, useMemo, useState } from 'react'
import type { LearningChange, LearningDocument, LearningEntry, LearningSource, MaterialLocator } from '@shared/types'
import { entryText, learningTypes } from '@shared/learning-document'
import { MarkdownSegment } from './MarkdownSegment'
import { PdfPage } from './PdfPage'
import './learning-reader.css'
import { LearningSuggestions } from './LearningSuggestions'
import { KnowledgeEvidence } from './KnowledgeEvidence'
import { LearningFormulaContent } from './LearningFormulaContent'
import { LearningAssetPanel, LearningEntryFigures, LearningFigureEditor, learningAssetLocation } from './LearningFigures'
import { Link } from 'react-router-dom'

function sourceLabel(source: LearningSource): string {
  const locator = JSON.parse(source.locator_json) as MaterialLocator
  return locator.page ? `PDF 第 ${locator.page} 页` : locator.slide ? `幻灯片 ${locator.slide}` : `来源段落 ${source.ordinal + 1}`
}
export function LearningReader({ materialId, versionId, subjectId, initialRevisionId = '', targetEntryId = '', archived = false }: { materialId: string; versionId: string; subjectId: string | null; initialRevisionId?: string; targetEntryId?: string; archived?: boolean }) {
  const [document, setDocument] = useState<LearningDocument | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false), [exportMessage, setExportMessage] = useState('')
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [type, setType] = useState('')
  const [offset, setOffset] = useState(0), [editing, setEditing] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ label: string; locator: MaterialLocator } | null>(null)
  const [chapter, setChapter] = useState(''), [focusedEntry, setFocusedEntry] = useState(targetEntryId)
  const [navigation, setNavigation] = useState(0)
  const [importedExercise, setImportedExercise] = useState('')
  const addExercise = async (entryId: string): Promise<void> => {
    if (!document || busy) return
    setBusy(true); setError(''); setImportedExercise('')
    try {
      const result = await window.api.exercises.import({ material_id: materialId, version_id: versionId, revision_id: document.revision_id, entry_id: entryId })
      if (result.ok) setImportedExercise(result.data.id); else setError(result.error)
    } finally { setBusy(false) }
  }
  useEffect(() => {
    let alive = true
    void window.api.learning.get({ version_id: versionId, ...(initialRevisionId ? { revision_id: initialRevisionId } : {}) }).then(result => {
      if (!alive) return
      setLoading(false)
      if (result.ok) {
        setDocument(result.data)
        const index = result.data?.state.entries.findIndex(entry => entry.id === targetEntryId) ?? -1
        if (targetEntryId && index < 0) setError('所引修订中没有此条目，请核对引用链接')
        else if (index >= 0) setOffset(Math.floor(index / 100) * 100)
      } else setError(result.error)
    })
    return () => { alive = false }
  }, [versionId, initialRevisionId, targetEntryId])
  useEffect(() => { if (focusedEntry && document) window.document.getElementById(`learning-${focusedEntry}`)?.scrollIntoView({ block: 'center' }) }, [document?.revision_id, focusedEntry, offset, navigation])
  const sources = useMemo(() => new Map(document?.sources.map(source => [source.id, source]) ?? []), [document])
  const rows = useMemo(() => {
    const paths = new Map<string, LearningEntry[]>(), byId = new Map(document?.state.entries.map(entry => [entry.id, entry]) ?? [])
    return document?.state.entries.map((entry, index) => {
      const parent = entry.parent_id ? byId.get(entry.parent_id)! : null
      const path = parent ? [...(paths.get(parent.id) ?? []), parent] : []
      paths.set(entry.id, path)
      return { entry, index, text: entryText(entry, sources), path }
    }) ?? []
  }, [document, sources])
  const sections = rows.filter(row => row.entry.type === 'section')
  const filtered = useMemo(() => rows.filter(row => (!chapter || (chapter === 'root' ? !row.entry.parent_id && row.entry.type !== 'section' : row.entry.id === chapter || row.path.some(parent => parent.id === chapter))) && (!type || row.entry.type === type) && (!query.trim() || (row.text + '\n' + row.entry.title + '\n' + (row.entry.formulas ?? []).map(formula => formula.latex).join('\n') + '\n' + (row.entry.figures ?? []).map(figure => figure.caption).join('\n')).toLowerCase().includes(query.trim().toLowerCase()))), [rows, type, query, chapter])
  const jump = (id: string): void => {
    const index = document?.state.entries.findIndex(entry => entry.id === id) ?? -1
    if (index < 0) return
    setType(''); setQuery(''); setChapter(''); setOffset(Math.floor(index / 100) * 100); setFocusedEntry(id); setNavigation(value => value + 1)
  }
  const current = document?.current_revision_id === document?.revision_id
  const prepare = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.prepare(versionId); if (result.ok) setDocument(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const revision = async (id?: string): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.get({ version_id: versionId, ...(id ? { revision_id: id } : {}) }); if (result.ok) { setDocument(result.data); setEditing(null); setOffset(0); setChapter(''); setFocusedEntry('') } else setError(result.error) }
    finally { setBusy(false) }
  }
  const change = async (input: LearningChange): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.learning.change(input); if (result.ok) { setDocument(result.data); setEditing(null) } else setError(result.error) }
    finally { setBusy(false) }
  }
  const exportPackage = async (): Promise<void> => {
    if (!document) return
    setBusy(true); setExporting(true); setError(''); setExportMessage('')
    try {
      const result = await window.api.learning.packageExport({ version_id: versionId, revision_id: document.revision_id })
      if (!result.ok) setError(result.error)
      else if (result.data) setExportMessage(`已保存 ${result.data.file_name}（${(result.data.byte_length / 1024 / 1024).toFixed(2)} MiB），含所选修订、原件、附件及相关已确认概念。`)
      else setExportMessage('已取消保存。')
    } finally { setBusy(false); setExporting(false) }
  }
  if (loading) return <p role="status">正在读取学习文档…</p>
  return <section className="learning-reader" aria-label="学习文档">
    {error && <p className="material-error" role="alert">{error}</p>}
    {exportMessage && <p role="status">{exportMessage}</p>}
    {importedExercise && <p role="status">习题已在库中，已有答案会保留。<Link to={`/exercises/${importedExercise}`}>打开习题 →</Link></p>}
    {!document ? initialRevisionId ? <p>无法打开指定学习修订。<button disabled={busy} onClick={() => void revision()}>读取当前修订</button></p> : <div className="learning-intro"><h3>先保留来源，再整理语义</h3><p>从原件建立连续的来源文字，再把同页内容拆为定义、定理、证明等条目。原有课堂引用会保留。</p><p className="muted">扫描 PDF 请先识别需要的页面；本步不会自动 OCR，也不会自动判断内容类型。</p><button className="primary" disabled={busy || archived} onClick={() => void prepare()}>{busy ? '正在建立来源文字…' : '建立学习文档'}</button></div> : <>
      <div className="toolbar learning-toolbar">
        <label>修订 <select aria-label="学习文档修订" disabled={busy} value={document.revision_id} onChange={e => void revision(e.target.value)}>{document.history.map((item, i) => <option key={item.id} value={item.id}>修订 {document.history.length - i}{item.id === document.current_revision_id ? '（当前）' : ''} · {new Date(item.created_at).toLocaleTimeString()}</option>)}</select></label>
        <select aria-label="学习条目类型筛选" value={type} onChange={e => { setType(e.target.value); setOffset(0) }}><option value="">全部类型</option>{Object.entries(learningTypes).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
        <select aria-label="学习章节筛选" value={chapter} onChange={event => { setChapter(event.target.value); setOffset(0) }}><option value="">全部章节</option><option value="root">未分章正文</option>{sections.map(row => <option key={row.entry.id} value={row.entry.id}>{'　'.repeat(row.path.length)}{row.entry.title || `章节 · 第 ${row.index + 1} 条`}</option>)}</select>
        <input aria-label="搜索学习条目" value={query} placeholder="搜索标题或正文…" onChange={e => { setQuery(e.target.value); setOffset(0) }} />
        <button disabled={busy} onClick={() => void revision()}>刷新当前修订</button>
        <button disabled={busy || !!editing} onClick={() => void exportPackage()}>导出所选修订</button>
        {exporting && <><span role="status">正在保存所选修订与原件…</span><button onClick={() => void window.api.learning.packageExportCancel(versionId).then(result => { if (!result.ok) setError(result.error) })}>取消导出</button></>}
      </div>
      <p className="muted">{filtered.length} 个条目 · {document.state.entries.filter(e => e.analysis.review_status === 'unreviewed').length} 个待整理{!current && ' · 历史修订只读'}</p>
      <LearningPdfExport source={{ kind: 'material', version_id: versionId, revision_id: document.revision_id }} disabled={busy || !!editing} onBusy={setBusy} emptySources={document.sources.filter(source => !source.raw_text.trim()).length} />
      <LearningAssetPanel key={document.id} document={document} editable={!!current && !archived} busy={busy} onBusy={setBusy} onUpdated={setDocument} onError={setError} />
      <details className="learning-outline"><summary>章节目录 · {sections.length} 节</summary>{sections.length ? <nav aria-label="学习文档章节目录">{sections.map(row => <button key={row.entry.id} style={{ paddingLeft: `${row.path.length * 16 + 4}px` }} onClick={() => jump(row.entry.id)}>{row.entry.title || `章节 · 第 ${row.index + 1} 条`}</button>)}</nav> : <p className="muted">尚未设置章节。先把标题条目标为“章节”，再为后续条目设置章节归属。</p>}</details>
      {archived && <p className="muted">材料已归档，学习文档只读，已有引用仍可查看。</p>}
      {current && !archived && <LearningSuggestions document={document} subjectId={subjectId} onApplied={next => { setDocument(next); setEditing(null); setOffset(0) }} />}
      {!current && <button disabled={busy} onClick={() => void revision()}>回到当前修订</button>}
      {preview && <aside className="learning-source-preview"><div className="toolbar"><strong>{preview.label} · 原件对照</strong><button onClick={() => setPreview(null)}>关闭对照</button></div>{preview.locator.kind === 'pdf' ? <PdfPage versionId={versionId} pageNumber={preview.locator.page!} selection={preview.locator.crop ? { value: preview.locator.crop.rect, onChange: () => undefined, disabled: true, readOnly: true } : undefined} /> : <button onClick={() => void window.api.materials.open(versionId).then(r => { if (!r.ok) setError(r.error) })}>打开原件查看</button>}</aside>}
      {filtered.slice(offset, offset + 100).map(({ entry, index, text, path }) => {
        const related = document.state.relations.find(relation => relation.from === entry.id)
        const target = related && document.state.entries.find(e => e.id === related.to)
        return <article className={`learning-entry learning-${entry.type}${entry.id === focusedEntry ? ' evidence-target' : ''}`} id={`learning-${entry.id}`} key={entry.id}>
          {!!path.length && <div className="learning-breadcrumb" aria-label="所在章节">{path.map(parent => <button key={parent.id} onClick={() => jump(parent.id)}>{parent.title || '未命名章节'}</button>)}</div>}
          <div className="learning-entry-heading"><span className="muted">第 {index + 1} 条</span><span className="learning-type">{learningTypes[entry.type]}</span><h3>{entry.title || (entry.type === 'narrative' ? '待整理正文' : learningTypes[entry.type])}</h3><span className="muted" title={entry.analysis.method === 'ai' ? entry.analysis.model : undefined}>{entry.analysis.method === 'ai' ? entry.analysis.review_status === 'confirmed' ? 'AI 建议 · 已核对' : 'AI 建议 · 待核对' : entry.analysis.review_status === 'confirmed' ? '人工确认' : '待整理'}</span></div>
          <div className="learning-source-links">{entry.sources.map((ref, i) => <button key={`${ref.source_id}-${i}`} onClick={() => { const source = sources.get(ref.source_id)!; setPreview({ label: sourceLabel(source), locator: JSON.parse(source.locator_json) }) }}>{sourceLabel(sources.get(ref.source_id)!)}</button>)}</div>
          {text.trim() ? <div className="learning-entry-text">{entry.formulas?.length ? <LearningFormulaContent text={text} formulas={entry.formulas} subjectId={subjectId} /> : <MarkdownSegment text={text} subjectId={subjectId} />}</div> : <p className="muted">此来源尚无可提取文字，请对照原件；扫描页可先完成 OCR 后建立新版学习文档。</p>}
          {!!entry.formulas?.length && <details className="learning-formula-source"><summary>人工公式校正 · 查看来源原文</summary><p>{text}</p><p className="muted">本条知识证据及知识候选使用此来源原文；公式校正保留在当前修订中。</p></details>}
          {!!entry.figures?.length && <LearningEntryFigures figures={entry.figures} assets={document.assets ?? []} onLocate={asset => { setPreview({ label: learningAssetLocation(asset), locator: JSON.parse(asset.locator_json) }); requestAnimationFrame(() => window.document.querySelector('.learning-source-preview')?.scrollIntoView({ block: 'start' })) }} />}
          {target && <p className="learning-relation">{related.type === 'proves' ? '证明' : '解答'}对象：<button onClick={() => jump(target.id)}>{target.title || learningTypes[target.type]}</button></p>}
          {current && !archived && <button disabled={busy} onClick={() => setEditing(editing === entry.id ? null : entry.id)}>{editing === entry.id ? '收起整理' : '整理条目'}</button>}
          {['exercise','example'].includes(entry.type) && <button disabled={busy} onClick={() => void addExercise(entry.id)}>加入习题库</button>}
          {current && !archived && editing === entry.id && <EntryEditor key={`edit:${document.revision_id}:${entry.id}`} entry={entry} text={text} document={document} first={index === 0} busy={busy} onChange={change} />}
          <KnowledgeEvidence key={`evidence:${document.revision_id}:${entry.id}`} source={{ kind: 'learning', material_id: materialId, version_id: versionId, revision_id: document.revision_id, entry_id: entry.id }} title={entry.title} subjectId={subjectId} quoteLength={text.length} />
        </article>
      })}
      {!filtered.length && <p className="empty">没有匹配的学习条目。</p>}
      <div className="toolbar"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>上一组条目</button><span className="muted">{filtered.length ? offset + 1 : 0}–{Math.min(offset + 100, filtered.length)} / {filtered.length}</span><button disabled={offset + 100 >= filtered.length} onClick={() => setOffset(offset + 100)}>下一组条目</button></div>
    </>}
  </section>
}
function EntryEditor({ entry, text, document, first, busy, onChange }: { entry: LearningEntry; text: string; document: LearningDocument; first: boolean; busy: boolean; onChange: (input: LearningChange) => Promise<void> }) {
  const base = { version_id: document.version_id, expected_revision_id: document.current_revision_id, entry_id: entry.id }
  return <LearningEntryEditor entry={entry} text={text} state={document.state} first={first} busy={busy} onOperation={operation => onChange({ ...base, ...operation })} figures={<LearningFigureEditor document={document} figures={entry.figures} busy={busy} base={base} onChange={onChange} />} />
}
