import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ContinuousSettings,
  ContinuousState
} from '@shared/continuous-schedule'
import type { TaskWithProject, ApiResult } from '@shared/types'
const check = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw Error(r.error)
  return r.data
}
const when = (n: number): string =>
  new Date(n).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
const names = {
  paused: '已暂停',
  waiting: '等待检查（手动排程预览期间暂缓）',
  running: '正在计算',
  idle: '已检查',
  error: '检查未完成，将稍后重试'
}
export function ContinuousSchedule({
  tasks,
  onRefresh,
  disabled
}: {
  tasks: TaskWithProject[]
  onRefresh: () => Promise<void>
  disabled: boolean
}) {
  const [state, setState] = useState<ContinuousState | null>(null),
    [draft, setDraft] = useState<ContinuousSettings | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const current = useRef(draft),
    baseline = useRef(''),
    request = useRef(0),
    signature = useRef('')
  current.current = draft
  const accept = (s: ContinuousSettings): void => {
    baseline.current = JSON.stringify(s)
    current.current = s
    setDraft(s)
  }
  const reload = useCallback(async () => {
    const id = ++request.current,
      r = await window.api.calendar.continuous()
    if (id !== request.current) return
    if (!r.ok) {
      setError(r.error)
      return
    }
    const next = r.data
    setState(next)
    if (
      !current.current ||
      JSON.stringify(current.current) === baseline.current
    )
      accept(next.settings)
    const value = JSON.stringify([
      next.checked_at,
      next.history.map((h) => [h.id, h.undone_at])
    ])
    if (signature.current && signature.current !== value) await onRefresh()
    signature.current = value
  }, [onRefresh])
  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), 3000)
    return () => {
      clearInterval(timer)
      request.current++
    }
  }, [reload])
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await f()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const title = (id: string): string =>
    tasks.find((t) => t.id === id)?.title ?? '已删除任务'
  return (
    <details className="auto-schedule continuous-schedule">
      <summary>
        持续自动调整与排程记录{state ? ' · ' + names[state.state] : ''}
      </summary>
      <p className="muted">
        默认关闭。启用后，在所选滚动范围内自动重新安排已启用任务的未锁定时间块；保留固定课程、锁定、已开始及范围外的安排，截止时间保持不变。手动排程预览期间暂缓，撤销排程会暂停持续调整。
      </p>
      <p className="muted">
        时间过去不代表任务完成。请及时更新剩余用时；未完成且时间块已结束的任务，会继续按填写的剩余用时补排。无法安排的任务列在“需要处理”，其范围内可重排的旧块可能被移除。关闭应用后不继续计算，后台驻留可在提醒设置开启。
      </p>
      {draft && (
        <fieldset disabled={disabled || busy}>
          <div className="auto-settings-row">
            <label className="continuous-check">
              <input
                type="checkbox"
                aria-label="启用持续自动排程"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              启用持续自动调整
            </label>
            <label>
              从今天起滚动安排天数
              <input
                aria-label="持续排程天数"
                type="number"
                min={1}
                max={31}
                value={draft.horizon_days}
                onChange={(e) =>
                  setDraft({ ...draft, horizon_days: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void run(async () => {
                  if (
                    draft.enabled &&
                    !window.confirm(
                      '允许按当前可用时段和任务剩余用时，自动调整范围内未锁定的学习安排？无法安排的项会列出原因；可随时暂停或撤销。'
                    )
                  )
                    return
                  const next = check(
                    await window.api.calendar.saveContinuous(draft)
                  )
                  accept(next.settings)
                  setState(next)
                })
              }
            >
              保存持续排程设置
            </button>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  if (
                    JSON.stringify(draft) !== baseline.current &&
                    !window.confirm('丢弃未保存的持续排程设置并刷新？')
                  )
                    return
                  const next = check(await window.api.calendar.continuous())
                  accept(next.settings)
                  setState(next)
                })
              }
            >
              刷新持续排程
            </button>
            <button
              type="button"
              disabled={
                !state?.settings.enabled ||
                JSON.stringify(draft) !== baseline.current
              }
              onClick={() =>
                void run(async () => {
                  setState(check(await window.api.calendar.checkContinuous()))
                })
              }
            >
              立即检查自动安排
            </button>
          </div>
          {JSON.stringify(draft) !== baseline.current && (
            <p className="muted">持续排程设置尚未保存。</p>
          )}
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      {state && (
        <>
          <p>
            运行状态：{names[state.state]}
            {state.checked_at ? ' · 最近检查 ' + when(state.checked_at) : ''}
          </p>
          {state.error && <p role="alert">{state.error}</p>}
          {!!state.outcome.unplaced?.length && <h3>需要处理</h3>}
          {state.outcome.unplaced?.map((p) => (
            <p key={p.task_id}>
              {title(p.task_id)}：{p.reason}
            </p>
          ))}
          {state.outcome.warnings?.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          <h3>最近 20 次实际调整</h3>
          {!state.history.length && (
            <p className="muted">尚无调整记录；完全相同的安排不重复记录。</p>
          )}
          {state.history.map((h, i) => (
            <details className="continuous-history" key={h.id}>
              <summary>
                {when(h.created_at)} ·{' '}
                {h.origin === 'automatic' ? '持续自动调整' : '手动确认'} · 新增{' '}
                {h.added_total} / 移除 {h.removed_total}
                {h.undone_at ? ' · 已撤销' : ''}
              </summary>
              <p>{h.reason}</p>
              {h.removed.map((b) => (
                <p key={'r' + b.id}>
                  移除：{title(b.task_id)} · {when(b.start_at)} —{' '}
                  {when(b.end_at)}
                </p>
              ))}
              {h.added.map((b) => (
                <p key={'a' + b.id}>
                  新增：{title(b.task_id)} · {when(b.start_at)} —{' '}
                  {when(b.end_at)}
                  <br />
                  <span className="muted">{b.reason}</span>
                </p>
              ))}
              {(h.added_total > 100 || h.removed_total > 100) && (
                <p className="muted">
                  此页每类最多显示 100 个时间块，完整记录仍保存在本机。
                </p>
              )}
              {h.unplaced.map((p) => (
                <p key={p.task_id}>
                  {title(p.task_id)}：{p.reason}
                </p>
              ))}
              {h.warnings.map((w, n) => (
                <p key={n}>{w}</p>
              ))}
              {i === state.history.findIndex((h) => !h.undone_at) &&
                !h.undone_at && (
                  <button
                    type="button"
                    disabled={disabled || busy || state.state === 'running'}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !window.confirm(
                            '撤销本次排程并暂停持续自动调整？后续已有修改时会拒绝撤销。'
                          )
                        )
                          return
                        check(await window.api.calendar.undoPlan(h.id))
                        await onRefresh()
                      })
                    }
                  >
                    撤销本次并暂停
                  </button>
                )}
            </details>
          ))}
        </>
      )}
    </details>
  )
}
