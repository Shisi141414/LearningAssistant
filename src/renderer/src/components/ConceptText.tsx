import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { createConceptMatcher } from '@shared/concept-matcher'
import { useConceptStore } from '../stores/concepts'
import type { Concept } from '@shared/types'

const cache = new WeakMap<Concept[], Map<string, ReturnType<typeof createConceptMatcher>>>()
function matcherFor(concepts: Concept[], subjectId?: string | null): ReturnType<typeof createConceptMatcher> {
  let bySubject = cache.get(concepts)
  if (!bySubject) { bySubject = new Map(); cache.set(concepts, bySubject) }
  const key = subjectId ?? ''
  if (!bySubject.has(key)) bySubject.set(key, createConceptMatcher(concepts, subjectId))
  return bySubject.get(key)!
}

/** 内容节点保留原文字，不向原始数据插入链接或 HTML。 */
export function ConceptText({ text, subjectId }: { text: string; subjectId?: string | null }): ReactNode {
  const concepts = useConceptStore(s => s.items)
  const match = useMemo(() => matcherFor(concepts, subjectId), [concepts, subjectId])
  const mentions = useMemo(() => match(text), [match, text])
  const [active, setActive] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { setActive(null); setSelected(null) }, [text, concepts, subjectId])
  useEffect(() => { if (active !== null) closeRef.current?.focus() }, [active])
  const close = (): void => { setActive(null); setSelected(null); triggerRef.current?.focus() }
  if (!mentions.length) return text
  const nodes: ReactNode[] = []
  let end = 0
  mentions.forEach((mention, index) => {
    nodes.push(text.slice(end, mention.start))
    nodes.push(<button className={`concept-mention ${mention.status}`} key={mention.start} aria-label={`${mention.text}：${mention.status === 'ambiguous' ? '选择含义' : '查看概念'}`} onClick={e => { triggerRef.current = e.currentTarget; setActive(index); setSelected(mention.status === 'linked' ? mention.concept_ids[0] : null) }}>{text.slice(mention.start, mention.end)}</button>)
    end = mention.end
  })
  nodes.push(text.slice(end))
  const current = active === null ? undefined : mentions[active]
  const concept = concepts.find(c => c.id === selected)
  return <Fragment>{nodes}{current && <span role="dialog" aria-modal="false" aria-label="概念卡片" className="concept-popover" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}>
    <button ref={closeRef} className="concept-close" aria-label="关闭概念卡片" onClick={close}>关闭</button>
    {concept ? <><strong>{concept.name}</strong>{concept.aliases.length > 0 && <small>别名：{concept.aliases.join('、')}</small>}<span className="concept-summary">{concept.summary || '尚未填写释义。'}</span><Link to={`/knowledge?concept=${encodeURIComponent(concept.id)}`}>查看概念与相关材料</Link></> : <><strong>请选择“{current.text}”的含义</strong>{current.concept_ids.map(id => { const c = concepts.find(item => item.id === id)!; return <button key={id} onClick={() => setSelected(id)}>{c.name} · {c.subject_id ? '学科概念' : '通用概念'}{c.summary ? ` · ${c.summary.slice(0, 60)}` : ''}</button> })}</>}
  </span>}</Fragment>
}
