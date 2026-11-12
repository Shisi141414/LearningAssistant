/**
 * pages/SchedulePage.tsx —— R5 首批：统一日程视图
 *
 * 三区：逾期/今日到期（高亮）→ 未来按日期分组 → 无日期收件箱。
 * 支持截止日期与时间块（planned_at）编辑——区分"什么时候必须完成"与"打算什么时候做"。
 * 系统通知由主进程启动时发送（仅应用运行时有效，见 docs/31）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Task, TaskWithProject } from '@shared/types'
import { MathInput } from '../components/MathInput'
import { useAppStore } from '../stores/app'

const STATUS_LABEL: Record<Task['status'], string> = { open: '待办', doing: '进行中', blocked: '阻塞', done: '已完成' }

function dayKey(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}
function toInputDate(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function SchedulePage() {
  const showToast = useAppStore((s) => s.showToast)
  const [tasks, setTasks] = useState<TaskWithProject[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')

  const reload = useCallback(async () => {
    const res = await window.api.tasks.listAll()
    if (res.ok) setTasks(res.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const { overdue, today, upcoming, inbox } = useMemo(() => {
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const dayEnd = dayStart + 86_400_000
    const open = tasks.filter((t) => t.status !== 'done')
    const overdue: TaskWithProject[] = []
    const today: TaskWithProject[] = []
    const upcoming = new Map<string, TaskWithProject[]>()
    const inbox: TaskWithProject[] = []
    for (const t of open) {
      if (!t.due_at) {
        inbox.push(t)
      } else if (t.due_at < dayStart) {
        overdue.push(t)
      } else if (t.due_at < dayEnd) {
        today.push(t)
      } else {
        const key = dayKey(t.due_at)
        upcoming.set(key, [...(upcoming.get(key) ?? []), t])
      }
    }
    upcoming.forEach((list) => list.sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0)))
    return { overdue, today, upcoming, inbox }
  }, [tasks])

  const add = async (): Promise<void> => {
    if (!newTitle.trim()) return
    const res = await window.api.tasks.create({
      kind: 'manual',
      title: newTitle.trim(),
      due_at: newDue ? new Date(`${newDue}T12:00:00`).getTime() : null
    })
    if (res.ok) {
      setNewTitle('')
      setNewDue('')
      void reload()
    } else showToast(`创建失败：${res.error}`)
  }

  const setDue = async (task: TaskWithProject, date: string): Promise<void> => {
    const res = await window.api.tasks.update(task.id, { due_at: date ? new Date(`${date}T12:00:00`).getTime() : null })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  const cycle = async (task: TaskWithProject): Promise<void> => {
    const order: Task['status'][] = ['open', 'doing', 'done']
    const next = task.status === 'blocked' ? 'doing' : order[(order.indexOf(task.status) + 1) % order.length]
    const res = await window.api.tasks.update(task.id, { status: next })
    if (res.ok) void reload()
  }

  const renderTask = (t: TaskWithProject): React.ReactNode => (
    <div key={t.id} className="row-item" style={{ padding: '8px 12px' }}>
      <input type="checkbox" checked={t.status === 'done'} onChange={() => void cycle(t)} />
      <div className="grow">
        <div style={{ fontWeight: 500, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</div>
        <div className="meta">
          {STATUS_LABEL[t.status]}
          {t.project_id && t.project_title && (
            <>
              {' · '}
              <Link to={`/projects/${t.project_id}`} style={{ color: 'inherit' }}>{t.project_title}</Link>
            </>
          )}
          {t.status === 'blocked' && t.blocked_reason && ` · 阻塞：${t.blocked_reason}`}
          {t.planned_at && ` · 计划 ${new Date(t.planned_at).toLocaleString('zh-CN')}`}
        </div>
      </div>
      <input
        type="date"
        value={toInputDate(t.due_at)}
        onChange={(e) => void setDue(t, e.target.value)}
        title="截止日期"
        style={{ width: 132 }}
      />
      <button
        style={{ fontSize: 12, padding: '2px 8px' }}
        title="删除任务"
        onClick={() => {
          if (window.confirm(`删除任务「${t.title}」？`)) void window.api.tasks.remove(t.id).then(() => void reload())
        }}
      >
        删除
      </button>
    </div>
  )

  const Section = ({ title, hint, items, tone }: { title: string; hint?: string; items: TaskWithProject[]; tone?: 'danger' | 'warn' }): React.ReactNode =>
    items.length === 0 ? null : (
      <div className="card" style={{ marginBottom: 12, borderColor: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? '#f59e0b' : undefined }}>
        <h3 style={{ margin: '0 0 8px', color: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? '#b45309' : undefined }}>
          {title}（{items.length}）
        </h3>
        {hint && <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>{hint}</div>}
        <div className="row-list">{items.map(renderTask)}</div>
      </div>
    )

  return (
    <div className="page">
      <h1>日程</h1>
      <div className="muted" style={{ marginBottom: 12 }}>
        项目任务与手动任务的统一视图：截止日期（必须完成）与计划时间块分开管理。提醒说明：应用启动时会弹出到期通知；应用未运行时不提醒（后续批次接入系统级计划任务）。
      </div>

      <div className="toolbar">
        <MathInput multiline={false} placeholder="新任务（如：推导 §2.3 习题 4）" value={newTitle} onChange={setNewTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
        <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} title="截止日期（可空）" style={{ width: 132 }} />
        <button className="primary" onClick={() => void add()}>+ 添加</button>
      </div>

      <Section title="已逾期" items={overdue} tone="danger" hint="尽快完成或调整截止日期" />
      <Section title="今日到期" items={today} tone="warn" />
      {[...upcoming.entries()].map(([label, items]) => (
        <Section key={label} title={label} items={items} />
      ))}
      <Section title="待安排（无截止日期）" items={inbox} hint="来自项目或手动创建；设定截止日期后进入日程" />
    </div>
  )
}
