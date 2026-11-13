import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApiResult } from '@shared/types'
import type {
  ReminderConfiguration,
  ReminderItem,
  ReminderPage,
  ReminderTaskOptions
} from '@shared/reminders'
import './reminders.css'
const check = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw Error(r.error)
  return r.data
}
const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
const when = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
const delivery = {
  pending: '等待系统提醒',
  claimed: '正在请求系统展示',
  shown: '系统已确认展示',
  failed: '系统通知失败',
  uncertain: '系统投递状态不确定',
  skipped: '仅应用内提醒',
  cancelled: '系统提醒已取消'
}
const stateName = {
  pending: '待提醒',
  published: '待处理',
  dismissed: '已处理',
  snoozed: '已稍后提醒',
  cancelled: '已失效',
  expired: '超过补发窗口'
}

export function ReminderSettingsCard() {
  const [draft, setDraft] = useState<ReminderConfiguration | null>(null),
    [baseline, setBaseline] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const run = async (f: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await f()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const accept = (value: ReminderConfiguration): void => {
    setDraft(value)
    setBaseline(JSON.stringify(value.value))
  }
  useEffect(() => {
    void window.api.reminders.settings().then((r) => {
      if (r.ok) accept(r.data)
      else setError(r.error)
    })
  }, [])
  if (!draft)
    return (
      <div className="card reminder-settings">
        {error ? <p role="alert">{error}</p> : <p>正在读取提醒设置…</p>}
      </div>
    )
  const s = draft.value,
    dirty = JSON.stringify(s) !== baseline
  return (
    <section className="card reminder-settings" aria-label="提醒设置">
      <h2>日程与学习提醒</h2>
      <p className="muted">
        启用后，提醒计划与应用内记录保存在本机。系统通知默认关闭，可单独启用并测试。
      </p>
      <fieldset disabled={busy}>
        <label className="reminder-check">
          <input
            aria-label="启用学习提醒"
            type="checkbox"
            checked={s.enabled}
            onChange={(e) =>
              setDraft({ ...draft, value: { ...s, enabled: e.target.checked } })
            }
          />
          启用学习提醒
        </label>
        <label className="reminder-check">
          <input
            aria-label="启用系统通知"
            type="checkbox"
            checked={s.system_enabled}
            onChange={(e) =>
              setDraft({
                ...draft,
                value: { ...s, system_enabled: e.target.checked }
              })
            }
          />
          启用系统通知
        </label>
        <p className="muted">
          系统支持：
          {draft.capabilities.system_supported
            ? '可请求桌面通知'
            : '当前不支持桌面通知'}
          。
          {draft.capabilities.packaged
            ? '已打包应用仍需允许系统通知。'
            : '开发运行模式的 Windows 通知可能需要先安装正式应用与开始菜单快捷方式。'}
        </p>
        <div className="reminder-settings-grid">
          <label>
            日程开始前（分钟）
            <input
              aria-label="默认开始提醒提前量"
              type="number"
              min={0}
              max={10080}
              value={s.start_lead_minutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, start_lead_minutes: Number(e.target.value) }
                })
              }
            />
          </label>
          <label>
            任务截止前（分钟）
            <input
              aria-label="默认截止提醒提前量"
              type="number"
              min={0}
              max={10080}
              value={s.due_lead_minutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, due_lead_minutes: Number(e.target.value) }
                })
              }
            />
          </label>
          <label>
            错过提醒补发窗口（分钟）
            <input
              aria-label="提醒补发窗口"
              type="number"
              min={1}
              max={10080}
              value={s.catchup_minutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, catchup_minutes: Number(e.target.value) }
                })
              }
            />
          </label>
          <label>
            全天日程提醒基准时间
            <input
              aria-label="全天日程提醒时间"
              type="time"
              value={s.all_day_time}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, all_day_time: e.target.value }
                })
              }
            />
          </label>
        </div>
        <p className="muted">
          全天日程以所选时间为基准再减去开始提前量。所有提醒按本机时区显示；具体任务可覆盖提前量。已错过且超出补发窗口的提醒进入历史。
        </p>
        <label className="reminder-check">
          <input
            aria-label="启用提醒免打扰"
            type="checkbox"
            checked={s.quiet_enabled}
            onChange={(e) =>
              setDraft({
                ...draft,
                value: { ...s, quiet_enabled: e.target.checked }
              })
            }
          />
          系统通知免打扰
        </label>
        <div className="reminder-settings-grid">
          <label>
            免打扰开始
            <input
              aria-label="免打扰开始"
              type="time"
              value={s.quiet_start}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, quiet_start: e.target.value }
                })
              }
            />
          </label>
          <label>
            免打扰结束
            <input
              aria-label="免打扰结束"
              type="time"
              value={s.quiet_end}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  value: { ...s, quiet_end: e.target.value }
                })
              }
            />
          </label>
        </div>
        <p className="muted">
          免打扰期间先保存应用内提醒，系统通知在结束后合并提示；期间已处理或失效的提醒不再发送。
        </p>
        <label className="reminder-check">
          <input
            aria-label="启用关闭窗口后台提醒"
            type="checkbox"
            checked={s.background_enabled}
            onChange={(e) =>
              setDraft({
                ...draft,
                value: { ...s, background_enabled: e.target.checked }
              })
            }
          />
          关闭窗口后留在后台提醒
        </label>
        <p className="muted">
          开启后关闭窗口会隐藏到托盘，应用、课堂记录和其他进行中的工作仍在运行。托盘菜单可重新打开或彻底退出。彻底退出、关机或未登录时不能提醒；不自动开启开机启动，也不延迟关机。
        </p>
        <p>
          后台状态：
          {draft.capabilities.background_active ? '托盘运行中' : '未在托盘运行'}
          {draft.capabilities.error ? ' · ' + draft.capabilities.error : ''}
        </p>
        <div className="toolbar">
          <button
            type="button"
            className="primary"
            onClick={() =>
              void run(async () => {
                accept(
                  check(
                    await window.api.reminders.saveSettings({
                      expected_revision: draft.revision,
                      value: s
                    })
                  )
                )
                setNotice('提醒设置已保存；后台状态可点击刷新查看')
              })
            }
          >
            保存提醒设置
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                if (dirty && !window.confirm('丢弃未保存的提醒设置并刷新？'))
                  return
                accept(check(await window.api.reminders.settings()))
              })
            }
          >
            刷新提醒设置
          </button>
          <button
            type="button"
            onClick={() =>
              void run(async () =>
                setNotice(check(await window.api.reminders.test()))
              )
            }
          >
            测试系统通知
          </button>
          <Link to="/review?reminders=1">打开提醒中心</Link>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}

export function ReminderCenter({
  initiallyOpen = false,
  beforeComplete,
  onTaskCompleted,
  disabled = false
}: {
  initiallyOpen?: boolean
  beforeComplete: () => boolean
  onTaskCompleted: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [view, setView] = useState<'attention' | 'upcoming' | 'history'>(
      'attention'
    ),
    [page, setPage] = useState<ReminderPage | null>(null),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [snooze, setSnooze] = useState(10)
  const request = useRef(0)
  const reload = useCallback(async () => {
    const current = ++request.current
    const r = await window.api.reminders.list({ view, offset })
    if (current !== request.current) return
    if (r.ok) {
      setPage(r.data)
      setError('')
    } else setError(r.error)
  }, [view, offset])
  useEffect(() => {
    void reload()
    const id = setInterval(() => void reload(), 30000)
    return () => {
      clearInterval(id)
      request.current++
    }
  }, [reload])
  useEffect(() => {
    if (initiallyOpen) setOpen(true)
  }, [initiallyOpen])
  useEffect(() => {
    const show = () => {
      setOpen(true)
      void reload()
    }
    window.addEventListener('open-reminders', show)
    return () => window.removeEventListener('open-reminders', show)
  }, [reload])
  const act = async (
    item: ReminderItem,
    action: 'dismiss' | 'snooze' | 'complete' | 'retry'
  ): Promise<void> => {
    if (disabled) return
    if (action === 'complete' && !beforeComplete()) return
    if (
      action === 'retry' &&
      !window.confirm('系统可能已展示过此提醒。仍然重试系统通知？')
    )
      return
    if (
      action === 'complete' &&
      !window.confirm(`将任务「${item.title}」标记完成？`)
    )
      return
    setBusy(true)
    setError('')
    try {
      check(
        await window.api.reminders.action({
          id: item.id,
          expected_revision: item.revision,
          action,
          ...(action === 'snooze' ? { minutes: snooze } : {})
        })
      )
      if (action === 'complete') onTaskCompleted()
      await reload()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="reminder-center"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        提醒中心
        {page
          ? `（待处理 ${page.attention_count} · 待提醒 ${page.upcoming_count}）`
          : ''}
      </summary>
      <p className="muted">
        应用内记录与系统通知分别保存。改期、完成、删除或停用任务提醒后，旧提醒会失效。
        <Link to="/settings?tab=reminders">提醒设置</Link>
      </p>
      <div className="toolbar">
        {(
          [
            ['attention', '待处理'],
            ['upcoming', '待提醒'],
            ['history', '历史']
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={key === view ? 'primary' : ''}
            disabled={busy}
            onClick={() => {
              setView(key)
              setOffset(0)
            }}
          >
            {label}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={() => void reload()}>
          刷新提醒
        </button>
        <label>
          稍后间隔
          <select
            aria-label="稍后提醒间隔"
            value={snooze}
            onChange={(e) => setSnooze(Number(e.target.value))}
          >
            {[5, 10, 30, 60, 1440].map((n) => (
              <option key={n} value={n}>
                {n === 1440 ? '明天此时' : `${n} 分钟`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {page && (
        <p>
          共 {page.total} 项
          {page.total > 0
            ? `，当前 ${offset + 1}–${offset + page.items.length}`
            : ''}
        </p>
      )}
      {page?.items.map((item) => (
        <article
          className="reminder-item"
          key={item.id}
          data-reminder-id={item.id}
        >
          <strong>{item.title}</strong>
          <span className="pill">{stateName[item.status]}</span>
          <p>
            {item.kind === 'due' ? '截止' : '开始'}：{when(item.event_at)}
            {item.location ? ' · ' + item.location : ''}
            <br />
            提醒：{when(item.remind_at)}
          </p>
          {item.system_status && (
            <p className="muted">
              {delivery[item.system_status]}
              {item.system_error ? '：' + item.system_error : ''}
            </p>
          )}
          <div className="toolbar">
            <Link
              to={`/review?task=${encodeURIComponent(item.task_id)}&reminders=1`}
            >
              查看日程
            </Link>
            {item.status === 'published' && (
              <>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'dismiss')}
                >
                  知道了
                </button>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'snooze')}
                >
                  稍后提醒
                </button>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'complete')}
                >
                  完成任务
                </button>
                {['failed', 'uncertain', 'skipped'].includes(
                  item.system_status ?? ''
                ) && (
                  <button
                    type="button"
                    disabled={busy || disabled}
                    onClick={() => void act(item, 'retry')}
                  >
                    重试系统通知
                  </button>
                )}
              </>
            )}
          </div>
        </article>
      ))}
      {page?.items.length === 0 && (
        <p className="muted">
          {view === 'attention'
            ? '暂无待处理提醒。'
            : view === 'upcoming'
              ? '暂无待提醒日程，可先新建日程或安排学习时间。'
              : '暂无历史提醒。'}
        </p>
      )}
      <div className="toolbar">
        {offset > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页提醒
          </button>
        )}
        {page?.next_offset !== null && page?.next_offset !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setOffset(page.next_offset!)}
          >
            下一页提醒
          </button>
        )}
      </div>
    </details>
  )
}

export function TaskReminderEditor({
  taskId,
  disabled,
  onDraftState
}: {
  taskId: string
  disabled: boolean
  onDraftState: (state: { dirty: boolean; busy: boolean }) => void
}) {
  const [draft, setDraft] = useState<ReminderTaskOptions | null>(null),
    [baseline, setBaseline] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const accept = (v: ReminderTaskOptions): void => {
    setDraft(v)
    setBaseline(JSON.stringify(v))
  }
  useEffect(() => {
    let active = true
    void window.api.reminders.task(taskId).then((r) => {
      if (active) {
        if (r.ok) accept(r.data)
        else setError(r.error)
      }
    })
    return () => {
      active = false
    }
  }, [taskId])
  const dirty = !!draft && JSON.stringify(draft) !== baseline
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
    setNotice('')
    try {
      await f()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="task-reminders">
      <summary>任务提醒</summary>
      {draft && (
        <fieldset disabled={disabled || busy}>
          <label className="reminder-check">
            <input
              aria-label="启用此任务提醒"
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            启用此任务提醒
          </label>
          <label>
            开始提前量（分钟，留空跟随全局）
            <input
              aria-label="任务开始提醒提前量"
              type="number"
              min={0}
              max={10080}
              value={draft.start_lead_minutes ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  start_lead_minutes:
                    e.target.value === '' ? null : Number(e.target.value)
                })
              }
            />
          </label>
          <label>
            截止提前量（分钟，留空跟随全局）
            <input
              aria-label="任务截止提醒提前量"
              type="number"
              min={0}
              max={10080}
              value={draft.due_lead_minutes ?? ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  due_lead_minutes:
                    e.target.value === '' ? null : Number(e.target.value)
                })
              }
            />
          </label>
          <p className="muted">
            学习时间块沿用任务的开始提前量；0
            表示到点提醒。阻塞任务只保留截止提醒，已完成任务和暂停/归档项目不提醒。
          </p>
          <div className="toolbar">
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  accept(check(await window.api.reminders.saveTask(draft)))
                  setNotice('任务提醒已保存')
                })
              }
            >
              保存任务提醒
            </button>
            <button
              type="button"
              onClick={() =>
                void run(async () => {
                  if (dirty && !window.confirm('丢弃未保存的任务提醒并刷新？'))
                    return
                  accept(check(await window.api.reminders.task(taskId)))
                })
              }
            >
              刷新任务提醒
            </button>
          </div>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  )
}
