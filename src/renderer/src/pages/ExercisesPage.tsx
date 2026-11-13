import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ExerciseDetail, ExerciseInput, ExercisePage, ExerciseStatus } from '@shared/exercises'
import { exerciseFields, exerciseStatuses, exerciseTexts } from '@shared/exercises'
import { useAppStore } from '../stores/app'
import { useConceptStore } from '../stores/concepts'
import { MathInput } from '../components/MathInput'
import { MarkdownSegment } from '../components/MarkdownSegment'
import { LearningEntryFigures } from '../components/LearningFigures'
import { LearningPdfExport } from '../components/LearningPdfExport'
import './exercises.css'

const blank = (subject: string | null): ExerciseInput => ({
  title: '',
  subject_id: subject,
  status: 'unfinished',
  question_type: '',
  source_label: '',
  no_idea: false,
  review_concept_ids: [],
  fields: { statement: '', approach: '', standard_answer: '', user_answer: '', error_reason: '' }
})

export function ExercisesPage() {
  const { subjects, currentSubjectId } = useAppStore()
  const concepts = useConceptStore((s) => s.items)
  const [query, setQuery] = useState(''),
    [subject, setSubject] = useState(currentSubjectId ?? 'all')
  const [status, setStatus] = useState(''),
    [type, setType] = useState(''),
    [concept, setConcept] = useState('')
  const [trash, setTrash] = useState(false),
    [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ExercisePage | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    const timer = setTimeout(() => {
      void window.api.exercises
        .list({
          query,
          ...(subject !== 'all' ? { subject_id: subject || null } : {}),
          ...(status ? { status: status as ExerciseStatus } : {}),
          ...(type.trim() ? { question_type: type.trim() } : {}),
          ...(concept ? { concept_id: concept } : {}),
          trash,
          offset
        })
        .then((result) => {
          if (!alive) return
          setLoading(false)
          if (result.ok) setPage(result.data)
          else {
            setError(result.error)
            setPage(null)
          }
        })
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, subject, status, type, concept, trash, offset])
  const filter = (set: (value: string) => void, value: string) => {
    set(value)
    setOffset(0)
  }
  return (
    <div className="page exercises-page">
      <div className="exercise-page-heading">
        <div>
          <h1>习题库</h1>
          <p className="muted">把解题过程留下来，也把需要重温的知识连起来。</p>
        </div>
        <Link className="exercise-new" to="/exercises/new">
          + 新建习题
        </Link>
      </div>
      <div className="exercise-filters">
        <input
          aria-label="搜索习题"
          maxLength={500}
          value={query}
          placeholder="搜索题目、答案、思路或来源…"
          onChange={(e) => filter(setQuery, e.target.value)}
        />
        <select
          aria-label="习题学科筛选"
          value={subject}
          onChange={(e) => filter(setSubject, e.target.value)}
        >
          <option value="all">全部学科</option>
          <option value="">未分科</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="习题状态筛选"
          value={status}
          onChange={(e) => filter(setStatus, e.target.value)}
        >
          <option value="">全部作答状态</option>
          {Object.entries(exerciseStatuses).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <input
          aria-label="习题题型筛选"
          list="exercise-type-filter"
          maxLength={120}
          value={type}
          placeholder="全部题型"
          onChange={(e) => filter(setType, e.target.value)}
        />
        <datalist id="exercise-type-filter">
          {['计算', '证明', '选择', '填空', '简答', '综合'].map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <select
          aria-label="习题知识点筛选"
          value={concept}
          onChange={(e) => filter(setConcept, e.target.value)}
        >
          <option value="">全部复习知识点</option>
          {concepts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          aria-pressed={trash}
          onClick={() => {
            setTrash(!trash)
            setOffset(0)
          }}
        >
          {trash ? '返回习题' : '回收站'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p className="muted" role="status">
        {loading ? '正在读取习题…' : `${page?.total ?? 0} 道${trash ? '已删除' : ''}习题`}
      </p>
      <div className="exercise-list" aria-busy={loading}>
        {!loading &&
          page?.items.map((item) => (
            <Link className="exercise-list-item" key={item.id} to={`/exercises/${item.id}`}>
              <span className={`exercise-status status-${item.status}`}>
                {exerciseStatuses[item.status]}
              </span>
              <div className="grow">
                <h3>{item.title}</h3>
                <p className="muted">
                  {[
                    subjects.find((s) => s.id === item.subject_id)?.name || '未分科',
                    item.question_type,
                    item.source_label
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {item.no_idea && <span className="exercise-no-idea">暂无思路</span>}
              <span className="muted">查看 →</span>
            </Link>
          ))}
      </div>
      {!loading && page?.total === 0 && (
        <div className="empty">
          {trash
            ? '回收站是空的。'
            : '还没有匹配的习题。可手动新建，或在教材的习题、例题条目下加入习题库。'}
        </div>
      )}
      <div className="toolbar">
        <button disabled={loading || !offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
          上一页
        </button>
        <span className="muted">
          {page?.total ? offset + 1 : 0}–{offset + (page?.items.length ?? 0)} / {page?.total ?? 0}
        </span>
        <button
          disabled={loading || page?.next_offset == null}
          onClick={() => setOffset(page!.next_offset!)}
        >
          下一页
        </button>
      </div>
    </div>
  )
}

export function ExerciseDetailPage() {
  const { exerciseId = '' } = useParams()
  return <ExerciseEditor key={exerciseId} exerciseId={exerciseId} />
}
function ExerciseEditor({ exerciseId }: { exerciseId: string }) {
  const navigate = useNavigate(),
    { subjects, currentSubjectId, showToast } = useAppStore()
  const { items: concepts, error: conceptError } = useConceptStore()
  const isNew = exerciseId === 'new'
  const [detail, setDetail] = useState<ExerciseDetail | null>(null),
    [draft, setDraft] = useState(() => blank(currentSubjectId))
  const [baseline, setBaseline] = useState(() => JSON.stringify(blank(currentSubjectId)))
  const [editing, setEditing] = useState(isNew),
    [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conceptQuery, setConceptQuery] = useState('')
  const lock = useRef(false)
  const dirty = editing && JSON.stringify(draft) !== baseline
  const apply = (value: ExerciseDetail): void => {
    const s = value.snapshot
    const next: ExerciseInput = {
      title: s.title,
      subject_id: s.subject_id,
      status: s.status,
      question_type: s.question_type,
      source_label: s.source_label,
      no_idea: s.no_idea,
      review_concept_ids: s.review_concept_ids,
      fields: exerciseTexts(s)
    }
    setDetail(value)
    setDraft(next)
    setBaseline(JSON.stringify(next))
    setEditing(false)
  }
  useEffect(() => {
    if (isNew) return
    let alive = true
    void window.api.exercises.get({ id: exerciseId }).then((result) => {
      if (!alive) return
      setLoading(false)
      if (result.ok) apply(result.data)
      else setError(result.error)
    })
    return () => {
      alive = false
    }
  }, [exerciseId, isNew])
  useEffect(() => {
    if (!dirty) return
    const leave = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
      if (
        link &&
        link.href !== window.location.href &&
        !window.confirm('习题有未保存的修改，仍要离开吗？')
      ) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('click', leave, true)
    return () => {
      document.removeEventListener('click', leave, true)
    }
  }, [dirty])
  const set = <K extends keyof ExerciseInput>(key: K, value: ExerciseInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const read = async (revision?: string) => {
    if (dirty && !window.confirm('读取修订会放弃未保存的修改，继续吗？')) return
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.api.exercises.get({
        id: exerciseId,
        ...(revision ? { revision_id: revision } : {})
      })
      if (result.ok) apply(result.data)
      else setError(result.error)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const save = async () => {
    if (lock.current) return
    if (!draft.title.trim() || !draft.fields.statement.trim()) {
      setError('请填写习题标题和题面')
      return
    }
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.api.exercises.save({
        ...draft,
        ...(!isNew && detail
          ? { id: exerciseId, expected_revision_id: detail.current_revision_id }
          : {})
      })
      if (result.ok) {
        apply(result.data)
        showToast('习题已保存')
        if (isNew) navigate(`/exercises/${result.data.id}`, { replace: true })
      } else setError(result.error)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const trash = async (restore: boolean) => {
    if (
      !detail ||
      lock.current ||
      (!restore && !window.confirm('将此题移入回收站？答案与历史会保留，可恢复。'))
    )
      return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const input = { id: exerciseId, expected_revision_id: detail.current_revision_id }
      const result = restore
        ? await window.api.exercises.restore(input)
        : await window.api.exercises.trash(input)
      if (result.ok) {
        apply(result.data)
        showToast(restore ? '习题已恢复' : '习题已移入回收站')
      } else setError(result.error)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  if (loading)
    return (
      <div className="page" role="status">
        正在读取习题…
      </div>
    )
  if (!isNew && !detail)
    return (
      <div className="page">
        <Link to="/exercises">← 习题库</Link>
        <p role="alert">{error}</p>
      </div>
    )
  const current = !detail || detail.revision_id === detail.current_revision_id
  const deleted = detail?.deleted_at != null
  const snapshot = detail?.snapshot,
    source = snapshot?.origin
  const displayed = snapshot ? exerciseTexts(snapshot) : draft.fields
  const linked = draft.review_concept_ids
  return (
    <div className="page exercise-detail">
      <Link to="/exercises">← 习题库</Link>
      <div className="exercise-page-heading">
        <div>
          <h1>{isNew ? '新建习题' : snapshot?.title}</h1>
          <p className="muted">
            {editing
              ? '分区记录思路与作答。公式可直接编辑。'
              : '题面、解答和复习线索保存在同一道题中。'}
          </p>
        </div>
        {!editing && snapshot && (
          <span className={`exercise-status status-${snapshot.status}`}>
            {exerciseStatuses[snapshot.status]}
          </span>
        )}
      </div>
      {error && (
        <p className="material-error" role="alert">
          {error}
        </p>
      )}
      <div className="toolbar exercise-actions">
        {editing ? (
          <>
            <button className="primary" disabled={busy} onClick={() => void save()}>
              保存习题
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (!dirty || window.confirm('放弃未保存的修改？')) {
                  if (isNew) navigate('/exercises')
                  else if (detail) apply(detail)
                }
              }}
            >
              取消编辑
            </button>
            <span className="muted">{dirty ? '有未保存的修改' : '尚无修改'}</span>
          </>
        ) : (
          <>
            {current && !deleted && (
              <button className="primary" disabled={busy} onClick={() => setEditing(true)}>
                编辑习题
              </button>
            )}
            <button disabled={busy} onClick={() => void read()}>
              读取当前修订
            </button>
            {current && (
              <button
                disabled={busy}
                className={deleted ? '' : 'danger'}
                onClick={() => void trash(deleted)}
              >
                {deleted ? '恢复习题' : '删除习题'}
              </button>
            )}
          </>
        )}
        {detail && (
          <label>
            历史修订{' '}
            <select
              aria-label="习题修订"
              disabled={busy || editing}
              value={detail.revision_id}
              onChange={(e) => void read(e.target.value)}
            >
              {detail.history.map((item, i) => (
                <option key={item.id} value={item.id}>
                  修订 {detail.history.length - i}
                  {item.id === detail.current_revision_id ? '（当前）' : ''} ·{' '}
                  {new Date(item.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {deleted && <p role="status">此题已在回收站，恢复后可继续编辑。原题与答案均保留。</p>}
      {!current && <p role="status">正在查看历史修订，内容只读。</p>}
      {editing ? (
        <fieldset disabled={busy} inert={busy} className="exercise-form">
          <div className="exercise-meta-grid">
            <label>
              习题标题
              <input
                aria-label="习题标题"
                maxLength={500}
                value={draft.title}
                onChange={(e) => set('title', e.target.value)}
              />
            </label>
            <label>
              学科
              <select
                aria-label="习题学科"
                value={draft.subject_id ?? ''}
                onChange={(e) => set('subject_id', e.target.value || null)}
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
              作答状态
              <select
                aria-label="习题作答状态"
                value={draft.status}
                onChange={(e) => set('status', e.target.value as ExerciseStatus)}
              >
                {Object.entries(exerciseStatuses).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              题型
              <input
                aria-label="习题题型"
                maxLength={120}
                list="exercise-types"
                value={draft.question_type}
                onChange={(e) => set('question_type', e.target.value)}
                placeholder="如：计算、证明，可自行填写"
              />
              <datalist id="exercise-types">
                {['计算', '证明', '选择', '填空', '简答', '综合'].map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
            <label className="exercise-source-label">
              来源
              <input
                aria-label="习题来源"
                maxLength={2000}
                value={draft.source_label}
                onChange={(e) => set('source_label', e.target.value)}
                placeholder="教材、章节、页码、考试年份等"
              />
            </label>
            <label className="exercise-check">
              <input
                type="checkbox"
                checked={draft.no_idea}
                onChange={(e) => set('no_idea', e.target.checked)}
              />
              暂无解题思路
            </label>
          </div>
          <div className="exercise-concept-picker">
            <h3>需复习知识点</h3>
            {conceptError && <p role="alert">{conceptError}</p>}
            <div className="exercise-concepts">
              {linked.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    set(
                      'review_concept_ids',
                      linked.filter((value) => value !== id)
                    )
                  }
                >
                  {concepts.find((item) => item.id === id)?.name ?? '知识点已不可用'} ×
                </button>
              ))}
            </div>
            <input
              aria-label="查找复习知识点"
              value={conceptQuery}
              onChange={(e) => setConceptQuery(e.target.value)}
              placeholder="搜索现有知识点；在知识与概念中可新增"
            />
            <select
              aria-label="添加复习知识点"
              value=""
              disabled={linked.length >= 32}
              onChange={(e) => {
                if (e.target.value) set('review_concept_ids', [...linked, e.target.value])
              }}
            >
              <option value="">选择知识点加入（最多 32 个）</option>
              {concepts
                .filter(
                  (item) =>
                    !linked.includes(item.id) &&
                    `${item.name} ${item.aliases.join(' ')}`
                      .toLowerCase()
                      .includes(conceptQuery.toLowerCase())
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </div>
          {Object.entries(exerciseFields).map(([key, label]) => (
            <section key={key} className={`exercise-block field-${key}`}>
              <h2>{label}</h2>
              <MathInput
                label={label}
                value={draft.fields[key as keyof typeof exerciseFields]}
                onChange={(value) => set('fields', { ...draft.fields, [key]: value })}
                minHeight={key === 'statement' ? 110 : 70}
                placeholder={`${label}…`}
              />
              {draft.fields[key as keyof typeof exerciseFields].length > 200_000 && (
                <p role="alert">每个分区最多 20 万字符，请缩短后保存。</p>
              )}
            </section>
          ))}
        </fieldset>
      ) : (
        snapshot && (
          <>
            <div className="exercise-metadata">
              <span>
                {subjects.find((item) => item.id === snapshot.subject_id)?.name || '未分科'}
              </span>
              <span>{snapshot.question_type || '未标注题型'}</span>
              {snapshot.no_idea && <span>暂无解题思路</span>}
              <p>来源：{snapshot.source_label || '尚未填写'}</p>
              <div className="exercise-concepts">
                <span>需复习：</span>
                {snapshot.review_concept_ids.length ? (
                  snapshot.review_concept_ids.map((id) => (
                    <Link key={id} to={`/knowledge?concept=${encodeURIComponent(id)}`}>
                      {concepts.find((item) => item.id === id)?.name ?? '知识点已不可用'}
                    </Link>
                  ))
                ) : (
                  <span className="muted">尚未关联知识点</span>
                )}
              </div>
            </div>
            {Object.entries(exerciseFields).map(([key, label]) => {
              const entry = snapshot.document.state.entries.find(
                (item) => item.id === snapshot.document.fields[key as keyof typeof exerciseFields]
              )!
              return (
                <section key={key} className={`exercise-block field-${key}`}>
                  <h2>{label}</h2>
                  {displayed[key as keyof typeof exerciseFields].trim() ? (
                    <MarkdownSegment
                      text={displayed[key as keyof typeof exerciseFields]}
                      subjectId={snapshot.subject_id}
                    />
                  ) : (
                    <p className="muted">尚未填写</p>
                  )}
                  {!!entry.figures?.length && (
                    <LearningEntryFigures figures={entry.figures} assets={source?.assets ?? []} />
                  )}
                </section>
              )
            })}
            <LearningPdfExport
              key={detail!.revision_id}
              source={{
                kind: 'exercise',
                exercise_id: exerciseId,
                revision_id: detail!.revision_id
              }}
              disabled={busy}
              onBusy={setBusy}
            />
          </>
        )
      )}
      {source && (
        <details className="exercise-origin">
          <summary>教材原题与固定来源</summary>
          <p>{source.label}</p>
          <Link
            to={`/library?${new URLSearchParams({ material: source.reference.material_id, version: source.reference.version_id, revision: source.reference.revision_id, entry: source.reference.entry_id })}`}
          >
            回到教材对应条目 →
          </Link>
          <p className="muted">保留转入时的原始文字、配图和教材修订。上方题面与作答可独立编辑。</p>
          <pre>{source.raw_text}</pre>
        </details>
      )}
    </div>
  )
}
