import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { ConceptBacklink, ConceptInput } from '@shared/types'
import { conceptKey } from '@shared/concept-matcher'
import { useAppStore } from '../stores/app'
import { useConceptStore } from '../stores/concepts'
import './knowledge.css'

const empty = (): ConceptInput => ({ name: '', aliases: [], summary: '', subject_id: null })
export function KnowledgePage() {
  const { items, load, error } = useConceptStore()
  const { subjects, showToast } = useAppStore()
  const [params, setParams] = useSearchParams()
  const id = params.get('concept') ?? ''
  const selected = items.find(c => c.id === id)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<ConceptInput>(empty)
  const [aliases, setAliases] = useState('')
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)
  const [refs, setRefs] = useState<ConceptBacklink[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [scanned, setScanned] = useState(0)
  const [loadingRefs, setLoadingRefs] = useState(false)
  const request = useRef(0)
  const [refsError, setRefsError] = useState('')

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    setDraft(selected ? { id: selected.id, revision: selected.revision, name: selected.name, summary: selected.summary ?? '', aliases: selected.aliases, subject_id: selected.subject_id } : empty())
    setAliases(selected?.aliases.join('\n') ?? '')
  }, [id, selected?.revision])
  useEffect(() => {
    setRefs([]); setNext(null); setScanned(0); setRefsError(''); setLoadingRefs(false)
    const token = ++request.current
    if (!selected) return
    setLoadingRefs(true)
    void window.api.concepts.references({ id: selected.id }).then(result => {
      if (request.current !== token) return
      setLoadingRefs(false)
      if (result.ok) { setRefs(result.data.items); setNext(result.data.next_offset); setScanned(result.data.scanned) }
      else setRefsError(result.error)
    })
    return () => { request.current++ }
  }, [selected?.id, items])
  const more = async (): Promise<void> => {
    if (next === null || loadingRefs) return
    const token = ++request.current
    setLoadingRefs(true)
    const result = await window.api.concepts.references({ id, offset: next })
    if (request.current !== token) return
    setLoadingRefs(false)
    if (!result.ok) { setRefsError(result.error); return }
    setRefs(previous => [...previous, ...result.data.items]); setNext(result.data.next_offset); setScanned(previous => previous + result.data.scanned)
  }
  const save = async (): Promise<void> => {
    if (saveLock.current) return
    saveLock.current = true; setSaving(true)
    try {
      const result = await window.api.concepts.save({ ...draft, name: draft.name.trim(), aliases: aliases.split(/\r?\n/).map(s => s.trim()).filter(Boolean) })
      if (!result.ok) { showToast(result.error); return }
      await load(); setParams({ concept: result.data.id }); showToast('概念已保存，正文关联已更新')
    } finally { saveLock.current = false; setSaving(false) }
  }
  const needle = conceptKey(query.trim())
  const filtered = items.filter(c => [c.name, ...c.aliases, c.summary ?? ''].some(s => conceptKey(s).includes(needle)))
  return <div className="page knowledge-page">
    <h1>知识与概念</h1>
    <p className="muted">为同一定理、方法和知识点登记不同名称，材料和笔记中的提及会自动关联。</p>
    {error && <p role="alert">{error}</p>}
    <div className="knowledge-workspace">
      <aside className="concept-list" aria-label="概念列表">
        <div className="toolbar"><button disabled={saving} onClick={() => { setParams({}); setDraft(empty()); setAliases('') }}>新建概念</button><button disabled={saving} onClick={() => void load()}>重新载入</button></div>
        <input aria-label="搜索概念与别名" value={query} onChange={e => setQuery(e.target.value)} placeholder="名称、别名或释义" />
        {!filtered.length && <p className="muted">尚无匹配概念。可新建并登记已确认的别名。</p>}
        {filtered.map(c => <button key={c.id} className={`concept-row ${c.id === id ? 'selected' : ''}`} disabled={saving} onClick={() => setParams({ concept: c.id })}><strong>{c.name}</strong><span>{subjects.find(s => s.id === c.subject_id)?.name ?? '通用概念'}</span>{c.aliases.length > 0 && <small>{c.aliases.join('、')}</small>}</button>)}
      </aside>
      <section className="concept-detail" aria-label="概念详情">
        {id && !selected ? <p>概念不存在，或正在载入。请重新载入或选择其他概念。</p> : <>
          <h2>{selected ? '概念详情' : '新建概念'}</h2>
          <form onSubmit={e => { e.preventDefault(); void save() }}>
            <label>主名称<input required maxLength={120} value={draft.name} disabled={saving} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>适用学科<select value={draft.subject_id ?? ''} disabled={saving} onChange={e => setDraft({ ...draft, subject_id: e.target.value || null })}><option value="">通用概念（所有学科）</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>已确认别名<textarea aria-label="已确认别名" value={aliases} disabled={saving} onChange={e => setAliases(e.target.value)} placeholder="每行一个名称；只登记含义相同的名字" rows={3} /></label>
            <label>释义<textarea maxLength={4000} value={draft.summary} disabled={saving} onChange={e => setDraft({ ...draft, summary: e.target.value })} placeholder="说明含义、适用条件及与同名概念的区别" rows={4} /></label>
            <p className="muted">登记后，主名称和别名都能自动关联。同名多义会列出候选，不会自动合并。AI 发现别名尚未接入。</p>
            <button className="primary" type="submit" disabled={saving || !draft.name.trim()}>{saving ? '正在保存…' : '保存概念'}</button>
          </form>
          {selected && <section className="concept-references" aria-label="概念提及">
            <h2>材料与笔记中的提及</h2>
            <p className="muted">已扫描 {scanned} 个文字块；{next === null && !loadingRefs ? '本次扫描完成。' : '可继续查找。'}仅列出含义明确的提及，每个来源字段显示首次命中；包含材料历史版本。</p>
            {refsError && <p role="alert">{refsError}</p>}
            {!refs.length && !loadingRefs && <p className="muted">已扫描范围内暂无明确关联。</p>}
            {refs.map(ref => <article key={`${ref.type}-${ref.id}-${ref.field}`}><Link to={ref.type === 'note' ? `/notes/${ref.parent_id}?segment=${ref.id}` : `/library?material=${ref.material_id}&version=${ref.parent_id}&block=${ref.id}&offset=${Math.floor(ref.ordinal! / 100) * 100}`}>{ref.title} · {ref.type === 'note' ? ref.field === 'raw_text' ? '笔记原文' : '笔记整理' : `材料条目 ${ref.ordinal! + 1}`}</Link><p>{ref.text}</p></article>)}
            {loadingRefs && <p role="status">正在查找…</p>}
            {next !== null && <button disabled={loadingRefs} onClick={() => void more()}>继续查找后 300 个文字块</button>}
          </section>}
        </>}
      </section>
    </div>
  </div>
}
