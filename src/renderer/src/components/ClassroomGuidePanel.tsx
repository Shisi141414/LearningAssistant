import { useEffect, useRef, useState } from 'react'
import type {
  ClassroomGuideHint,
  ClassroomGuideState
} from '@shared/classroom-guide'
import { guideLabels } from '@shared/classroom-guide'
import { MarkdownSegment } from './MarkdownSegment'
import './classroom-guide.css'

export function ClassroomGuidePanel({
  noteId,
  live = false,
  onOriginal,
  onAnnotated
}: {
  noteId: string
  live?: boolean
  onOriginal: (id: string) => void
  onAnnotated: () => Promise<void>
}) {
  const [state, setState] = useState<ClassroomGuideState | null>(null),
    [error, setError] = useState('')
  const [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0)
  const [banner, setBanner] = useState<ClassroomGuideHint | null>(null)
  const mounted = useRef(false),
    locked = useRef(false),
    request = useRef(0)
  const seen = useRef(new Set<string>()),
    initialized = useRef(false)
  function accept(next: ClassroomGuideState, announce: boolean) {
    if (
      announce &&
      initialized.current &&
      live &&
      next.active &&
      next.enabled &&
      offset === 0
    ) {
      const fresh = next.hints.find(
        (h) =>
          h.notice &&
          !h.stale &&
          h.status === 'open' &&
          h.session_id === next.session_id &&
          !seen.current.has(h.id) &&
          Date.now() - h.created_at < 120000
      )
      if (fresh) setBanner(fresh)
    }
    setBanner((old) =>
      old &&
      next.active &&
      next.enabled &&
      old.session_id === next.session_id &&
      next.hints.some((h) => h.id === old.id && h.status === 'open' && !h.stale)
        ? old
        : null
    )
    for (const h of next.hints) seen.current.add(h.id)
    // Bound view-only dedup state; persisted history is authoritative.
    if (seen.current.size > 3000)
      seen.current = new Set(next.hints.map((h) => h.id))
    initialized.current = true
    setState(next)
    setError('')
  }
  async function reload(announce = false) {
    const id = ++request.current,
      result = await window.api.classroomGuide.state({
        note_id: noteId,
        offset
      })
    if (!mounted.current || request.current !== id) return
    if (!result.ok) {
      setError(result.error)
      return
    }
    accept(result.data, announce)
  }
  useEffect(() => {
    mounted.current = true
    let active = true,
      timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (!locked.current) await reload(true)
      } catch {
        if (active) setError('导学提示暂时不可读，请刷新重试')
      } finally {
        if (active && live) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      active = false
      mounted.current = false
      request.current++
      clearTimeout(timer)
    }
  }, [noteId, live, offset])
  async function run(fn: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    request.current++
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : '导学操作失败')
    } finally {
      locked.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function save(enabled: boolean, seconds: number) {
    if (!state) return
    const r = await window.api.classroomGuide.save({
      note_id: noteId,
      revision: state.revision,
      enabled,
      cooldown_seconds: seconds
    })
    if (!r.ok) throw Error(r.error)
    if (mounted.current) {
      accept(r.data, false)
      setOffset(0)
      setBanner(null)
    }
  }
  async function action(
    h: ClassroomGuideHint,
    kind: 'dismiss' | 'keypoint' | 'question'
  ) {
    const r = await window.api.classroomGuide.action({
      id: h.id,
      revision: h.revision,
      action: kind
    })
    if (!r.ok) throw Error(r.error)
    if (kind !== 'dismiss') await onAnnotated()
    if (mounted.current) await reload()
  }
  function actions(h: ClassroomGuideHint) {
    const adopted = h.status === 'adopted' && !!h.annotation_id
    return (
      <div className="guide-actions">
        <button
          disabled={busy || !h.segment_id}
          onClick={() => h.segment_id && onOriginal(h.segment_id)}
        >
          {h.stale ? '查看当前原文' : '查看原句与教材'}
        </button>
        {!adopted && (
          <>
            <button
              disabled={busy || h.stale}
              onClick={() => void run(() => action(h, 'keypoint'))}
            >
              标为重点
            </button>
            <button
              disabled={busy || h.stale}
              onClick={() => void run(() => action(h, 'question'))}
            >
              标为疑问
            </button>
          </>
        )}
        {adopted && (
          <span>
            已加入{h.annotation_kind === 'question' ? '疑问' : '重点'}标注
          </span>
        )}
        {h.status === 'open' && (
          <button
            disabled={busy}
            onClick={() => void run(() => action(h, 'dismiss'))}
          >
            忽略此提示
          </button>
        )}
        {h.status === 'dismissed' && <span className="muted">已忽略</span>}
      </div>
    )
  }
  return (
    <section
      className={`classroom-guide${live ? ' guide-live' : ''}`}
      aria-label={live ? '课堂导学' : '课堂导学记录'}
    >
      <div className="guide-toolbar">
        {live ? (
          <label>
            <input
              type="checkbox"
              aria-label="课堂重点提示"
              checked={state?.enabled ?? false}
              disabled={busy || !state?.active}
              onChange={(e) =>
                void run(() =>
                  save(e.target.checked, state?.cooldown_seconds ?? 45)
                )
              }
            />
            课堂重点提示
          </label>
        ) : (
          <strong>课堂导学记录</strong>
        )}
        {live && (
          <label>
            提醒间隔{' '}
            <select
              aria-label="导学提醒间隔"
              value={state?.cooldown_seconds ?? 45}
              disabled={busy || !state?.active}
              onChange={(e) =>
                void run(() =>
                  save(state?.enabled ?? false, Number(e.target.value))
                )
              }
            >
              {[15, 30, 45, 60, 120, 300].map((n) => (
                <option key={n} value={n}>
                  {n} 秒
                </option>
              ))}
            </select>
          </label>
        )}
        <button disabled={busy} onClick={() => void run(() => reload())}>
          刷新提示
        </button>
        <span className="muted">本地规则 · 只检查新增语段</span>
      </div>
      {live && (
        <details className="guide-explanation">
          <summary>识别说明</summary>
          <p>
            识别重点、易错、推导和考核线索，附命中原句。一般线索与间隔内命中保存在记录中；点击标注才加入笔记。
          </p>
        </details>
      )}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
      {!!state?.dropped && (
        <p role="status">
          转写较快，已跳过 {state.dropped} 段导学检查；课堂原文均已保存。
        </p>
      )}
      <div aria-live="polite" aria-atomic="true">
        {live && banner && (
          <article className={`guide-banner guide-${banner.kind}`}>
            <strong>{guideLabels[banner.kind]}</strong>
            <div className="guide-live-excerpt">
              <MarkdownSegment text={banner.excerpt} />
            </div>
            <details>
              <summary>识别依据：{banner.evidence[0].quote}</summary>
              <p>
                {banner.evidence[0].reason}：{banner.evidence[0].quote}
              </p>
            </details>
            {actions(banner)}
          </article>
        )}
      </div>
      <details className="guide-history">
        <summary>导学记录（{state?.total ?? 0}）</summary>
        {!state?.hints.length && (
          <p className="muted">
            暂无导学记录。启用后从新的课堂语段开始，保留原文。
          </p>
        )}
        {state?.hints.map((h) => (
          <article key={h.id} className={`guide-item guide-${h.kind}`}>
            <div>
              <strong>{guideLabels[h.kind]}</strong>
              <time>{new Date(h.created_at).toLocaleTimeString('zh-CN')}</time>
            </div>
            {h.stale && (
              <p className="guide-stale">
                原文已修改或删除，以下为当时摘录；请核对当前原文后手动标注。
              </p>
            )}
            <MarkdownSegment text={h.excerpt} />
            <details>
              <summary>识别依据</summary>
              {h.evidence.map((e, i) => (
                <p key={i}>
                  {e.reason} · “{e.quote}”
                </p>
              ))}
            </details>
            {h.quiet_reason && <p className="muted">{h.quiet_reason}</p>}
            {actions(h)}
          </article>
        ))}
        {!!state?.total && (
          <div className="guide-actions">
            <button
              disabled={busy || offset === 0}
              onClick={() => {
                setBanner(null)
                setOffset(Math.max(0, offset - 30))
              }}
            >
              上一页
            </button>
            <span>
              {offset + 1}–{Math.min(offset + 30, state.total)} / {state.total}
            </span>
            <button
              disabled={busy || offset + 30 >= state.total}
              onClick={() => {
                setBanner(null)
                setOffset(offset + 30)
              }}
            >
              下一页
            </button>
          </div>
        )}
      </details>
    </section>
  )
}
