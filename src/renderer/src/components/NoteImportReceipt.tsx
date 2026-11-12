import { useState } from 'react'
import type { NotePackageReceipt } from '@shared/note-package'

/** 未匹配记录仅作文本展示；不把原包中的段落或教材编号用作链接。 */
export function NoteImportReceipt({ noteId }: { noteId: string }) {
  const [receipt, setReceipt] = useState<NotePackageReceipt | null>(null), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [limit, setLimit] = useState(50)
  return <details className="learning-note-receipt" onToggle={event => { if (event.currentTarget.open && !loaded) { setLoaded(true); void window.api.notes.packageReceipt(noteId).then(result => { if (result.ok) setReceipt(result.data); else { setError(result.error); setLoaded(false) } }) } }}>
    <summary>查看导入历史出处</summary>
    {error && <p role="alert">{error}</p>}
    {loaded && !receipt && <p className="muted">未发现导入记录。</p>}
    {receipt && <><p>原笔记：{receipt.title} · 固定修订：{receipt.revision_id}</p><p className="muted">以下记录与导入的正文修订不匹配，保留为历史出处，不关联当前正文位置。{!receipt.include_concepts && '导入时未携带概念与证据。'}</p>
      <p>{receipt.annotations.length} 个历史标注 · {receipt.evidence.length} 项历史证据</p>
      {receipt.annotations.slice(0, limit).map(item => <p key={item.id}>历史{item.kind === 'question' ? '疑问' : '重点'}：{item.comment || '无备注'}（原段落修订 {item.segment_revision}）</p>)}
      {receipt.evidence.slice(0, limit).map((item, index) => <div key={index}><p>历史证据 · {item.concept_name} · {item.memo}</p><blockquote>{item.quote}</blockquote></div>)}
      {(receipt.annotations.length > limit || receipt.evidence.length > limit) && <button onClick={() => setLimit(limit + 50)}>显示更多历史记录</button>}
    </>}
  </details>
}
