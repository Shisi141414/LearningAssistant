import { ReviewPlanningPanel } from '../components/ReviewPlanningPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type {
  ReviewAction,
  ReviewDetail,
  ReviewGrade,
  ReviewListInput,
  ReviewPage as ReviewList,
  ReviewReveal
} from '@shared/reviews'
import { reviewGrades } from '@shared/reviews'
import { exerciseFields, exerciseTexts } from '@shared/exercises'
import { useAppStore } from '../stores/app'
import { MarkdownSegment } from '../components/MarkdownSegment'
import { LearningEntryFigures } from '../components/LearningFigures'
import './reviews.css'

const date = (n: number) =>
  new Date(n).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
const actions = {
  grade: '评分',
  undo: '撤销评分',
  pause: '暂停',
  resume: '恢复',
  refresh: '采用新版内容'
}
export function ReviewPage() {
  const [params, setParams] = useSearchParams(),
    id = params.get('card') ?? ''
  const { subjects, showToast } = useAppStore()
  const [scope, setScope] = useState<ReviewListInput['scope']>('today'),
    [subject, setSubject] = useState('all'),
    [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ReviewList | null>(null),
    [detail, setDetail] = useState<ReviewDetail | null>(null)
  const [reveal, setReveal] = useState<ReviewReveal | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0),
    [now, setNow] = useState(Date.now()),
    [loading, setLoading] = useState(false)
  const planningDraft = useRef({ dirty: false, busy: false })
  const planningDraftChanged = useCallback(
    (value: { dirty: boolean; busy: boolean }) => {
      planningDraft.current = value
    },
    []
  )
  const canLeavePlanning = () => {
    if (planningDraft.current.busy) {
      showToast('复习安排正在保存，请稍候')
      return false
    }
    return (
      !planningDraft.current.dirty ||
      window.confirm('复习安排尚未保存，放弃这些输入？')
    )
  }
  const lock = useRef(false),
    generation = useRef(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
      setRefresh((n) => n + 1)
    }, 30_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let alive = true
    void window.api.reviews
      .list({
        scope,
        offset,
        ...(subject === 'all' ? {} : { subject_id: subject || null })
      })
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setPage(result.data)
          setNow(result.data.now)
        } else setError(result.error)
      })
    return () => {
      alive = false
    }
  }, [scope, subject, offset, refresh])
  useEffect(() => {
    const token = ++generation.current
    setDetail(null)
    setReveal(null)
    setError('')
    setLoading(!!id)
    if (id)
      void window.api.reviews.get(id).then((result) => {
        if (token !== generation.current) return
        setLoading(false)
        if (result.ok) setDetail(result.data)
        else setError(result.error)
      })
    return () => {
      generation.current++
    }
  }, [id])
  const perform = async (fn: (valid: () => boolean) => Promise<void>) => {
    if (lock.current || !canLeavePlanning()) return
    lock.current = true
    setBusy(true)
    setError('')
    const token = ++generation.current
    try {
      await fn(() => token === generation.current)
    } catch (e) {
      if (token === generation.current)
        setError(e instanceof Error ? e.message : String(e))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const action = (action: ReviewAction['action']) => {
    if (!detail) return
    if (
      action === 'refresh' &&
      !window.confirm(
        '采用原题或知识点的最新内容？记忆进度与旧评分来源会保留。'
      )
    )
      return
    void perform(async (valid) => {
      const result = await window.api.reviews.action({
        id: detail.id,
        expected_revision: detail.revision,
        action
      })
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      setDetail(result.data)
      setReveal(null)
      setRefresh((n) => n + 1)
      showToast(actions[action] + '已保存')
    })
  }
  const showAnswer = () =>
    detail &&
    void perform(async (valid) => {
      const result = await window.api.reviews.reveal({
        id: detail.id,
        expected_revision: detail.revision
      })
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      setDetail(result.data.detail)
      setReveal(result.data)
      setNow(Date.now())
    })
  const grade = (grade: ReviewGrade) =>
    reveal &&
    void perform(async (valid) => {
      const result = await window.api.reviews.grade({
        token: reveal.token,
        grade
      })
      if (!valid()) return
      if (!result.ok) throw Error(result.error)
      setDetail(result.data)
      setReveal(null)
      setNow(Date.now())
      setRefresh((n) => n + 1)
      showToast(
        `已记录“${reviewGrades[grade]}”，下次 ${date(result.data.due_at)}`
      )
    })
  const due =
    detail && detail.active && detail.available && detail.due_at <= now
  const exercise = detail?.snapshot.exercise,
    texts = exercise ? exerciseTexts(exercise) : null
  const field = (role: keyof typeof exerciseFields) => {
    if (!exercise || !texts?.[role].trim()) return null
    const entry = exercise.document.state.entries.find(
      (e) => e.id === exercise.document.fields[role]
    )
    return (
      <section className={`review-field field-${role}`} key={role}>
        <h3>{exerciseFields[role]}</h3>
        <MarkdownSegment text={texts[role]} subjectId={exercise.subject_id} />
        {!!entry?.figures?.length && (
          <LearningEntryFigures
            figures={entry.figures}
            assets={exercise.origin?.assets ?? []}
          />
        )}
      </section>
    )
  }
  const next = page?.items.find(
    (item) =>
      item.id !== id && item.active && item.available && item.due_at <= now
  )
  return (
    <div className="page reviews-page">
      <header className="reviews-heading">
        <div>
          <h1>复习</h1>
          <p className="muted">
            先回忆，再看答案。每一次反馈，决定下一次相遇。
          </p>
        </div>
        <Link to="/review">查看日程</Link>
      </header>
      <div className="reviews-filters" aria-label="复习筛选">
        <label>
          范围
          <select
            aria-label="复习范围"
            disabled={busy}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as typeof scope)
              setOffset(0)
            }}
          >
            <option value="today">今日与逾期</option>
            <option value="all">全部条目</option>
            <option value="paused">暂停与不可用</option>
          </select>
        </label>
        <label>
          学科
          <select
            aria-label="复习学科"
            disabled={busy}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value)
              setOffset(0)
            }}
          >
            <option value="all">全部学科</option>
            <option value="">未分科</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <span role="status">现在可复习 {page?.due_now ?? 0} 项</span>
        <button
          disabled={busy}
          onClick={() => {
            if (!canLeavePlanning()) return
            setRefresh((n) => n + 1)
            if (detail) {
              const token = ++generation.current
              void window.api.reviews.get(detail.id).then((r) => {
                if (token !== generation.current) return
                if (r.ok) {
                  setDetail(r.data)
                  setReveal(null)
                } else setError(r.error)
              })
            }
          }}
        >
          刷新
        </button>
      </div>
      {error && (
        <p className="review-notice" role="alert">
          {error}
        </p>
      )}
      {!!page?.legacy_count && (
        <p className="review-notice">
          检测到 {page.legacy_count}{' '}
          条旧版复习记录，原样保留。其算法版本不明确，未擅自转换成新记忆状态；可从来源重新加入当前复习库。
        </p>
      )}
      <div className="reviews-workspace">
        <aside className="review-queue" aria-label="复习清单">
          <h2>
            {scope === 'today'
              ? '今日清单'
              : scope === 'all'
                ? '全部复习'
                : '暂停与不可用'}{' '}
            <small>{page?.total ?? 0}</small>
          </h2>
          {page?.items.map((item) => (
            <button
              className={`review-queue-item${item.id === id ? ' selected' : ''}`}
              disabled={busy}
              key={item.id}
              onClick={() => {
                if (item.id !== id && canLeavePlanning())
                  setParams({ card: item.id })
              }}
            >
              <strong>{item.title}</strong>
              <span>
                {item.kind === 'concept' ? '知识点' : '习题'} ·{' '}
                {!item.available
                  ? '来源不可用'
                  : !item.active
                    ? '已暂停'
                    : item.due_at <= now
                      ? '现在可复习'
                      : date(item.due_at)}
              </span>
            </button>
          ))}
          {page && !page.total && (
            <p className="muted">暂无条目。可从知识点或习题详情“加入复习”。</p>
          )}
          <nav aria-label="复习分页">
            <button
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              上一页
            </button>
            <button
              disabled={busy || page?.next_offset == null}
              onClick={() => setOffset(page!.next_offset!)}
            >
              下一页
            </button>
          </nav>
        </aside>
        <section className="review-session" aria-label="复习练习">
          {loading && <p role="status">正在打开复习条目…</p>}
          {!id && (
            <div className="review-empty">
              <h2>把所学留在记忆里</h2>
              <p>选择左侧到期条目，遮住答案回忆定义、条件或解题过程。</p>
              <Link to="/knowledge">选择知识点</Link> ·{' '}
              <Link to="/exercises">选择习题</Link>
            </div>
          )}
          {detail && (
            <>
              <div className="review-session-heading">
                <div>
                  <small>
                    {detail.kind === 'concept' ? '知识回忆' : '习题练习'} ·
                    已复习 {detail.reps} 次
                  </small>
                  <h2>{detail.title}</h2>
                </div>
                <Link
                  to={
                    detail.kind === 'concept'
                      ? `/knowledge?concept=${encodeURIComponent(detail.source_id)}`
                      : `/exercises/${encodeURIComponent(detail.source_id)}?revision=${encodeURIComponent(detail.source_revision)}`
                  }
                >
                  查看来源
                </Link>
              </div>
              {detail.source_changed && (
                <div className="review-notice">
                  原内容已有新版本。本次仍使用加入或更新时的版本。
                  <button disabled={busy} onClick={() => action('refresh')}>
                    采用最新内容
                  </button>
                </div>
              )}
              {!detail.available && (
                <p className="review-notice">
                  来源已删除或在回收站中，复习与提醒已停止；历史内容仍保留。
                </p>
              )}
              <div className="review-prompt">
                {exercise ? (
                  field('statement')
                ) : (
                  <MarkdownSegment
                    text={detail.snapshot.prompt}
                    subjectId={detail.subject_id}
                  />
                )}
              </div>
              {reveal ? (
                <>
                  <div className="review-answer" aria-label="复习答案">
                    {exercise ? (
                      <>
                        {field('approach')}
                        {field('standard_answer')}
                        {field('user_answer')}
                        {field('error_reason')}
                      </>
                    ) : (
                      <>
                        <h3>释义与适用条件</h3>
                        <MarkdownSegment
                          text={detail.snapshot.answer}
                          subjectId={detail.subject_id}
                        />
                        {!!detail.snapshot.aliases.length && (
                          <p>同义名称：{detail.snapshot.aliases.join('、')}</p>
                        )}
                      </>
                    )}
                  </div>
                  <p className="muted">
                    按看答案前的回忆情况评分。“困难”仍表示回忆成功；答不出请选择“忘记”。此评分不改动习题对错。
                  </p>
                  <div className="review-ratings" aria-label="记忆评分">
                    {reveal.choices.map((choice) => (
                      <button
                        key={choice.grade}
                        className={`grade-${choice.grade}`}
                        disabled={busy || reveal.expires_at < now}
                        onClick={() => grade(choice.grade)}
                      >
                        <strong>{reviewGrades[choice.grade]}</strong>
                        <small>约 {date(choice.due_at)}</small>
                      </button>
                    ))}
                  </div>
                  <p className="muted">
                    预览按显示答案时计算；提交按实际评分时间计算。目标保持率
                    90%，不是个人记忆效果保证。
                  </p>
                  {reveal.expires_at < now && (
                    <button disabled={busy} onClick={showAnswer}>
                      重新显示答案以继续评分
                    </button>
                  )}
                </>
              ) : (
                <div className="review-ready">
                  {due ? (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={showAnswer}
                    >
                      显示答案
                    </button>
                  ) : (
                    <p>
                      {!detail.active
                        ? '此条目已暂停'
                        : !detail.available
                          ? '恢复来源后可继续复习'
                          : `下次建议复习：${date(detail.due_at)}`}
                    </p>
                  )}
                  <button
                    disabled={busy || !next}
                    onClick={() => {
                      if (next && canLeavePlanning())
                        setParams({ card: next.id })
                    }}
                  >
                    下一条到期
                  </button>
                </div>
              )}
              <div className="review-management">
                <button
                  disabled={busy || !detail.available}
                  onClick={() => action(detail.active ? 'pause' : 'resume')}
                >
                  {detail.active ? '暂停复习' : '恢复复习'}
                </button>
                <button
                  disabled={busy || !detail.can_undo}
                  onClick={() => action('undo')}
                >
                  撤销最近评分
                </button>
                <Link to={`/review?task=${encodeURIComponent(detail.task_id)}`}>
                  查看复习日程
                </Link>
              </div>
              <ReviewPlanningPanel
                id={detail.id}
                revision={detail.revision}
                onDraftState={planningDraftChanged}
              />
              <details className="review-history">
                <summary>最近记录 · 保留固定来源版本</summary>
                {detail.history.length ? (
                  <ol>
                    {detail.history.map((log) => (
                      <li key={log.id}>
                        {date(log.created_at)} · {actions[log.action]}
                        {log.grade && `：${reviewGrades[log.grade]}`}
                        {log.undone && '（已撤销）'} · 下次 {date(log.due_at)}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">尚无评分记录。</p>
                )}
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
