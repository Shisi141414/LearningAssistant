import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConceptUsagePage } from '@shared/knowledge-graph'
import { exerciseStatuses } from '@shared/exercises'

export function ConceptUsage({ conceptId }: { conceptId: string }) {
  const [page, setPage] = useState<ConceptUsagePage | null>(null),
    [error, setError] = useState('')
  const [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    setOffset(0)
    setPage(null)
  }, [conceptId])
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    void window.api.concepts.usage({ concept_id: conceptId, offset }).then((result) => {
      if (!alive) return
      setLoading(false)
      if (result.ok) setPage(result.data)
      else {
        setPage(null)
        setError(result.error)
      }
    })
    return () => {
      alive = false
    }
  }, [conceptId, offset])
  return (
    <section className="concept-usage" aria-label="知识点的习题与任务">
      <h3>在练习与任务中使用</h3>
      <p className="muted">已明确关联的复习知识与任务用途，共 {page?.total ?? 0} 项。</p>
      <Link to={`/exercises?concept=${encodeURIComponent(conceptId)}`}>查看相关习题</Link>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取应用关联…</p>}
      {!loading &&
        page?.items.map((item) => (
          <article key={`${item.kind}:${item.id}`}>
            <Link
              to={
                item.kind === 'project_document'
                  ? `/projects/${item.project_id}/documents/${item.id}`
                  : item.kind === 'exercise'
                    ? `/exercises/${item.id}`
                    : item.project_id
                      ? `/projects/${item.project_id}?task=${encodeURIComponent(item.id)}`
                      : `/review?task=${encodeURIComponent(item.id)}`
              }
            >
              {item.kind === 'exercise'
                ? '习题'
                : item.kind === 'project_document'
                  ? '项目文档'
                  : '任务'}
              ：{item.title}
            </Link>
            <p className="muted">
              {item.kind === 'exercise'
                ? (exerciseStatuses[item.status as keyof typeof exerciseStatuses] ?? item.status)
                : ({
                    open: '待办',
                    doing: '进行中',
                    blocked: '阻塞',
                    done: '已完成',
                    document: '文档'
                  }[item.status] ?? item.status)}
              {item.project_title ? ` · ${item.project_title}` : ''}
            </p>
            {item.why && <p>用途：{item.why}</p>}
          </article>
        ))}
      {!loading && page?.total === 0 && (
        <p className="muted">可在习题中选择需复习知识点，或在项目任务中关联知识用途。</p>
      )}
      {!!page && (page.total > 50 || offset > 0) && (
        <div className="toolbar">
          <button disabled={loading || !offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            上一组应用
          </button>
          <span>
            {offset + 1}–{offset + page.items.length} / {page.total}
          </span>
          <button
            disabled={loading || page.next_offset === null}
            onClick={() => setOffset(page.next_offset!)}
          >
            下一组应用
          </button>
        </div>
      )}
    </section>
  )
}
