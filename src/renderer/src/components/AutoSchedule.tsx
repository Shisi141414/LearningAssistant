import { useEffect, useState } from 'react'
import type { TaskWithProject, ApiResult } from '@shared/types'
import type {
  PlanningPreview,
  PlanningState,
  TaskPlanningSave
} from '@shared/auto-schedule'
import {
  defaultTaskPlanning,
  planningDateRange,
  scheduleDateInZone
} from '@shared/auto-schedule'
import { validCalendarDate } from '@shared/calendar-navigation'
import './auto-schedule.css'
const date = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const time = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
const check = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw Error(r.error)
  return r.data
}
const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
const priorities = ['低', '普通', '高', '紧急']

export function AutoSchedule({
  state,
  tasks,
  onChange,
  disabled
}: {
  state: PlanningState
  tasks: TaskWithProject[]
  onChange: (state: PlanningState) => void
  disabled: boolean
}) {
  const [settings, setSettings] = useState(state.settings),
    [from, setFrom] = useState(
      scheduleDateInZone(Date.now(), state.settings.value.timezone)
    ),
    [to, setTo] = useState(
      scheduleDateInZone(
        Date.now() + 13 * 86400000,
        state.settings.value.timezone
      )
    ),
    [preview, setPreview] = useState<PlanningPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('')
  const dirty = JSON.stringify(settings) !== JSON.stringify(state.settings)
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await operation()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const title = (id: string): string =>
    tasks.find((t) => t.id === id)?.title ?? '已删除任务'
  const accept = (next: PlanningState): void => {
    onChange(next)
    setPreview(null)
  }
  return (
    <details
      className="auto-schedule"
      onToggle={(e) => {
        if (!e.currentTarget.open) {
          setPreview(null)
          void window.api.calendar.discardPlan()
        }
      }}
    >
      <summary>自动安排学习时间</summary>
      <p className="muted">
        先在日程编辑中的“学习安排”里启用任务并填写剩余用时，再生成预览。固定课程、锁定及已开始的时间块会保留。此处由你确认后应用；持续自动调整可在下方单独启用。
      </p>
      <fieldset disabled={disabled || busy}>
        <legend>可用时段</legend>
        <div className="auto-settings-row">
          <label>
            时区
            <input
              aria-label="排程时区"
              value={settings.value.timezone}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  value: { ...settings.value, timezone: e.target.value }
                })
              }
            />
          </label>
          <label>
            每日自动安排上限（分钟）
            <input
              type="number"
              min={5}
              max={1440}
              step={5}
              value={settings.value.daily_minutes}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  value: {
                    ...settings.value,
                    daily_minutes: Number(e.target.value)
                  }
                })
              }
            />
          </label>
          <label>
            相邻安排缓冲（分钟）
            <input
              type="number"
              min={0}
              max={60}
              value={settings.value.buffer_minutes}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  value: {
                    ...settings.value,
                    buffer_minutes: Number(e.target.value)
                  }
                })
              }
            />
          </label>
        </div>
        <p className="muted">
          上限统计学习时间块；课程会占用可用时段。可用时段和排程日期按上方时区解释；预览、日历和任务编辑按本机时间显示。
        </p>
        <div className="auto-availability">
          {settings.value.availability.map((slot, i) => (
            <div className="auto-slot" key={i}>
              <select
                aria-label={`时段 ${i + 1} 星期`}
                value={slot.weekday}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    value: {
                      ...settings.value,
                      availability: settings.value.availability.map((a, n) =>
                        n === i ? { ...a, weekday: Number(e.target.value) } : a
                      )
                    }
                  })
                }
              >
                {['一', '二', '三', '四', '五', '六', '日'].map((d, n) => (
                  <option key={n} value={n + 1}>
                    周{d}
                  </option>
                ))}
              </select>
              <input
                aria-label={`时段 ${i + 1} 开始`}
                type="time"
                value={slot.start}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    value: {
                      ...settings.value,
                      availability: settings.value.availability.map((a, n) =>
                        n === i ? { ...a, start: e.target.value } : a
                      )
                    }
                  })
                }
              />
              <span>至</span>
              <input
                aria-label={`时段 ${i + 1} 结束`}
                type="time"
                value={slot.end}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    value: {
                      ...settings.value,
                      availability: settings.value.availability.map((a, n) =>
                        n === i ? { ...a, end: e.target.value } : a
                      )
                    }
                  })
                }
              />
              <button
                type="button"
                aria-label={`移除时段 ${i + 1}`}
                onClick={() =>
                  setSettings({
                    ...settings,
                    value: {
                      ...settings.value,
                      availability: settings.value.availability.filter(
                        (_, n) => n !== i
                      )
                    }
                  })
                }
              >
                移除
              </button>
            </div>
          ))}
        </div>
        <div className="toolbar">
          <button
            type="button"
            disabled={settings.value.availability.length >= 28}
            onClick={() =>
              setSettings({
                ...settings,
                value: {
                  ...settings.value,
                  availability: [
                    ...settings.value.availability,
                    { weekday: 1, start: '09:00', end: '12:00' }
                  ]
                }
              })
            }
          >
            添加时段
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const next = check(
                  await window.api.calendar.saveSettings({
                    expected_revision: settings.revision,
                    value: settings.value
                  })
                )
                setSettings(next.settings)
                accept(next)
                setSuccess('排程设置已保存')
              })
            }
          >
            保存排程设置
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                if (dirty && !window.confirm('丢弃未保存的排程设置并刷新？'))
                  return
                const next = check(await window.api.calendar.planning())
                setSettings(next.settings)
                accept(next)
              })
            }
          >
            刷新排程设置
          </button>
        </div>
        <div className="auto-settings-row">
          <label>
            开始日期
            <input
              aria-label="自动排程开始日期"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPreview(null)
                void window.api.calendar.discardPlan()
              }}
            />
          </label>
          <label>
            结束日期（含当天）
            <input
              aria-label="自动排程结束日期"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                setPreview(null)
                void window.api.calendar.discardPlan()
              }}
            />
          </label>
          <button
            type="button"
            disabled={dirty}
            onClick={() =>
              void run(async () => {
                if (!validCalendarDate(from) || !validCalendarDate(to))
                  throw Error('请输入正确日期')
                setPreview(
                  check(
                    await window.api.calendar.plan(
                      planningDateRange(from, to, settings.value.timezone)
                    )
                  )
                )
              })
            }
          >
            生成排程预览
          </button>
          {state.latest_run && (
            <button
              type="button"
              disabled={dirty}
              onClick={() =>
                void run(async () => {
                  if (!window.confirm('撤销最近一次排程并暂停持续自动调整？')) return
                  accept(
                    check(
                      await window.api.calendar.undoPlan(state.latest_run!.id)
                    )
                  )
                  setSuccess('已撤销最近一次自动排程')
                })
              }
            >
              撤销最近排程
            </button>
          )}
        </div>
        {dirty && (
          <p className="muted">排程设置有未保存的改动，请先保存或刷新。</p>
        )}
        <p>
          已启用 {state.planning.filter((p) => p.enabled).length} 项任务 · 现有{' '}
          {state.blocks.length} 个学习时间块
        </p>
        {preview && (
          <section aria-label="自动排程预览" className="auto-preview">
            <h3>排程预览</h3>
            <p>
              重新安排 {preview.added.length} 段，替换 {preview.removed.length}{' '}
              个未锁定时间块（完全相同的安排会保留）。确认前不会修改日历。
            </p>
            {preview.removed.length > 0 && (
              <details>
                <summary>将替换的原安排</summary>
                {preview.removed.map((b) => (
                  <p key={b.id}>
                    {title(b.task_id)} · {time(b.start_at)} — {time(b.end_at)}
                  </p>
                ))}
              </details>
            )}
            {preview.added.map((b, i) => (
              <p key={i}>
                <strong>{title(b.task_id)}</strong> · {time(b.start_at)} —{' '}
                {time(b.end_at)}
                <br />
                <span className="muted">{b.reason}</span>
              </p>
            ))}
            {preview.unplaced.length > 0 && <h4>需要处理</h4>}
            {preview.unplaced.map((p) => (
              <p key={p.task_id}>
                {title(p.task_id)}：{p.reason}
              </p>
            ))}
            {preview.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
            <div className="toolbar">
              <button
                className="primary"
                type="button"
                disabled={dirty}
                onClick={() =>
                  void run(async () => {
                    accept(
                      check(await window.api.calendar.applyPlan(preview.token))
                    )
                    setSuccess('学习时间已安排到日历')
                  })
                }
              >
                确认应用排程
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(null)
                  void window.api.calendar.discardPlan()
                }}
              >
                取消预览
              </button>
            </div>
          </section>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
    </details>
  )
}

export function TaskPlanningEditor({
  taskId,
  tasks,
  state,
  onChange,
  onDraftState,
  onEditBlock,
  disabled
}: {
  taskId: string
  tasks: TaskWithProject[]
  state: PlanningState
  onChange: (state: PlanningState) => void
  onDraftState: (value: { dirty: boolean; busy: boolean }) => void
  onEditBlock: (id: string) => void
  disabled: boolean
}) {
  const initial = (): TaskPlanningSave => {
    const p = state.planning.find((p) => p.task_id === taskId)
    if (!p) return defaultTaskPlanning(taskId)
    const { revision, ...value } = p
    return { ...value, expected_revision: revision }
  }
  const [draft, setDraft] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [search, setSearch] = useState('')
  const blocks = state.blocks.filter((b) => b.task_id === taskId)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial())
  useEffect(() => {
    onDraftState({ dirty, busy })
  }, [dirty, busy, onDraftState])
  useEffect(
    () => () => onDraftState({ dirty: false, busy: false }),
    [onDraftState]
  )
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await f()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const accept = (next: PlanningState): void => {
    onChange(next)
  }
  return (
    <details className="task-planning">
      <summary>
        学习安排{blocks.length > 0 ? `（${blocks.length} 段）` : ''}
      </summary>
      <p className="muted">
        先保存日程本身。剩余用时由你更新，已经过去的时间块不会自动算成完成。停用后保留已有时间块，可逐段移除。
      </p>
      <fieldset disabled={disabled || busy}>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />{' '}
          允许自动安排此任务
        </label>
        <label>
          剩余用时（分钟）
          <input
            type="number"
            min={5}
            max={3600}
            step={5}
            value={draft.remaining_minutes}
            onChange={(e) =>
              setDraft({ ...draft, remaining_minutes: Number(e.target.value) })
            }
          />
        </label>
        <label>
          优先级
          <select
            value={draft.priority}
            onChange={(e) =>
              setDraft({ ...draft, priority: Number(e.target.value) })
            }
          >
            {priorities.map((s, i) => (
              <option key={i} value={i}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          最早开始（本机时间）
          <input
            type="datetime-local"
            value={
              draft.not_before === null
                ? ''
                : `${date(draft.not_before)}T${String(new Date(draft.not_before).getHours()).padStart(2, '0')}:${String(new Date(draft.not_before).getMinutes()).padStart(2, '0')}`
            }
            onChange={(e) =>
              setDraft({
                ...draft,
                not_before: e.target.value
                  ? new Date(e.target.value).getTime()
                  : null
              })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.splittable}
            onChange={(e) =>
              setDraft({ ...draft, splittable: e.target.checked })
            }
          />{' '}
          可分多段
        </label>
        <label>
          每段最少（分钟）
          <input
            type="number"
            min={5}
            max={240}
            step={5}
            value={draft.min_minutes}
            onChange={(e) =>
              setDraft({ ...draft, min_minutes: Number(e.target.value) })
            }
          />
        </label>
        <label>
          每段最多（分钟）
          <input
            type="number"
            min={5}
            max={480}
            step={5}
            value={draft.max_minutes}
            onChange={(e) =>
              setDraft({ ...draft, max_minutes: Number(e.target.value) })
            }
          />
        </label>
        <label>
          查找前置任务
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="输入任务名称"
          />
        </label>
        <select
          aria-label="添加前置任务"
          value=""
          onChange={(e) => {
            if (e.target.value)
              setDraft({
                ...draft,
                dependencies: [...draft.dependencies, e.target.value]
              })
          }}
          disabled={draft.dependencies.length >= 32}
        >
          <option value="">选择前置任务（最多显示 100 项）</option>
          {tasks
            .filter(
              (t) =>
                t.id !== taskId &&
                !draft.dependencies.includes(t.id) &&
                t.title.includes(search)
            )
            .slice(0, 100)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
                {t.status === 'done' ? '（已完成）' : ''}
              </option>
            ))}
        </select>
        {draft.dependencies.map((id) => (
          <p key={id}>
            {tasks.find((t) => t.id === id)?.title ?? '已删除任务'}{' '}
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  dependencies: draft.dependencies.filter((d) => d !== id)
                })
              }
            >
              移除前置任务
            </button>
          </p>
        ))}
        <div className="toolbar">
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const next = check(
                  await window.api.calendar.savePlanning(draft)
                )
                accept(next)
                const p = next.planning.find((p) => p.task_id === taskId)!
                const { revision, ...value } = p
                setDraft({ ...value, expected_revision: revision })
                setSuccess('学习安排已保存，请生成排程预览')
              })
            }
          >
            保存学习安排
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                JSON.stringify(draft) !== JSON.stringify(initial()) &&
                !window.confirm('丢弃未保存的学习安排并刷新？')
              )
                return
              void run(async () => {
                const next = check(await window.api.calendar.planning())
                accept(next)
                const p = next.planning.find((p) => p.task_id === taskId)
                if (p) {
                  const { revision, ...value } = p
                  setDraft({ ...value, expected_revision: revision })
                } else setDraft(defaultTaskPlanning(taskId))
              })
            }}
          >
            刷新学习安排
          </button>
        </div>
        {blocks.map((b) => (
          <div className="auto-block" key={b.id}>
            <strong>
              {b.locked ? '已锁定 · ' : ''}
              {time(b.start_at)} — {time(b.end_at)}
            </strong>
            <p className="muted">{b.reason}</p>
            <div className="toolbar">
              <button type="button" disabled={dirty || b.start_at <= Date.now()} onClick={() => onEditBlock(b.id)}>调整时间</button>
              <button
                type="button"
                onClick={() =>
                  void run(async () =>
                    accept(
                      check(
                        await window.api.calendar.changeBlock({
                          id: b.id,
                          expected_revision: b.revision,
                          action: b.locked ? 'unlock' : 'lock'
                        })
                      )
                    )
                  )
                }
              >
                {b.locked ? '解锁' : '锁定'}
              </button>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    if (
                      window.confirm(
                        '移除此学习时间块？任务与截止时间仍会保留。'
                      )
                    )
                      accept(
                        check(
                          await window.api.calendar.changeBlock({
                            id: b.id,
                            expected_revision: b.revision,
                            action: 'remove'
                          })
                        )
                      )
                  })
                }
              >
                移除时间块
              </button>
            </div>
          </div>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
    </details>
  )
}
