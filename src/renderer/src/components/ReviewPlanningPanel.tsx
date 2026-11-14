import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ReviewPlanningState } from '@shared/reviews'
import { useAppStore } from '../stores/app'
const time = (n: number) => new Date(n).toLocaleString('zh-CN')
const reasons: Record<string, string> = {
  memory_changed: '评分或撤销后结束上一轮',
  paused_or_unavailable: '暂停或来源不可用',
  planning_disabled: '停用时间安排'
}
export function ReviewPlanningPanel({
  id,
  revision,
  onDraftState
}: {
  id: string
  revision: string
  onDraftState?: (value: { dirty: boolean; busy: boolean }) => void
}) {
  const [state, setState] = useState<ReviewPlanningState | null>(null),
    [enabled, setEnabled] = useState(false),
    [minutes, setMinutes] = useState(10),
    [priority, setPriority] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const lock = useRef(false),
    generation = useRef(0),
    toast = useAppStore((s) => s.showToast)
  const apply = (s: ReviewPlanningState) => {
    setState(s)
    setEnabled(s.enabled)
    setMinutes(s.duration_minutes)
    setPriority(s.priority)
  }
  useEffect(() => {
    const token = ++generation.current
    setState(null)
    setError('')
    void window.api.reviews.planning(id).then((r) => {
      if (token !== generation.current) return
      if (r.ok) apply(r.data)
      else setError(r.error)
    })
    return () => {
      generation.current++
    }
  }, [id, revision])
  const dirty =
    !!state &&
    (enabled !== state.enabled ||
      minutes !== state.duration_minutes ||
      priority !== state.priority)
  useEffect(() => {
    onDraftState?.({ dirty, busy })
    return () => onDraftState?.({ dirty: false, busy: false })
  }, [dirty, busy, onDraftState])
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty || busy) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    const navigate = (e: MouseEvent) => {
      const target =
        e.target instanceof Element ? e.target.closest('a[href]') : null
      if (!target || (!dirty && !busy)) return
      if (busy || !window.confirm('复习安排尚未保存，放弃这些输入并离开？')) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('beforeunload', unload)
    document.addEventListener('click', navigate, true)
    return () => {
      window.removeEventListener('beforeunload', unload)
      document.removeEventListener('click', navigate, true)
    }
  }, [dirty, busy])
  const reload = async () => {
    if (dirty && !window.confirm('放弃未保存的复习安排并重新载入？')) return
    const token = ++generation.current
    const r = await window.api.reviews.planning(id)
    if (token !== generation.current) return
    if (r.ok) {
      apply(r.data)
      setError('')
    } else setError(r.error)
  }
  const save = async () => {
    if (lock.current || !state) return
    if (
      state.enabled &&
      !enabled &&
      state.blocks.length &&
      !window.confirm(
        '停用将结束本轮时间块（包括锁定安排），旧安排记录保留。继续吗？'
      )
    )
      return
    lock.current = true
    setBusy(true)
    setError('')
    const token = generation.current
    try {
      const r = await window.api.reviews.savePlanning({
        id,
        expected_revision: state.revision,
        expected_card_revision: state.card_revision,
        enabled,
        duration_minutes: minutes,
        priority
      })
      if (token !== generation.current) return
      if (r.ok) {
        apply(r.data)
        toast('复习学习安排已保存')
      } else setError(r.error)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const block = async (
    b: ReviewPlanningState['blocks'][number],
    action: 'lock' | 'unlock' | 'remove'
  ) => {
    if (lock.current) return
    if (
      action === 'remove' &&
      !window.confirm('移除此时间块？复习仍未完成，启用自动排程后可重新安排。')
    )
      return
    lock.current = true
    setBusy(true)
    const token = generation.current
    try {
      const r = await window.api.calendar.changeBlock({
        id: b.id,
        expected_revision: b.revision,
        action
      })
      if (token !== generation.current) return
      if (!r.ok) setError(r.error)
      else await reload()
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <details className="review-planning" aria-label="复习学习时间安排">
      <summary>学习时间安排</summary>
      <p className="muted">
        每轮单独安排，最早从建议复习时间开始。评分、暂停或撤销会结束本轮时间块，锁定安排也会转入历史。时间过去不会自动算作已复习。
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button disabled={busy} onClick={() => void reload()}>
            重新载入安排
          </button>
        </p>
      )}
      {state ? (
        <>
          <fieldset disabled={busy}>
            <label>
              <input
                aria-label="允许自动安排复习"
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              允许自动安排每轮复习
            </label>
            <label>
              每轮预计用时（分钟）
              <input
                aria-label="每轮复习用时"
                type="number"
                min={5}
                max={120}
                step={5}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
            <label>
              优先级
              <select
                aria-label="复习安排优先级"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              >
                {['低', '普通', '高', '最高'].map((label, i) => (
                  <option value={i} key={i}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => void save()}
              disabled={
                !Number.isInteger(minutes) ||
                minutes < 5 ||
                minutes > 120 ||
                minutes % 5 !== 0
              }
            >
              保存复习安排
            </button>
          </fieldset>
          <p className="muted">
            保存后到日程页生成预览；启用“持续自动调整”时会自动安排。使用现有可用时段、每日上限与五分钟网格，不改动记忆模型的建议时间。
            {!state.active && '当前复习暂停或来源不可用，恢复后再参与排程。'}
          </p>
          <Link to="/review">前往日程安排</Link>
          <h4>本轮时间块 · {state.blocks.length}</h4>
          <button disabled={busy} onClick={() => void reload()}>
            刷新安排
          </button>
          {state.blocks.map((b) => (
            <div key={b.id} className="review-planning-block">
              <span>
                {time(b.start_at)} — {time(b.end_at)} ·{' '}
                {b.locked ? '已锁定' : '可自动调整'}
                {b.end_at < Date.now() ? ' · 时间已过，仍需复习评分' : ''}
              </span>
              <button
                disabled={busy}
                onClick={() => void block(b, b.locked ? 'unlock' : 'lock')}
              >
                {b.locked ? '解锁' : '锁定'}
              </button>
              <button disabled={busy} onClick={() => void block(b, 'remove')}>
                移除
              </button>
            </div>
          ))}
          {!!state.history.length && (
            <details>
              <summary>旧轮次安排记录</summary>
              {state.history.map((h) => (
                <article key={h.id}>
                  <p>
                    {time(h.created_at)} · {reasons[h.reason] ?? h.reason}
                  </p>
                  {h.blocks.map((b) => (
                    <p key={b.id}>
                      {time(b.start_at)} — {time(b.end_at)}
                      {b.locked ? ' · 原为锁定安排' : ''}
                    </p>
                  ))}
                </article>
              ))}
            </details>
          )}
        </>
      ) : (
        !error && <p>正在读取安排…</p>
      )}
    </details>
  )
}
