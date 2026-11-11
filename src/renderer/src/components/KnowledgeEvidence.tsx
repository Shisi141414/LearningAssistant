import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EvidenceListInput, EvidencePage, EvidenceRole, EvidenceSource } from '@shared/types'
import { evidenceHref, evidenceRoles, evidenceStatuses } from '@shared/evidence'
import { conceptKey } from '@shared/concept-matcher'
import { useConceptStore } from '../stores/concepts'
import { useAppStore } from '../stores/app'
import { MarkdownSegment } from './MarkdownSegment'
import './knowledge-evidence.css'
import { KnowledgeSuggestions } from './KnowledgeSuggestions'

const emptyPage = (): EvidencePage => ({ items: [], total: 0, next_offset: null })
export function EvidenceList({ input, refreshToken = 0 }: { input: EvidenceListInput; refreshToken?: number | string }) {
  const [page, setPage] = useState<EvidencePage>(emptyPage), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef(0), filter = JSON.stringify(input)
  const concepts = useConceptStore(s => s.items), subjects = useAppStore(s => s.subjects)
  const refresh = useCallback(async (offset = 0): Promise<void> => {
    const token = ++request.current
    setBusy(true); setError('')
    const result = await window.api.evidence.list({ ...JSON.parse(filter) as EvidenceListInput, offset })
    if (token !== request.current) return
    setBusy(false)
    if (result.ok) setPage(previous => ({ ...result.data, items: offset ? [...previous.items, ...result.data.items] : result.data.items }))
    else setError(result.error)
  }, [filter])
  useEffect(() => { setPage(emptyPage()); void refresh(); return () => { request.current++ } }, [refresh, refreshToken])
  const remove = async (id: string): Promise<void> => {
    setBusy(true); setError('')
    const result = await window.api.evidence.remove(id)
    if (result.ok) await refresh(); else { setError(result.error); setBusy(false) }
  }
  return <div className="evidence-list">
    {error && <p className="material-error" role="alert">{error}</p>}
    {!!page.total && <p className="muted">{page.total} 个已确认的证据引用</p>}
    {!page.total && !busy && !error && <p className="muted">暂无已确认的证据引用。</p>}
    {page.items.map(evidence => {
      const href = evidenceHref(evidence)
      return <article className="evidence-record" key={evidence.id} data-evidence-id={evidence.id}>
        <div className="toolbar"><strong>{evidenceRoles[evidence.role]}</strong><Link to={`/knowledge?concept=${encodeURIComponent(evidence.concept_id)}`}>{concepts.find(concept => concept.id === evidence.concept_id)?.name ?? '查看知识点'}</Link></div>
        <p>{evidence.source_title}{evidence.entry_title && ` · ${evidence.entry_title}`} · {evidence.location}</p>
        <p className="muted">{subjects.find(subject => subject.id === evidence.source_subject_id)?.name ?? (evidence.source_subject_id ? '原学科已移除' : '未指定学科')} · {evidenceStatuses[evidence.source_status]}</p>
        <blockquote>{evidence.quote.slice(0, 500)}{evidence.quote.length > 500 && '…'}</blockquote>
        <details><summary>查看完整引用文字</summary><div className="evidence-quote"><MarkdownSegment text={evidence.quote} subjectId={evidence.source_subject_id} /></div></details>
        {evidence.memo && <p className="evidence-memo">引用说明：{evidence.memo}</p>}
        <div className="toolbar">{href ? <Link to={href}>打开引用时原位</Link> : <span className="muted">原笔记已删除，保留以上快照</span>}<button disabled={busy} onClick={() => void remove(evidence.id)}>移除引用</button></div>
      </article>
    })}
    {busy && <p role="status">正在读取证据…</p>}
    {page.next_offset !== null && <button disabled={busy} onClick={() => void refresh(page.next_offset!)}>继续读取证据</button>}
  </div>
}

export function KnowledgeEvidence({ source, title, subjectId, quoteLength, expectedNoteText, disabled = false }: { source: EvidenceSource; title: string; subjectId: string | null; quoteLength: number; expectedNoteText?: string; disabled?: boolean }) {
  const [opened, setOpened] = useState(false)
  return <details className="knowledge-evidence" onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
    <summary>知识证据 · 引用此处内容</summary>
    {opened && <EvidenceEditor source={source} title={title} subjectId={subjectId} quoteLength={quoteLength} expectedNoteText={expectedNoteText} disabled={disabled} />}
  </details>
}
function EvidenceEditor({ source, title, subjectId, quoteLength, expectedNoteText, disabled }: { source: EvidenceSource; title: string; subjectId: string | null; quoteLength: number; expectedNoteText?: string; disabled: boolean }) {
  const { items, load } = useConceptStore(), { subjects } = useAppStore()
  const [query, setQuery] = useState(''), [conceptId, setConceptId] = useState(''), [role, setRole] = useState<EvidenceRole>('source'), [memo, setMemo] = useState('')
  const [creating, setCreating] = useState(false), [name, setName] = useState(title.slice(0, 120)), [summary, setSummary] = useState(''), [aliases, setAliases] = useState(''), [conceptSubject, setConceptSubject] = useState(subjectId ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [revision, setRevision] = useState(0)
  const saving = useRef(false)
  useEffect(() => { void load() }, [load])
  const needle = conceptKey(query.trim()), matches = items.filter(item => [item.name, ...item.aliases, item.summary ?? ''].some(text => conceptKey(text).includes(needle)))
  const allowed = !disabled && quoteLength > 0 && quoteLength <= 40_000
  const save = async (): Promise<void> => {
    if (saving.current || !allowed) return
    saving.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const base = { source, role, memo, ...(source.kind === 'note' ? { expected_note_text: expectedNoteText } : {}) }
      if (creating) {
        const result = await window.api.evidence.createConcept({ ...base, concept: { name, summary, subject_id: conceptSubject || null, aliases: aliases.split(/\r?\n/).map(value => value.trim()).filter(Boolean) } })
        if (!result.ok) { setError(result.error); return }
        await load(); setConceptId(result.data.concept.id); setCreating(false); setMessage('知识点与证据引用已一同保存')
      } else {
        const result = await window.api.evidence.add({ ...base, concept_id: conceptId })
        if (!result.ok) { setError(result.error); return }
        setMessage(result.data.created ? '证据引用已保存' : '此内容已引用，保留原有角色与说明')
      }
      setRevision(value => value + 1)
    } finally { saving.current = false; setBusy(false) }
  }
  return <div className="evidence-editor">
    <p className="muted">把此处已保存的完整文字作为知识点证据，保留引用时内容。名称自动命中仍只算“提及”。最多 40000 字符；跨学科引用可以手动建立。</p>
    {disabled && <p role="status">请先保存并核对笔记文字，再建立证据引用。</p>}
    {quoteLength > 40_000 && <p className="material-error">此条目过长，请先拆分后引用。</p>}
    {!creating ? <><label>搜索已有知识点<input aria-label="搜索证据知识点" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称、别名或释义" /></label>
      <label>引用到<select aria-label="证据知识点" value={conceptId} disabled={busy} onChange={event => setConceptId(event.target.value)}><option value="">选择知识点</option>{matches.map(item => <option key={item.id} value={item.id}>{item.name} · {subjects.find(subject => subject.id === item.subject_id)?.name ?? '通用概念'}</option>)}</select></label>
      <button disabled={busy} onClick={() => setCreating(true)}>新建知识点并引用</button></> : <div className="evidence-new-concept">
      <label>知识点名称<input aria-label="证据新知识点名称" value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label>适用学科<select aria-label="证据新知识点学科" value={conceptSubject} onChange={event => setConceptSubject(event.target.value)}><option value="">通用概念</option>{subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select></label>
      <label>释义<textarea aria-label="证据新知识点释义" value={summary} maxLength={4000} onChange={event => setSummary(event.target.value)} placeholder="自行概括含义与适用条件，不会自动用引用文字替换释义" /></label>
      <label>已确认别名<textarea aria-label="证据新知识点别名" value={aliases} maxLength={2500} onChange={event => setAliases(event.target.value)} placeholder="每行一个，最多 20 个" /></label>
      <p className="muted">新建前请搜索已有知识点，避免仅因名称不同而重复建条目；本步不自动判定同义。</p><button disabled={busy} onClick={() => setCreating(false)}>改为引用已有知识点</button>
    </div>}
    <label>引用角色<select aria-label="证据角色" value={role} disabled={busy} onChange={event => setRole(event.target.value as EvidenceRole)}>{Object.entries(evidenceRoles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>引用说明<textarea aria-label="证据说明" value={memo} maxLength={2000} disabled={busy} onChange={event => setMemo(event.target.value)} placeholder="说明这段内容与知识点的关系、条件或不同之处" /></label>
    <button className="primary" disabled={busy || !allowed || (creating ? !name.trim() : !conceptId)} onClick={() => void save()}>{creating ? '保存知识点与证据' : '保存证据引用'}</button>
    {error && <p className="material-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <KnowledgeSuggestions source={source} quoteLength={quoteLength} expectedNoteText={expectedNoteText} disabled={disabled} onAdopted={() => { setRevision(value => value + 1); void load() }} />
    <EvidenceList input={{ source }} refreshToken={JSON.stringify([revision, expectedNoteText, disabled])} />
  </div>
}
