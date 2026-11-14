import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MemoReference } from '@shared/memos'

export function MemoReferences({
  kind,
  id
}: {
  kind: 'concept' | 'task'
  id: string
}) {
  const [items, setItems] = useState<MemoReference[]>([]),
    [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setItems([])
    setError('')
    void window.api.memos.references({ kind, id }).then((r) => {
      if (alive) {
        if (r.ok) setItems(r.data)
        else setError(r.error)
      }
    })
    return () => {
      alive = false
    }
  }, [kind, id])
  if (!items.length && !error) return null
  return (
    <section className="memo-references" aria-label="来源备忘">
      <h3>来源备忘</h3>
      {error && <p role="alert">{error}</p>}
      {items.map((item, i) => (
        <p key={i}>
          <Link
            to={
              '/memos?memo=' +
              encodeURIComponent(item.memo_id) +
              '&revision=' +
              encodeURIComponent(item.revision)
            }
          >
            {item.content.slice(0, 100)}
          </Link>
          {item.archived ? '（回收站）' : ''}
          <small> · 归档时原文</small>
        </p>
      ))}
    </section>
  )
}
