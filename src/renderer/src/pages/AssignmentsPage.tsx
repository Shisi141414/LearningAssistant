import { CampusPanel, CampusSourceInfo } from '../components/CampusPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type {
  Assignment,
  AssignmentDetail,
  AssignmentHistory,
  AssignmentList,
  AssignmentPage as Page,
  AssignmentSave
} from '@shared/assignments'
import { assignmentStatuses } from '@shared/assignments'
import type { ApiResult } from '@shared/types'
import { useAppStore } from '../stores/app'
import { MathInput } from '../components/MathInput'
import { MarkdownSegment } from '../components/MarkdownSegment'
import { scheduleColor } from '@shared/schedule-colors'
import './assignments.css'

const read = <T,>(result: ApiResult<T>): T => {
  if (!result.ok) throw Error(result.error)
  return result.data
}
const time = (value: number | null) =>
  value === null
    ? '未设置截止时间'
    : new Date(value).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
const localTime = (value: number | null): string => {
  if (value === null) return ''
  const d = new Date(value),
    pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
interface Draft {
  title: string
  subject_id: string
  detail: string
  due: string
  status: AssignmentSave['status']
  blocked_reason: string
}
const draftFor = (a?: Assignment): Draft => ({
  title: a?.task.title ?? '',
  subject_id: a?.subject_id ?? '',
  detail: a?.task.detail ?? '',
  due: localTime(a?.task.due_at ?? null),
  status: (a?.deleted_at != null ? a.restore_status : a?.task.status) ?? 'open',
  blocked_reason: a?.task.blocked_reason ?? ''
})
const actions: Record<string, string> = {
  'campus-sync': '学校来源更新',
  create: '创建作业',
  edit: '编辑作业',
  'task-edit': '日程或提醒中的修改',
  'subject-edit': '学科调整',
  trash: '移入回收站',
  restore: '恢复作业',
  migrate: '旧作业升级'
}
function History({ item }: { item: AssignmentHistory }) {
  const payload = (value: string | null): Record<string, unknown> => {
    try {
      const p = JSON.parse(value || '{}')
      return p.task ?? p
    } catch {
      return {}
    }
  }
  const before = payload(item.before_json),
    after = payload(item.after_json)
  return (
    <details className="assignment-history-item">
      <summary>
        {actions[item.action] ?? '修改记录'} ·{' '}
        {new Date(item.created_at).toLocaleString('zh-CN')}
      </summary>
      {typeof after.title === 'string' && (
        <p>
          {typeof before.title === 'string' && before.title !== after.title
            ? `${before.title} → `
            : ''}
          {after.title}
        </p>
      )}
      {'due_at' in after && (
        <p>
          截止时间：
          {'due_at' in before && before.due_at !== after.due_at
            ? time(before.due_at as number | null) + ' → '
            : ''}
          {time(after.due_at as number | null)}
        </p>
      )}
      {item.action === 'campus-sync' && <p>学校{after.submitted ? '已提交' : '未提交'} · {String(after.course_title ?? '')}（本地完成状态独立保留）</p>}
      {item.action === 'trash' ? (
        <p>状态：回收站</p>
      ) : (
        typeof after.status === 'string' && (
          <p>
            状态：
            {assignmentStatuses[after.status as AssignmentSave['status']] ??
              after.status}
          </p>
        )
      )}
      {typeof after.detail === 'string' && after.detail && (
        <MarkdownSegment text={after.detail} />
      )}
      {item.action === 'trash' && (
        <p className="muted">
          已撤销当时的学习时间和固定日程，原安排保留在历史中。
        </p>
      )}
    </details>
  )
}
export function AssignmentsPage() {
  const [params, setParams] = useSearchParams(),
    id = params.get('assignment') || ''
  const { subjects, currentSubjectId, showToast } = useAppStore()
  const [subject, setSubject] = useState(currentSubjectId ?? 'all')
  const [scope, setScope] = useState<AssignmentList['scope']>('open'),
    [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0)
  const [page, setPage] = useState<Page>({ items: [], total: 0 }),
    [detail, setDetail] = useState<AssignmentDetail | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null),
    [baseline, setBaseline] = useState('')
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0)
  const locked = useRef(false),
    dirty = !!draft && JSON.stringify(draft) !== baseline
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const canLeave = useCallback(() => {
    if (locked.current) {
      showToast('作业正在保存，请稍候')
      return false
    }
    return !dirtyRef.current || window.confirm('放弃尚未保存的作业修改？')
  }, [showToast])
  const show = (a: AssignmentDetail | null, fresh = false) => {
    const value = a
      ? draftFor(a)
      : fresh
        ? { ...draftFor(), subject_id: currentSubjectId ?? '' }
        : null
    setDetail(a)
    setDraft(value)
    setBaseline(JSON.stringify(value))
  }
  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.api.assignments
      .list({
        query,
        scope,
        offset,
        ...(subject === 'all' ? {} : { subject_id: subject || null })
      })
      .then((result) => {
        if (alive) {
          try {
            setPage(read(result))
          } catch (e) {
            setError(String(e))
          }
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [query, scope, offset, subject, refresh])
  useEffect(() => {
    let alive = true
    setError('')
    show(null, id === 'new')
    if (id && id !== 'new')
      void window.api.assignments.get(id).then((result) => {
        if (alive) {
          try {
            show(read(result))
          } catch (e) {
            setError(String(e))
          }
        }
      })
    return () => {
      alive = false
    }
  }, [id])
  useEffect(() => {
    const beforeOpen = (e: Event) => {
      if (!canLeave()) e.preventDefault()
    }
    const follow = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.(
        'a[href]'
      ) as HTMLAnchorElement | null
      if (
        a &&
        a.href !== location.href &&
        a.origin === location.origin &&
        e.button === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !canLeave()
      ) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || locked.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('memo-before-navigate', beforeOpen)
    document.addEventListener('click', follow, true)
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('memo-before-navigate', beforeOpen)
      document.removeEventListener('click', follow, true)
      window.removeEventListener('beforeunload', unload)
    }
  }, [canLeave])
  const open = (next: string) => {
    if (canLeave()) setParams(next ? { assignment: next } : {})
  }
  const perform = async (job: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await job()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const save = () => {
    if (!draft) return
    void perform(async () => {
      // Retain the exact original timestamp when its displayed minute was untouched.
      const due =
        detail && draft.due === localTime(detail.task.due_at)
          ? detail.task.due_at
          : draft.due
            ? new Date(draft.due).getTime()
            : null
      if (due !== null && !Number.isFinite(due))
        throw Error('请输入正确的截止时间')
      const result = read(
        await window.api.assignments.save({
          ...(detail
            ? { id: detail.id, expected_revision: detail.revision }
            : {}),
          title: draft.title,
          detail: draft.detail,
          subject_id: draft.subject_id || null,
          due_at: due,
          status: draft.status,
          blocked_reason: draft.blocked_reason
        })
      )
      show(result)
      setParams({ assignment: result.id })
      setRefresh((n) => n + 1)
      showToast('作业已保存，日程同步更新')
    })
  }
  const archive = (a: Assignment, archived: boolean) => {
    if (!canLeave()) return
    if (
      archived &&
      !window.confirm(
        `将「${a.task.title}」移入回收站？它占用的学习时间会撤销，作业内容和历史会保留。`
      )
    )
      return
    void perform(async () => {
      const value = read(
        await window.api.assignments.archive({
          id: a.id,
          expected_revision: a.revision,
          archived
        })
      )
      if (id === a.id) show(value)
      setRefresh((n) => n + 1)
      showToast(archived ? '已移入回收站' : '作业已恢复，旧时间块不会自动恢复')
    })
  }
  const filter = (run: () => void) => {
    run()
    setOffset(0)
  }
  return (
    <div className="page assignments-page">
      <header className="assignments-header">
        <div>
          <h1>作业</h1>
          <p className="muted">整理要求与截止时间，把学习安排接到日程。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            if (id === 'new') {
              if (canLeave()) show(null, true)
            } else open('new')
          }}
        >
          新建作业
        </button>
      </header>
      <CampusPanel onImported={() => setRefresh(n => n + 1)} />
      <section className="assignments-filters" aria-label="作业筛选">
        <input
          aria-label="搜索作业"
          placeholder="搜索名称或要求"
          value={query}
          maxLength={500}
          onChange={(e) => filter(() => setQuery(e.target.value))}
        />
        <select
          aria-label="作业状态筛选"
          value={scope}
          onChange={(e) =>
            filter(() => setScope(e.target.value as AssignmentList['scope']))
          }
        >
          <option value="open">未完成</option>
          <option value="overdue">已逾期</option>
          <option value="all">全部作业</option>
          <option value="trash">回收站</option>
        </select>
        <select
          aria-label="作业学科筛选"
          value={subject}
          onChange={(e) => filter(() => setSubject(e.target.value))}
        >
          <option value="all">全部学科</option>
          <option value="">未分科</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span className="muted" role="status">
          {loading ? '正在读取…' : `${page.total} 项`}
        </span>
      </section>
      {error && (
        <div className="assignment-error" role="alert">
          {error}
          {detail && (
            <button
              disabled={busy}
              onClick={() => {
                if (canLeave())
                  void perform(async () => {
                    show(read(await window.api.assignments.get(detail.id)))
                    setRefresh((n) => n + 1)
                  })
              }}
            >
              重新载入作业
            </button>
          )}
        </div>
      )}
      <div className={'assignments-body' + (draft ? ' has-detail' : '')}>
        <section
          className="assignments-list"
          aria-label="作业列表"
          aria-busy={loading}
        >
          {!loading && !page.items.length && (
            <p className="muted assignment-empty">
              {scope === 'trash'
                ? '回收站为空。'
                : query || subject !== 'all'
                  ? '没有符合筛选条件的作业。'
                  : '这里还没有作业。点击“新建作业”记录要求和截止时间。'}
            </p>
          )}
          {page.items.map((a) => {
            const subjectName =
                subjects.find((s) => s.id === a.subject_id)?.name ?? '未分科',
              color = scheduleColor(
                a.subject_id ? '学科：' + subjectName : '作业'
              )
            const overdue =
              !a.deleted_at &&
              a.task.status !== 'done' &&
              a.task.due_at !== null &&
              a.task.due_at < Date.now()
            return (
              <article
                key={a.id}
                className={'assignment-row' + (id === a.id ? ' selected' : '')}
                style={{ borderLeftColor: color.text }}
              >
                <button
                  className="assignment-open"
                  onClick={() => open(a.id)}
                  aria-label={'打开作业 ' + a.task.title}
                >
                  <span
                    className="assignment-subject"
                    style={{ background: color.background, color: color.text }}
                  >
                    {subjectName}
                  </span>
                  <h2>{a.task.title}</h2>
                  <span className={overdue ? 'assignment-overdue' : 'muted'}>
                    {overdue ? '已逾期 · ' : ''}
                    {time(a.task.due_at)}
                  </span>
                  <span className="assignment-row-status">
                    {a.deleted_at !== null
                      ? '回收站'
                      : assignmentStatuses[a.task.status]}
                  </span>
                </button>
              </article>
            )
          })}
          {page.total > 50 && (
            <nav className="assignment-pagination" aria-label="作业分页">
              <button
                disabled={loading || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                上一页
              </button>
              <span>
                {Math.floor(offset / 50) + 1} / {Math.ceil(page.total / 50)}
              </span>
              <button
                disabled={loading || offset + 50 >= page.total}
                onClick={() => setOffset(offset + 50)}
              >
                下一页
              </button>
            </nav>
          )}
        </section>
        {draft && (
          <aside className="assignment-editor" aria-label="作业编辑">
            <div className="assignment-editor-heading">
              <h2>{detail ? '作业详情' : '新建作业'}</h2>
              <button
                aria-label="关闭作业编辑"
                disabled={busy}
                onClick={() => open('')}
              >
                ×
              </button>
            </div>
            {detail && <CampusSourceInfo id={detail.id} revision={detail.revision} />}
            {detail?.deleted_at !== null && detail && (
              <div className="assignment-trash-note">
                此作业已在回收站。恢复后保留截止时间，原有时间块不会自动恢复。
                <button disabled={busy} onClick={() => archive(detail, false)}>
                  恢复作业
                </button>
              </div>
            )}
            {detail && detail.deleted_at === null && (
              <p className="muted">
                {detail.source === 'manual'
                  ? '手动记录'
                  : '历史来源：' + detail.source}
                。本地完成状态由你管理。
                <Link to={`/review?task=${encodeURIComponent(detail.task.id)}`}>
                  打开日程与学习安排
                </Link>
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <fieldset
                disabled={busy || detail?.deleted_at != null}
                className="assignment-fields"
              >
                <label>
                  作业名称
                  <input
                    aria-label="作业名称"
                    value={draft.title}
                    required
                    maxLength={500}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                <div className="assignment-field-row">
                  <label>
                    学科
                    <select
                      aria-label="作业学科"
                      value={draft.subject_id}
                      onChange={(e) =>
                        setDraft({ ...draft, subject_id: e.target.value })
                      }
                    >
                      <option value="">未分科</option>
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    本地状态
                    <select
                      aria-label="作业状态"
                      value={draft.status}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          status: e.target.value as Draft['status']
                        })
                      }
                    >
                      {Object.entries(assignmentStatuses).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  截止时间
                  <input
                    type="datetime-local"
                    aria-label="作业截止时间"
                    value={draft.due}
                    onChange={(e) =>
                      setDraft({ ...draft, due: e.target.value })
                    }
                  />
                </label>
                {draft.status === 'blocked' && (
                  <label>
                    遇到的困难
                    <textarea
                      aria-label="作业困难原因"
                      value={draft.blocked_reason}
                      required
                      maxLength={2000}
                      onChange={(e) =>
                        setDraft({ ...draft, blocked_reason: e.target.value })
                      }
                    />
                  </label>
                )}
                <div inert={busy || detail?.deleted_at != null}>
                  <span className="assignment-field-label">具体要求</span>
                  <MathInput
                    key={detail?.id || 'new'}
                    label="作业要求"
                    value={draft.detail}
                    minHeight={130}
                    onChange={(value) => setDraft({ ...draft, detail: value })}
                  />
                </div>
                {detail?.deleted_at == null && (
                  <button
                    className="primary"
                    type="submit"
                    disabled={
                      busy || !draft.title.trim() || (!!detail && !dirty)
                    }
                  >
                    {busy ? '正在保存…' : '保存作业'}
                  </button>
                )}
              </fieldset>
            </form>
            {detail && (
              <>
                <details className="assignment-history">
                  <summary>修改历史（{detail.history_total}）</summary>
                  {detail.history_total > 100 && (
                    <p className="muted">
                      显示最近 100 次修改，其余记录仍保留。
                    </p>
                  )}
                  {detail.history.map((h) => (
                    <History key={h.id} item={h} />
                  ))}
                </details>
                {detail.deleted_at === null && (
                  <button
                    className="assignment-trash"
                    disabled={busy}
                    onClick={() => archive(detail, true)}
                  >
                    移入回收站
                  </button>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
