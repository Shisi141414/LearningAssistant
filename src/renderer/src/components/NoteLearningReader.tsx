import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { NoteLearningDocument } from '@shared/types'
import { entryText, learningTypes } from '@shared/learning-document'
import { MarkdownSegment } from './MarkdownSegment'
import { materialHref, materialLocation } from '../utils/material'
import './learning-reader.css'

export function NoteLearningReader({ noteId, onOpenOriginal }: { noteId: string; onOpenOriginal: () => void }) {
  const [document, setDocument] = useState<NoteLearningDocument | null>(null)
  const [revision, setRevision] = useState(''), [refresh, setRefresh] = useState(0)
  const [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [type, setType] = useState(''), [query, setQuery] = useState(''), [offset, setOffset] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    void window.api.notes.learningGet({ note_id: noteId, ...(revision ? { revision_id: revision } : {}) }).then(result => {
      if (!alive) return
      if (result.ok) { setDocument(result.data); setOffset(0) } else setError(result.error)
      setLoading(false)
    })
    return () => { alive = false }
  }, [noteId, revision, refresh])
  const sources = useMemo(() => new Map(document?.sources.map(source => [source.id, source]) ?? []), [document])
  const rows = useMemo(() => document?.state.entries.map(entry => ({ entry, text: entryText(entry, sources) }))
    .filter(({ entry, text }) => (!type || entry.type === type) && (!query || `${entry.title}\n${text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [], [document, sources, type, query])
  return <section className="learning-reader" aria-label="笔记统一格式">
    <p className="learning-intro muted">整理稿使用与教材相同的来源和条目格式。展开来源可核对原始转写、记录时间及教材位置；AI 整理尚需核对。此处阅读固定修订，编辑请切回段落视图。</p>
    <div className="toolbar learning-toolbar">
      <button disabled={loading} onClick={() => { setRevision(''); setRefresh(value => value + 1) }}>读取最新笔记</button>
      <select aria-label="笔记修订" disabled={loading} value={revision} onChange={event => setRevision(event.target.value)}>
        <option value="">最新笔记</option>
        {document?.history.map((item, index) => <option key={item.id} value={item.id}>修订 {document.history.length - index} · {new Date(item.created_at).toLocaleString()}</option>)}
      </select>
      <select aria-label="笔记条目类型" value={type} onChange={event => { setType(event.target.value); setOffset(0) }}>
        <option value="">全部类型</option>{Object.entries(learningTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input aria-label="检索整理稿" placeholder="检索整理稿" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
    </div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p className="muted">正在读取统一文档…</p> : document && !error && <>
      <p className="muted">{document.title} · {document.state.entries.length} 个条目 · 当前显示 {rows.length} 条 · 快照保存于 {new Date(document.created_at).toLocaleString()}</p>
      {!document.state.entries.length && <p className="empty">笔记尚无段落；先添加内容或继续课堂转写。</p>}
      {rows.slice(offset, offset + 100).map(({ entry, text }) => {
        const origin = document.origins[entry.sources[0].source_id]
        return <article className={`learning-entry learning-${entry.type}`} key={entry.id}>
          <div className="learning-entry-heading"><span className="learning-type">{learningTypes[entry.type]}</span><span className="muted">{origin.organized_by === 'ai' ? `AI 整理 · ${origin.model ?? '旧记录未保存模型'}` : origin.organized_by === 'user' ? '人工编辑' : '初始记录'} · {entry.analysis.review_status === 'confirmed' ? '人工保存' : '待核对'}</span></div>
          <div className="learning-entry-text"><MarkdownSegment text={text} subjectId={document.subject_id} /></div>
          <details><summary>原始转写与来源</summary>
            <p className="muted">记录时间 {new Date(origin.recorded_at).toLocaleString()} · 段落版本 {origin.segment_revision}（记录时间不代表录音时间轴）</p>
            <div className="learning-entry-text">{origin.raw_text || '（原文为空）'}</div>
            {origin.material_ref && <Link to={materialHref(origin.material_ref.material_id, origin.material_ref)}>{origin.material_ref.material_title} · {materialLocation(origin.material_ref)}</Link>}
            <p><Link onClick={onOpenOriginal} to={`/notes/${noteId}?segment=${encodeURIComponent(origin.segment_id)}&view=raw`}>打开当前原文段落（可能已修改或删除）</Link></p>
          </details>
        </article>
      })}
      {rows.length > 100 && <div className="toolbar"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一组</button><span>{Math.floor(offset / 100) + 1} / {Math.ceil(rows.length / 100)}</span><button disabled={offset + 100 >= rows.length} onClick={() => setOffset(value => value + 100)}>下一组</button></div>}
    </>}
  </section>
}
