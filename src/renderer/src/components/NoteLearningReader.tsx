import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { LearningEntry, LearningOperation, NoteLearningDocument, NoteLearningSyncPreview } from '@shared/types'
import { entryText, learningTypes } from '@shared/learning-document'
import { MarkdownSegment } from './MarkdownSegment'
import { materialHref, materialLocation } from '../utils/material'
import { LearningEntryEditor } from './LearningEntryEditor'
import { LearningFormulaContent } from './LearningFormulaContent'
import { NoteLearningSync } from './NoteLearningSync'
import './learning-reader.css'

export function NoteLearningReader({ noteId, onOpenOriginal }: { noteId: string; onOpenOriginal: () => void }) {
  const [document, setDocument] = useState<NoteLearningDocument | null>(null)
  const [revision, setRevision] = useState(''), [refresh, setRefresh] = useState(0)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [type, setType] = useState(''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState<string | null>(null)
  const [chapter, setChapter] = useState(''), [focused, setFocused] = useState('')
  const [navigation, setNavigation] = useState(0)
  const [preview, setPreview] = useState<NoteLearningSyncPreview | null>(null)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    void window.api.notes.learningGet({ note_id: noteId, ...(revision ? { revision_id: revision } : {}) }).then(result => {
      if (!alive) return
      if (result.ok) { setDocument(result.data); setOffset(0); setEditing(null); setPreview(null) } else setError(result.error)
      setLoading(false)
    })
    return () => { alive = false }
  }, [noteId, revision, refresh])
  const sources = useMemo(() => new Map(document?.sources.map(source => [source.id, source]) ?? []), [document])
  const allRows = useMemo(() => {
    const byId = new Map(document?.state.entries.map(entry => [entry.id, entry]) ?? []), paths = new Map<string, LearningEntry[]>()
    return document?.state.entries.map((entry, index) => {
      const parent = entry.parent_id ? byId.get(entry.parent_id)! : null, path = parent ? [...(paths.get(parent.id) ?? []), parent] : []
      paths.set(entry.id, path)
      return { entry, index, text: entryText(entry, sources), path }
    }) ?? []
  }, [document, sources])
  const rows = useMemo(() => allRows.filter(({ entry, text, path }) => (!type || entry.type === type) && (!query || `${entry.title}\n${text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!chapter || (chapter === 'root' ? !path.length && entry.type !== 'section' : entry.id === chapter || path.some(parent => parent.id === chapter)))), [allRows, type, query, chapter])
  useEffect(() => { if (focused) window.document.getElementById(`note-learning-${focused}`)?.scrollIntoView({ block: 'center' }) }, [focused, offset, query, type, chapter, navigation])
  const current = document?.revision_id === document?.current_revision_id
  const jump = (id: string) => { const index = allRows.findIndex(row => row.entry.id === id); if (index < 0) return; setQuery(''); setType(''); setChapter(''); setOffset(Math.floor(index / 100) * 100); setFocused(id); setNavigation(value => value + 1) }
  const update = (next: NoteLearningDocument) => { setDocument(next); setEditing(null); setPreview(null); setRevision(''); setRefresh(value => value + 1) }
  const change = async (entryId: string, operation: LearningOperation) => {
    if (!document || operation.action === 'figure' || operation.action === 'figure-remove') return
    setBusy(true); setError('')
    try { const result = await window.api.notes.learningChange({ note_id: noteId, expected_revision_id: document.revision_id, entry_id: entryId, ...operation }); if (result.ok) update(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const showPreview = async () => {
    setBusy(true); setError('')
    try { const result = await window.api.notes.learningPreview(noteId); if (result.ok) setPreview(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const confirmSync = async () => {
    if (!preview) return
    setBusy(true); setError('')
    try { const result = await window.api.notes.learningSync({ note_id: noteId, expected_revision_id: preview.base_revision_id, fingerprint: preview.fingerprint }); if (result.ok) update(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  return <section className="learning-reader" aria-label="笔记统一格式">
    <p className="learning-intro muted">整理稿与教材共用条目格式，可整理类型、章节、证明归属及公式。展开来源可核对原始转写和教材位置；修改正文请切回段落视图。新来源涉及人工结构时先核对同步预览。</p>
    <div className="toolbar learning-toolbar">
      <button disabled={loading || busy} onClick={() => { setRevision(''); setRefresh(value => value + 1) }}>读取最新笔记</button>
      <select aria-label="笔记修订" disabled={loading || busy} value={revision} onChange={event => setRevision(event.target.value)}>
        <option value="">最新笔记</option>
        {document?.history.map((item, index) => <option key={item.id} value={item.id}>修订 {document.history.length - index} · {new Date(item.created_at).toLocaleString()}</option>)}
      </select>
      <select aria-label="笔记章节筛选" value={chapter} onChange={event => { setChapter(event.target.value); setOffset(0) }}><option value="">全部章节</option><option value="root">未分章正文</option>{allRows.filter(row => row.entry.type === 'section').map(row => <option key={row.entry.id} value={row.entry.id}>{'　'.repeat(row.path.length)}{row.entry.title || '未命名章节'}</option>)}</select>
      <select aria-label="笔记条目类型" value={type} onChange={event => { setType(event.target.value); setOffset(0) }}>
        <option value="">全部类型</option>{Object.entries(learningTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input aria-label="检索整理稿" placeholder="检索整理稿" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
    </div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p className="muted">正在读取统一文档…</p> : document && <>
      <p className="muted">{document.title} · {document.state.entries.length} 个条目 · 当前显示 {rows.length} 条 · 快照保存于 {new Date(document.created_at).toLocaleString()}</p>
      {!document.state.entries.length && <p className="empty">笔记尚无段落；先添加内容或继续课堂转写。</p>}
      {!current && <p className="muted">历史修订只读。读取最新笔记后可继续整理。</p>}
      {current && document.pending_sync && <aside className="learning-sync-notice"><p>新来源变化涉及已整理的条目，当前人工结构已保留。先预览并确认同步，再继续编辑。</p><button disabled={busy} onClick={() => void showPreview()}>预览来源变化</button></aside>}
      {preview && <NoteLearningSync key={preview.fingerprint} document={document} preview={preview} busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void confirmSync()} />}
      <details className="learning-outline"><summary>笔记章节目录</summary><nav>{allRows.filter(row => row.entry.type === 'section').map(row => <button key={row.entry.id} onClick={() => jump(row.entry.id)}>{'　'.repeat(row.path.length)}{row.entry.title || '未命名章节'}</button>)}</nav></details>
      {rows.slice(offset, offset + 100).map(({ entry, text, index, path }) => {
        const related = document.state.relations.find(relation => relation.from === entry.id), target = related && document.state.entries.find(item => item.id === related.to)
        return <article id={`note-learning-${entry.id}`} className={`learning-entry learning-${entry.type}`} key={entry.id}>
          {!!path.length && <div className="learning-breadcrumb">{path.map(parent => <button key={parent.id} onClick={() => jump(parent.id)}>{parent.title || '未命名章节'}</button>)}</div>}
          <div className="learning-entry-heading"><span className="learning-type">{learningTypes[entry.type]}</span><h3>{entry.title}</h3><span className="muted">{entry.analysis.method === 'ai' ? `AI 整理 · ${entry.analysis.model}` : entry.analysis.method === 'manual' ? '人工编辑' : '初始记录'} · {entry.analysis.review_status === 'confirmed' ? '人工保存' : '待核对'}</span></div>
          <div className="learning-entry-text">{entry.formulas?.length ? <LearningFormulaContent text={text} formulas={entry.formulas} subjectId={document.subject_id} /> : <MarkdownSegment text={text} subjectId={document.subject_id} />}</div>
          <details><summary>原始转写与来源</summary>
            {[...new Set(entry.sources.map(ref => ref.source_id))].map(sourceId => { const origin = document.origins[sourceId]; return <div key={sourceId}>
            <p className="muted">记录时间 {new Date(origin.recorded_at).toLocaleString()} · 段落版本 {origin.segment_revision}（记录时间不代表录音时间轴）</p>
            {origin.organized_by === 'ai' && <p className="muted">整理来源：{origin.model ?? '旧记录未保存模型'}</p>}
            <div className="learning-entry-text">{origin.raw_text || '（原文为空）'}</div>
            {origin.material_ref && <Link to={materialHref(origin.material_ref.material_id, origin.material_ref)}>{origin.material_ref.material_title} · {materialLocation(origin.material_ref)}</Link>}
            <p><Link onClick={onOpenOriginal} to={`/notes/${noteId}?segment=${encodeURIComponent(origin.segment_id)}&view=raw`}>打开当前原文段落（可能已修改或删除）</Link></p>
            </div> })}
          </details>
          {target && <p className="learning-relation">{related!.type === 'proves' ? '证明' : '解答'}对象：<button onClick={() => jump(target.id)}>{target.title || learningTypes[target.type]}</button></p>}
          {current && !document.pending_sync && <button disabled={busy} onClick={() => setEditing(editing === entry.id ? null : entry.id)}>{editing === entry.id ? '收起整理' : '整理条目'}</button>}
          {current && !document.pending_sync && editing === entry.id && <LearningEntryEditor key={`${document.revision_id}:${entry.id}`} entry={entry} text={text} state={document.state} first={!index} busy={busy} onOperation={operation => change(entry.id, operation)} />}
        </article>
      })}
      {rows.length > 100 && <div className="toolbar"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一组</button><span>{Math.floor(offset / 100) + 1} / {Math.ceil(rows.length / 100)}</span><button disabled={offset + 100 >= rows.length} onClick={() => setOffset(value => value + 100)}>下一组</button></div>}
      {!!document.state.entries.length && !rows.length && <p className="empty">没有匹配的笔记条目。</p>}
    </>}
  </section>
}
