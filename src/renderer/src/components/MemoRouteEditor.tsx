import { useState } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import type {
  MemoDetail,
  MemoProposal,
  MemoRoutePlan,
  MemoRoutePreview
} from '@shared/memos'
import { memoTimestamp } from '@shared/memo-recognition'
import { useAppStore } from '../stores/app'
import { useConceptStore } from '../stores/concepts'

const inputTime = (n: number | null): string =>
  n === null
    ? ''
    : new Date(n - new Date(n).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
const parseTime = (s: string): number | null =>
  s
    ? Temporal.PlainDateTime.from(s, { overflow: 'reject' }).toZonedDateTime(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        { disambiguation: 'reject' }
      ).epochMilliseconds
    : null
export function MemoRouteEditor({
  detail,
  proposal,
  disabled,
  onDirty,
  onBusy,
  onSaved
}: {
  detail: MemoDetail
  proposal: MemoProposal | null
  disabled: boolean
  onDirty: () => void
  onBusy: (busy: boolean) => void
  onSaved: (d: MemoDetail) => void
}) {
  const { subjects } = useAppStore(),
    { items: concepts } = useConceptStore()
  const [kind, setKind] = useState(proposal?.knowledge ? 'new' : 'none'),
    [concept, setConcept] = useState('')
  const [name, setName] = useState(proposal?.knowledge?.name ?? ''),
    [summary, setSummary] = useState(proposal?.knowledge?.summary ?? ''),
    [subject, setSubject] = useState(detail.memo.subject_id ?? '')
  const [task, setTask] = useState(!!proposal?.task),
    [title, setTitle] = useState(proposal?.task?.title ?? ''),
    [description, setDescription] = useState(proposal?.task?.detail ?? '')
  const [start, setStart] = useState(
      inputTime(memoTimestamp(proposal?.task?.start ?? null))
    ),
    [end, setEnd] = useState(
      inputTime(memoTimestamp(proposal?.task?.end ?? null))
    ),
    [due, setDue] = useState(
      inputTime(memoTimestamp(proposal?.task?.due ?? null))
    ),
    [location, setLocation] = useState(proposal?.task?.location ?? '')
  const [preview, setPreview] = useState<MemoRoutePreview | null>(null),
    [checked, setChecked] = useState<MemoRoutePlan | null>(null),
    [ignore, setIgnore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const changed = (): void => {
    setPreview(null)
    setChecked(null)
    setIgnore(false)
    setError('')
    onDirty()
  }
  const check = async (): Promise<void> => {
    setBusy(true)
    onBusy(true)
    setError('')
    try {
      const chosen = concepts.find((c) => c.id === concept)
      if (kind === 'existing' && !chosen) throw Error('请选择已有知识点')
      const plan: MemoRoutePlan = {
        id: detail.memo.id,
        expected_revision: detail.memo.revision,
        knowledge:
          kind === 'none'
            ? null
            : kind === 'existing'
              ? { kind: 'existing', id: chosen!.id, revision: chosen!.revision }
              : { kind: 'new', name, summary, subject_id: subject },
        task: task
          ? {
              title,
              detail: description,
              planned_at: parseTime(start),
              planned_end_at: parseTime(end),
              due_at: parseTime(due),
              location
            }
          : null
      }
      const r = await window.api.memos.preview(plan)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setChecked(plan)
      setPreview(r.data)
      setIgnore(false)
    } catch (e) {
      setError(
        e instanceof RangeError
          ? '请输入正确日期'
          : String(e instanceof Error ? e.message : e)
      )
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    if (!preview || !checked) return
    setBusy(true)
    onBusy(true)
    setError('')
    try {
      const r = await window.api.memos.apply({
        plan: checked,
        fingerprint: preview.fingerprint,
        ignore_conflicts: ignore
      })
      if (!r.ok) {
        setError(r.error)
        setPreview(null)
        return
      }
      onSaved(r.data)
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  return (
    <section className="memo-routing" aria-label="备忘归档">
      <h2>整理到知识或日程</h2>
      <p className="muted">
        可同时关联知识并创建待办。已有同名或别名知识优先复用，原有释义不被覆盖。留空时间的待办进入待安排。
      </p>
      {proposal?.uncertainties.map((s, i) => (
        <p key={i} className="memo-warning">
          待核对：{s}
        </p>
      ))}
      {proposal?.task?.time_text && <p>原文时间：{proposal.task.time_text}</p>}
      <fieldset disabled={disabled || busy} onChange={changed}>
        <label>
          知识处理
          <select
            aria-label="知识处理"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="none">不添加知识</option>
            <option value="existing">关联已有知识</option>
            <option value="new">整理命名知识</option>
          </select>
        </label>
        {kind === 'existing' && (
          <label>
            已有知识点
            <select
              aria-label="已有知识点"
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
            >
              <option value="">请选择</option>
              {concepts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（
                  {subjects.find((s) => s.id === c.subject_id)?.name ?? '通用'}
                  ）
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'new' && (
          <>
            <label>
              知识名称
              <input
                aria-label="备忘知识名称"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              学科
              <select
                aria-label="备忘知识学科"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">请选择学科</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              知识说明
              <textarea
                aria-label="备忘知识说明"
                maxLength={4000}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </label>
          </>
        )}
        <label className="memo-check">
          <input
            type="checkbox"
            aria-label="创建备忘待办"
            checked={task}
            onChange={(e) => setTask(e.target.checked)}
          />
          同时创建待办或固定日程
        </label>
        {task && (
          <>
            <label>
              待办名称
              <input
                aria-label="备忘待办名称"
                value={title}
                maxLength={500}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              要求
              <textarea
                aria-label="备忘待办要求"
                maxLength={4000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="memo-times">
              <label>
                计划开始
                <input
                  aria-label="备忘计划开始"
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label>
                计划结束
                <input
                  aria-label="备忘计划结束"
                  type="datetime-local"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
              <label>
                截止时间
                <input
                  aria-label="备忘截止时间"
                  type="datetime-local"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                />
              </label>
            </div>
            <label>
              地点
              <input
                aria-label="备忘地点"
                maxLength={1000}
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
          </>
        )}
        <button
          disabled={kind === 'none' && !task}
          onClick={() => void check()}
        >
          检查归档
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div className="memo-preview" aria-label="备忘归档预览">
          {preview.duplicate_route_id ? (
            <p>
              相同修订与归档内容已处理，重复确认不会新建；已撤销的记录也保留去重。
            </p>
          ) : (
            <>
              <p>
                确认后
                {checked?.knowledge
                  ? `将${preview.existing_concept_id ? '复用已有' : '新建'}知识点；`
                  : ''}
                {checked?.task ? '将新建一项待办。' : '不创建待办。'}
              </p>
              {preview.conflicts.items.map((c, i) => (
                <p key={i}>
                  时间冲突：{c.other.title} ·{' '}
                  {new Date(c.other.start).toLocaleString('zh-CN')}
                </p>
              ))}
              {preview.conflicts.truncated && (
                <p>冲突过多，仅显示前 200 项。</p>
              )}
              {!!preview.conflicts.items.length && (
                <label className="memo-check">
                  <input
                    type="checkbox"
                    aria-label="忽略备忘时间冲突"
                    disabled={busy || disabled}
                    checked={ignore}
                    onChange={(e) => setIgnore(e.target.checked)}
                  />
                  我已核对，忽略时间冲突
                </label>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  disabled ||
                  (!!preview.conflicts.items.length && !ignore)
                }
                onClick={() => void apply()}
              >
                确认归档
              </button>
            </>
          )}
        </div>
      )}
    </section>
  )
}
