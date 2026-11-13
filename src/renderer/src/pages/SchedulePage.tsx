import { TaskResources } from '../components/TaskResources'
import { AutoSchedule, TaskPlanningEditor } from '../components/AutoSchedule'
import { ReminderCenter, TaskReminderEditor } from '../components/Reminders'
import { ContinuousSchedule } from '../components/ContinuousSchedule'
import { ScheduleBlockEditor } from '../components/ScheduleBlockEditor'
import { useCalendarFollow } from '../components/useCalendarFollow'
import type { ScheduleBlock } from '@shared/auto-schedule'
import type { PlanningState } from '@shared/auto-schedule'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import type { DatesSetArg, EventInput } from '@fullcalendar/core'
import type { Task, TaskWithProject, TaskInput } from '@shared/types'
import type { CalendarPreview, CalendarConflicts } from '@shared/calendar'
import { useAppStore } from '../stores/app'
import { scheduleCategory, scheduleColor } from '@shared/schedule-colors'
import { scheduleStartTime } from '@shared/schedule-hours'
import { calendarJumpTarget } from '@shared/calendar-navigation'
import './schedule.css'

const STATUS: Record<Task['status'], string> = {
  open: '待办',
  doing: '进行中',
  blocked: '阻塞',
  done: '已完成'
}
const localDate = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const inputTime = (ts: number | null, allDay = false): string =>
  ts === null
    ? ''
    : localDate(ts) +
      (allDay
        ? ''
        : `T${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`)
const parseTime = (value: string): number | null =>
  value ? new Date(value.length === 10 ? value + 'T00:00:00' : value).getTime() : null
const displayTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
type Draft = {
  id?: string
  title: string
  detail: string
  location: string
  start: string
  end: string
  allDay: boolean
  due: string
  status: Task['status']
  reason: string
}
const draftFor = (task?: TaskWithProject, start?: Date, allDay = false): Draft => ({
  id: task?.id,
  title: task?.title ?? '',
  detail: task?.detail ?? '',
  location: task?.location ?? '',
  start: inputTime(task?.planned_at ?? start?.getTime() ?? null, task?.all_day ?? allDay),
  end: inputTime(
    task?.planned_end_at ??
      (start
        ? new Date(
            start.getFullYear(),
            start.getMonth(),
            start.getDate(),
            start.getHours() + (allDay ? 24 : 1),
            start.getMinutes()
          ).getTime()
        : null),
    task?.all_day ?? allDay
  ),
  allDay: task?.all_day ?? allDay,
  due: inputTime(task?.due_at ?? null),
  status: task?.status ?? 'open',
  reason: task?.blocked_reason ?? ''
})

export function SchedulePage() {
  const calendar = useRef<FullCalendar>(null)
  const [dateTitle, setDateTitle] = useState('日期')
  const [viewType, setViewType] = useState('timeGridWeek')
  const [dragging, setDragging] = useState(false)
  const [planning, setPlanning] = useState<PlanningState | null>(null)
  const [blockEdit, setBlockEdit] = useState<{block:ScheduleBlock;proposed?:{start_at:number;end_at:number}} | null>(null)
  const [dateJump, setDateJump] = useState<{ start: string; end: string; original_start: string; original_end: string; week: boolean } | null>(null)
  const [jumpError, setJumpError] = useState('')
  const [params] = useSearchParams()
  const targetTaskId = params.get('task') ?? ''
  const shownTarget = useRef('')
  const subjects = useAppStore((s) => s.subjects)
  const [importOpen, setImportOpen] = useState(false),
    [ignoreConflicts, setIgnoreConflicts] = useState(false)
  const showToast = useAppStore((s) => s.showToast)
  const [tasks, setTasks] = useState<TaskWithProject[]>([]),
    [draft, setDraft] = useState<Draft | null>(null)
  const originalDraft = useRef<Draft | null>(null)
  const planningDraft = useRef({dirty:false,busy:false})
  const reminderDraft = useRef({dirty:false,busy:false})
  const reminderDraftChanged = useCallback((value:{dirty:boolean;busy:boolean})=>{reminderDraft.current=value},[])
  const planningDraftChanged = useCallback((value:{dirty:boolean;busy:boolean})=>{planningDraft.current=value},[])
  const beginDraft = (value: Draft): void => { originalDraft.current = value; setDraft(value) }
  const canDiscardDraft = (): boolean => {
    if (planningDraft.current.busy || reminderDraft.current.busy) {showToast('学习安排或提醒正在保存，请稍候');return false}
    return !draft || (!planningDraft.current.dirty && !reminderDraft.current.dirty && JSON.stringify(draft) === JSON.stringify(originalDraft.current)) || window.confirm('放弃未保存的日程修改？')
  }
  const [showDone, setShowDone] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [fromSix, setFromSix] = useState(() => {
    try { return localStorage.getItem('schedule.fromSix') !== 'false' } catch { return true }
  })
  const [preferredStart, setPreferredStart] = useState(() => {
    try { const saved = localStorage.getItem('schedule.startTime'); return saved && /^([01]\d|2[0-3]):[0-5]\d$/.test(saved) ? saved : '06:00' } catch { return '06:00' }
  })
  const [dateRange, setDateRange] = useState<{ start: number; end: number } | null>(null)
  const updateRange = useCallback((info: DatesSetArg) => {
    const start = info.view.currentStart.getTime(), end = info.view.currentEnd.getTime()
    setDateRange((old) => old?.start === start && old.end === end ? old : { start, end })
    setDateTitle(info.view.title)
    setViewType(info.view.type)
  }, [])
  const openDateJump = (): void => {
    const api = calendar.current?.getApi()
    if (!api) return
    const end = new Date(api.view.currentEnd)
    end.setDate(end.getDate() - 1)
    const startValue = localDate(api.view.currentStart.getTime()), endValue = localDate(end.getTime())
    setDateJump({ start: startValue, end: endValue, original_start: startValue, original_end: endValue, week: api.view.type === 'timeGridWeek' })
    setJumpError('')
  }
  const [draftConflicts, setDraftConflicts] = useState<CalendarConflicts | null>(null)
  const [ignoreDraftConflicts, setIgnoreDraftConflicts] = useState(false)
  useEffect(() => {
    setDraftConflicts(null)
    setIgnoreDraftConflicts(false)
  }, [draft])
  const [preview, setPreview] = useState<CalendarPreview | null>(null)
  const [from, setFrom] = useState(localDate(Date.now())),
    [to, setTo] = useState(
      localDate(
        new Date(
          new Date().getFullYear(),
          new Date().getMonth() + 6,
          new Date().getDate()
        ).getTime()
      )
    )
  const reload = useCallback(async () => {
    const [result, plan] = await Promise.all([window.api.tasks.listAll(),window.api.calendar.planning()])
    if (result.ok) setTasks(result.data)
    else setError(result.error)
    if (plan.ok) setPlanning(plan.data)
    else setError(plan.error)
  }, [])
  useEffect(() => {
    void reload()
    return () => {
      void window.api.calendar.discard()
      void window.api.calendar.discardPlan()
    }
  }, [reload])
  useEffect(() => {
    if (targetTaskId) void reload()
    else shownTarget.current = ''
  }, [reload, targetTaskId])
  useEffect(() => {
    const refresh = (): void => { shownTarget.current = ''; void reload() }
    window.addEventListener('open-reminders', refresh)
    return () => window.removeEventListener('open-reminders', refresh)
  }, [reload])
  const perform = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const check = <T,>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw Error(r.error)
    return r.data
  }
  const visible = tasks.filter((t) => showDone || t.status !== 'done')
  const startTime = scheduleStartTime(fromSix, dateRange, [...visible,...(planning?.blocks??[]).filter(b=>visible.some(t=>t.id===b.task_id)).map(b=>({planned_at:b.start_at,planned_end_at:b.end_at,all_day:false,due_at:null}))], preferredStart ? Number(preferredStart.slice(0, 2)) * 60 + Number(preferredStart.slice(3)) : 360)
  const follow = useCalendarFollow(calendar,dateRange,viewType,startTime,dragging || !!blockEdit)
  const events = useMemo(() => {
    const list: EventInput[] = []
    for (const t of tasks.filter((t) => showDone || t.status !== 'done')) {
      const category = scheduleCategory(t, subjects),
        color = scheduleColor(category)
      const appearance = {
        backgroundColor: color.background,
        textColor: color.text,
        borderColor: 'transparent',
        extendedProps: { taskId: t.id, location: t.location, category },
        classNames: t.status === 'done' ? ['schedule-completed'] : []
      }
      if (t.planned_at !== null)
        list.push({
          ...appearance,
          id: t.id,
          title: t.title,
          start: t.planned_at,
          end: t.planned_end_at ?? undefined,
          allDay: t.all_day
        })
      for (const b of planning?.blocks.filter(b=>b.task_id===t.id) ?? []) list.push({
        ...appearance,id:`block:${b.id}`,title:`${b.locked?'锁定 · ':''}${t.title}`,start:b.start_at,end:b.end_at,allDay:false,
        startEditable: !b.locked && b.start_at > Date.now() && t.status !== 'done', durationEditable: !b.locked && b.start_at > Date.now() && t.status !== 'done'
      })
      if (t.due_at !== null && t.due_at !== t.planned_at)
        list.push({
          ...appearance,
          id: t.id + ':due',
          title: '截止 · ' + t.title,
          start: t.due_at,
          classNames: [...appearance.classNames, 'schedule-deadline']
        })
    }
    return list
  }, [tasks, showDone, subjects, planning])
  const edit = (task: TaskWithProject): void => {
    if (!busy && canDiscardDraft()) {
      beginDraft(draftFor(task))
      setError('')
    }
  }
  const editBlock = (id: string, proposed?: {start_at:number;end_at:number}): void => {
    const block = planning?.blocks.find(b => b.id === id)
    if (!busy && block && canDiscardDraft()) {
      setDraft(null)
      setBlockEdit({block,proposed})
    }
  }
  const stageBlockMove = (info: {event:{id:string;start:Date|null;end:Date|null;allDay:boolean};revert:()=>void}): void => {
    const {id,start,end,allDay} = info.event
    info.revert()
    if (id.startsWith('block:') && start && end && !allDay) editBlock(id.slice(6),{start_at:start.getTime(),end_at:end.getTime()})
  }
  const save = (): void => {
    if (!draft) return
    if (planningDraft.current.busy || reminderDraft.current.busy) {showToast('学习安排或提醒正在保存，请稍候');return}
    if ((planningDraft.current.dirty || reminderDraft.current.dirty) && !window.confirm('学习安排或任务提醒尚未保存。放弃这些输入并保存日程？')) return
    void perform(async () => {
      const input: TaskInput = {
        title: draft.title.trim(),
        detail: draft.detail,
        location: draft.location,
        planned_at: parseTime(draft.start),
        planned_end_at: parseTime(draft.end),
        all_day: draft.allDay,
        due_at: parseTime(draft.due)
      }
      const result = check(
        await window.api.calendar.save({
          id: draft.id,
          task: {
            ...input,
            ...(draft.id ? { status: draft.status, blocked_reason: draft.reason } : {})
          },
          confirmation: {
            ignore_conflicts: ignoreDraftConflicts,
            conflict_fingerprint: draftConflicts?.fingerprint ?? ''
          }
        })
      )
      if (result.conflicts) {
        setDraftConflicts(result.conflicts)
        setIgnoreDraftConflicts(false)
        return
      }
      setDraft(null)
      await reload()
      showToast('日程已保存')
    })
  }
  const remove = (task: TaskWithProject): void => {
    if (
      window.confirm(
        `删除日程「${task.title}」？${task.project_id ? '项目中的同一任务也会删除。' : ''}`
      )
    )
      void perform(async () => {
        check(await window.api.tasks.remove(task.id))
        if (draft?.id === task.id) setDraft(null)
        await reload()
      })
  }
  const groups = useMemo(() => {
    const now = new Date(),
      today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
      tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
    return [
      {
        name: '已逾期',
        items: visible.filter((t) => t.status !== 'done' && t.due_at !== null && t.due_at < today)
      },
      {
        name: '今日到期',
        items: visible.filter((t) => t.due_at !== null && t.due_at >= today && t.due_at < tomorrow)
      },
      {
        name: '待安排（无截止日期）',
        items: visible.filter((t) => t.planned_at === null && t.due_at === null && !planning?.blocks.some(b=>b.task_id===t.id&&b.end_at>Date.now()))
      }
    ]
  }, [tasks, showDone, planning])
  const selected = tasks.find((t) => t.id === draft?.id)
  useEffect(() => {
    const task = tasks.find(item => item.id === targetTaskId)
    if (!task || shownTarget.current === targetTaskId) return
    shownTarget.current = targetTaskId
    if (draft?.id === task.id || !canDiscardDraft()) return
    beginDraft(draftFor(task))
    requestAnimationFrame(() => document.querySelector('.schedule-editor')?.scrollIntoView({ block:'start' }))
  },[tasks,targetTaskId])
  return (
    <div className="page schedule-page">
      <div className="schedule-heading">
        <div>
          <h1>日程</h1>
          <p className="muted">把课程与任务安排在时间里。点击日历空白处新建，点击日程编辑。</p>
        </div>
        <div className="schedule-heading-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              if (canDiscardDraft()) beginDraft(draftFor())
            }}
          >
            + 新建日程
          </button>
          <button
            className="schedule-import-button"
            disabled={busy}
            onClick={() => {
              setImportOpen(true)
              requestAnimationFrame(() =>
                document
                  .querySelector('.schedule-import')
                  ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              )
            }}
          >
            导入课表
          </button>
        </div>
      </div>
      <div className="toolbar schedule-tools">
        <div className="schedule-start-setting" title="有更早或跨午夜的日程时，自动提前显示；取消后从 0:00 开始">
          <input
            id="schedule-start-enabled"
            aria-label="使用指定起始时间"
            type="checkbox"
            checked={fromSix}
            onChange={(e) => {
              setFromSix(e.target.checked)
              try { localStorage.setItem('schedule.fromSix', String(e.target.checked)) } catch { /* Session preference still works. */ }
            }}
          />
          <label htmlFor="schedule-start-enabled">从</label>
          <input
            type="time"
            aria-label="日程起始时间"
            value={preferredStart}
            onChange={(e) => {
              setPreferredStart(e.target.value)
              if (e.target.value) try { localStorage.setItem('schedule.startTime', e.target.value) } catch { /* Session preference still works. */ }
            }}
            onBlur={() => { if (!preferredStart) setPreferredStart('06:00') }}
          />
          <span>开始</span>
        </div>
        <label>
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />{' '}
          显示已完成
        </label>
        <span className="muted schedule-color-help">按学科、项目或课程自动配色</span>
        <span className="schedule-key due">虚线表示截止时间</span>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = check(await window.api.calendar.export())
              if (result)
                showToast(
                  `已导出 ${result.exported} 项日程；${result.unscheduled} 项待安排任务未包含在内`
                )
            })
          }
        >
          导出全部日程（ICS）
        </button>
      </div>
      {error && (
        <p role="alert" className="schedule-error">
          {error}
        </p>
      )}
      <details
        className="schedule-import"
        open={importOpen}
        onToggle={(e) => setImportOpen(e.currentTarget.open)}
      >
        <summary>导入课表</summary>
        <p className="muted">
          选择学期日期范围；周期课程展开为每次上课时间。目前支持 ICS；文件保留原样，预览确认后导入。
        </p>
        <div className="toolbar">
          <label>
            从{' '}
            <input
              aria-label="课表导入开始日期"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={busy || !!preview}
            />
          </label>
          <label>
            至（含）{' '}
            <input
              aria-label="课表导入结束日期"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              disabled={busy || !!preview}
            />
          </label>
          <button
            disabled={busy || !!preview}
            onClick={() =>
              void perform(async () => {
                const end = new Date(to + 'T00:00:00')
                end.setDate(end.getDate() + 1)
                setIgnoreConflicts(false)
                setPreview(
                  check(
                    await window.api.calendar.preview({
                      from: parseTime(from) ?? NaN,
                      to: end.getTime()
                    })
                  )
                )
              })
            }
          >
            选择 ICS 并预览
          </button>
        </div>
        {preview && (
          <div className="schedule-import-preview">
            <h3>{preview.file_name}</h3>
            <p>
              {preview.entries.length} 项日程，{preview.duplicates} 项已存在；确认后仅添加新日程。
            </p>
            {preview.warnings.map((w) => (
              <p className="muted" key={w}>
                {w}
              </p>
            ))}
            <div className="schedule-preview-list">
              {preview.entries.slice(0, 100).map((item) => (
                <div key={item.key}>
                  <strong>{item.title}</strong>
                  <span>
                    {item.all_day
                      ? localDate(item.start) + ' 全天'
                      : displayTime(item.start) + ' — ' + displayTime(item.end)}
                    {item.location && ' · ' + item.location}
                  </span>
                </div>
              ))}
            </div>
            {preview.entries.length > 100 && (
              <p className="muted">预览显示前 100 项，确认将导入全部符合范围的日程。</p>
            )}
            {preview.conflicts.items.length > 0 && (
              <section className="schedule-conflicts" aria-label="导入时间冲突">
                <h3>
                  发现{preview.conflicts.truncated ? '至少 ' : ''}
                  {preview.conflicts.items.length} 处时间冲突
                </h3>
                <p>以下安排时间重合。仅截止时刻不占用时间；已完成和重复导入的日程不参与检查。</p>
                <ul>
                  {preview.conflicts.items.map((conflict, index) => (
                    <li key={index}>
                      <strong>{conflict.incoming.title}</strong>（
                      {displayTime(conflict.incoming.start)} — {displayTime(conflict.incoming.end)}
                      ）与{conflict.kind === 'existing' ? '已有日程' : '本批课表'}{' '}
                      <strong>{conflict.other.title}</strong>（{displayTime(conflict.other.start)} —{' '}
                      {displayTime(conflict.other.end)}）重合
                    </li>
                  ))}
                </ul>
                {preview.conflicts.truncated && (
                  <p>冲突较多，仅列出前 200 处。建议缩小日期范围核对。</p>
                )}
                <label>
                  <input
                    type="checkbox"
                    aria-label="忽略冲突"
                    checked={ignoreConflicts}
                    onChange={(e) => setIgnoreConflicts(e.target.checked)}
                  />{' '}
                  忽略冲突，仍导入全部新日程
                </label>
              </section>
            )}
            <div className="toolbar">
              <button
                disabled={
                  busy ||
                  !preview.entries.length ||
                  (preview.conflicts.items.length > 0 && !ignoreConflicts)
                }
                className="primary"
                onClick={() =>
                  void perform(async () => {
                    const result = check(
                      await window.api.calendar.import(preview.token, {
                        ignore_conflicts: ignoreConflicts,
                        conflict_fingerprint: preview.conflicts.fingerprint
                      })
                    )
                    if (result.conflicts) {
                      setPreview({ ...preview, conflicts: result.conflicts })
                      setIgnoreConflicts(false)
                      throw Error('日程已变动，时间冲突需要重新核对；勾选忽略冲突后可继续导入')
                    }
                    setPreview(null)
                    await reload()
                    showToast(`已导入 ${result.added} 项，跳过 ${result.skipped} 项重复日程`)
                  })
                }
              >
                确认导入课表
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setPreview(null)
                  void window.api.calendar.discard()
                }}
              >
                取消导入
              </button>
            </div>
          </div>
        )}
      </details>
      {planning && <AutoSchedule state={planning} tasks={tasks} onChange={setPlanning} disabled={busy} />}
      <ContinuousSchedule tasks={tasks} onRefresh={reload} disabled={busy} />
      <ReminderCenter initiallyOpen={params.get('reminders')==='1'} beforeComplete={canDiscardDraft} onTaskCompleted={()=>{setDraft(null);void reload()}} disabled={busy} />
      <div className={`schedule-layout ${draft ? 'editing' : ''}`}>
        <section className="schedule-calendar" aria-label="日历" onWheel={follow.noteInteraction} onPointerDown={follow.noteInteraction}>
          {dateJump && <form className="schedule-date-jump" aria-label="填写日期跳转" onSubmit={e => {
            e.preventDefault()
            const target = calendarJumpTarget(dateJump)
            if (!target) { setJumpError('请输入正确日期'); return }
            calendar.current?.getApi().gotoDate(target)
            setDateJump(null); setJumpError('')
          }}>
            <div className="schedule-date-jump-fields">
              <label>{dateJump.week ? '起始日期' : '日期'}<input autoFocus aria-label="跳转起始日期" placeholder="YYYY-MM-DD" maxLength={10} value={dateJump.start} onChange={e => setDateJump({ ...dateJump, start: e.target.value })} /></label>
              {dateJump.week && <label>结束日期<input aria-label="跳转结束日期" placeholder="YYYY-MM-DD" maxLength={10} value={dateJump.end} onChange={e => setDateJump({ ...dateJump, end: e.target.value })} /></label>}
              <button type="submit" className="primary">跳转</button>
              <button type="button" aria-label="关闭日期跳转" onClick={() => setDateJump(null)}>×</button>
            </div>
            {dateJump.week && <p className="muted">修改任一日期，跳转至其所在周；两项都修改时使用起始日期。</p>}
            {jumpError && <p role="alert">{jumpError}</p>}
          </form>}
          <FullCalendar
            ref={calendar}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            locale={zhCnLocale}
            initialView="timeGridWeek"
            firstDay={1}
            nowIndicator
            now={follow.now}
            defaultTimedEventDuration="01:00:00"
            height={follow.height}
            slotMinTime={follow.axisStart}
            scrollTime={follow.scrollTime}
            datesSet={updateRange}
            customButtons={{ jumpDate: { text: dateTitle, hint: '填写日期并跳转', click: openDateJump } }}
            slotDuration="00:30:00"
            allDayText="全天"
            dayMaxEvents={3}
            eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
            buttonText={{ today: '今天', day: '日', week: '周', month: '月' }}
            headerToolbar={{
              left: 'prev jumpDate next today',
              center: '',
              right: 'timeGridDay,timeGridWeek,dayGridMonth'
            }}
            events={events}
            editable={false}
            eventResizableFromStart
            snapDuration="00:05:00"
            eventAllow={(range,event) => !busy && !blockEdit && !!event?.id.startsWith('block:') && !range.allDay && range.start.getTime() > Date.now()}
            eventDrop={stageBlockMove}
            eventResize={stageBlockMove}
            eventDragStart={() => setDragging(true)}
            eventDragStop={() => setDragging(false)}
            eventResizeStart={() => setDragging(true)}
            eventResizeStop={() => setDragging(false)}
            eventContent={(info) => (
              <div
                className="schedule-event-content"
                title={[
                  info.event.title,
                  info.event.extendedProps.location,
                  info.event.extendedProps.category
                ]
                  .filter(Boolean)
                  .join(' · ')}
                id={`calendar-event-${info.event.id}`}
                aria-label={`编辑日程：${info.event.title}`}
              >
                <b>{info.timeText}</b>
                <div className="schedule-event-name">{info.event.title}</div>
                {info.event.extendedProps.location && (
                  <div className="schedule-event-location">{info.event.extendedProps.location}</div>
                )}
              </div>
            )}
            eventDidMount={(info) => {
              info.el.setAttribute('role', 'button')
              info.el.setAttribute('tabindex', '0')
              info.el.setAttribute('aria-labelledby', `calendar-event-${info.event.id}`)
              info.el.onkeydown = (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  info.el.click()
                }
              }
            }}
            eventClick={(info) => {
              const task = tasks.find((t) => t.id === info.event.extendedProps.taskId)
              if (task) edit(task)
            }}
            dateClick={(info) => {
              if (!busy && canDiscardDraft())
                beginDraft(draftFor(undefined, info.date, info.allDay))
            }}
          />
        </section>
        {draft && (
          <aside className="schedule-editor" aria-label="日程编辑">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <div className="schedule-editor-heading">
              <h2>{draft.id ? '编辑日程' : '新建日程'}</h2>
              <button type="button" aria-label="关闭日程编辑" title="关闭日程编辑" disabled={busy} onClick={() => { if (canDiscardDraft()) setDraft(null) }}>×</button>
            </div>
            {selected?.project_id && (
              <p className="muted">
                来自项目{' '}
                <Link to={`/projects/${selected.project_id}`}>{selected.project_title}</Link>
                ；修改会同步到项目任务。
              </p>
            )}
            <label>
              名称
              <input
                aria-label="日程名称"
                value={draft.title}
                required
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="schedule-check">
              <input
                type="checkbox"
                aria-label="全天日程"
                disabled={!!selected && !!planning?.blocks.some(b=>b.task_id===selected.id)}
                checked={draft.allDay}
                onChange={(e) => {
                  const allDay = e.target.checked
                  const start = allDay
                    ? draft.start.slice(0, 10)
                    : draft.start
                      ? draft.start.slice(0, 10) + 'T08:00'
                      : ''
                  let end = allDay
                    ? draft.end.slice(0, 10)
                    : draft.end
                      ? draft.end.slice(0, 10) + 'T09:00'
                      : ''
                  if (allDay && start && (!end || end <= start)) {
                    const next = new Date(start + 'T00:00:00')
                    next.setDate(next.getDate() + 1)
                    end = localDate(next.getTime())
                  }
                  setDraft({ ...draft, allDay, start, end })
                }}
              />
              全天
            </label>
            <label>
              开始
              <input
                aria-label="日程开始"
                disabled={!!selected && !!planning?.blocks.some(b=>b.task_id===selected.id)}
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
              />
            </label>
            <label>
              {draft.allDay ? '结束日期（不含该日）' : '结束'}
              <input
                aria-label="日程结束"
                disabled={!!selected && !!planning?.blocks.some(b=>b.task_id===selected.id)}
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
              />
            </label>
            <label>
              截止时间（可空）
              <input
                aria-label="日程截止"
                type="datetime-local"
                value={draft.due}
                onChange={(e) => setDraft({ ...draft, due: e.target.value })}
              />
            </label>
            <label>
              地点
              <input
                aria-label="日程地点"
                maxLength={1000}
                value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              />
            </label>
            <label>
              说明
              <textarea
                aria-label="日程说明"
                value={draft.detail}
                maxLength={200000}
                onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
              />
            </label>
            {draft.id && (
              <label>
                状态
                <select
                  aria-label="日程状态"
                  value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as Task['status'] })}
                >
                  {Object.entries(STATUS).map(([key, value]) => (
                    <option value={key} key={key}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.status === 'blocked' && (
              <label>
                阻塞原因
                <input
                  aria-label="日程阻塞原因"
                  value={draft.reason}
                  required
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                />
              </label>
            )}
            {draftConflicts && (
              <section className="schedule-conflicts" aria-label="日程保存时间冲突" role="alert">
                <h3>发现时间冲突</h3>
                <p>当前日程尚未保存。请调整时间，或明确忽略以下冲突。</p>
                <ul>
                  {draftConflicts.items.map((conflict, index) => (
                    <li key={index}>
                      <strong>{conflict.other.title}</strong>（{displayTime(conflict.other.start)} —{' '}
                      {displayTime(conflict.other.end)}）与当前安排（
                      {displayTime(conflict.incoming.start)} — {displayTime(conflict.incoming.end)}
                      ）重合
                    </li>
                  ))}
                </ul>
                {draftConflicts.truncated && <p>仅显示前 200 处冲突。</p>}
                <label>
                  <input
                    type="checkbox"
                    aria-label="保存日程时忽略冲突"
                    checked={ignoreDraftConflicts}
                    onChange={(e) => setIgnoreDraftConflicts(e.target.checked)}
                  />
                  忽略冲突，仍保存日程
                </label>
              </section>
            )}
            <div className="toolbar">
              <button
                className="primary"
                disabled={
                  busy || !draft.title.trim() || (!!draftConflicts && !ignoreDraftConflicts)
                }
                type="submit"
              >
                保存日程
              </button>
              {selected && (
                <button type="button" disabled={busy} onClick={() => remove(selected)}>
                  删除日程
                </button>
              )}
            </div>
          </form>
          {selected && planning?.blocks.some(b=>b.task_id===selected.id) && <p className="muted">此任务按下方学习时间块安排。要改为固定日程，请先移除全部时间块并停用自动安排。</p>}
          {selected && planning && <TaskPlanningEditor key={`planning:${selected.id}`} taskId={selected.id} tasks={tasks} state={planning} onChange={setPlanning} onDraftState={planningDraftChanged} onEditBlock={editBlock} disabled={busy || JSON.stringify(draft)!==JSON.stringify(originalDraft.current)} />}
          {selected && <TaskReminderEditor key={`reminder:${selected.id}`} taskId={selected.id} onDraftState={reminderDraftChanged} disabled={busy || JSON.stringify(draft)!==JSON.stringify(originalDraft.current)} />}
          {selected && <TaskResources key={selected.id} taskId={selected.id} disabled={busy} initiallyOpen={targetTaskId === selected.id} />}
          </aside>
        )}
      </div>

      <section className="schedule-task-list" aria-label="任务清单">
        <h2>任务清单</h2>
        <p className="muted">
          先处理逾期与今日截止事项，给待安排任务设置时间。提醒中心保存处理记录；后台能力可在设置中启用。
        </p>
        {groups.map((group) => (
          <div className="schedule-group" key={group.name}>
            <h3>
              {group.name}（{group.items.length}）
            </h3>
            {group.items.map((t) => (
              <div className="schedule-task" key={t.id}>
                <input
                  type="checkbox"
                  aria-label={`完成任务：${t.title}`}
                  checked={t.status === 'done'}
                  disabled={busy}
                  onChange={() =>
                    void perform(async () => {
                      check(
                        await window.api.tasks.update(t.id, {
                          status: t.status === 'done' ? 'open' : 'done'
                        })
                      )
                      await reload()
                    })
                  }
                />
                <div className="grow">
                  <button className="schedule-task-name" onClick={() => edit(t)}>
                    {t.title}
                  </button>
                  <div className="muted">
                    {STATUS[t.status]}
                    {t.due_at !== null && ' · 截止 ' + displayTime(t.due_at)}
                    {t.project_title && ' · ' + t.project_title}
                  </div>
                  {t.location && <div className="muted">{t.location}</div>}
                </div>
                <button disabled={busy} onClick={() => edit(t)}>
                  编辑
                </button>
                <button disabled={busy} onClick={() => remove(t)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        ))}
      </section>
      {blockEdit && <ScheduleBlockEditor block={blockEdit.block} proposed={blockEdit.proposed} title={tasks.find(t => t.id === blockEdit.block.task_id)?.title ?? '已删除任务'} onClose={() => setBlockEdit(null)} onSaved={state => {setPlanning(state);setBlockEdit(null);showToast('学习时间块已调整并锁定');void reload()}}/>}
    </div>
  )
}
