import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { MemoDetail, MemoProposal, MemoSummary } from '@shared/memos'
import type { ModelInfo, Provider } from '@shared/types'
import { MathInput } from '../components/MathInput'
import { MarkdownSegment } from '../components/MarkdownSegment'
import { MemoCapture } from '../components/MemoCapture'
import { MemoRouteEditor } from '../components/MemoRouteEditor'
import { MemoAutomation } from '../components/MemoAutomation'
import { useAppStore } from '../stores/app'
import { useConceptStore } from '../stores/concepts'
import './memos.css'

export function MemosPage() {
  const [params, setParams] = useSearchParams(),
    id = params.get('memo') ?? '',
    historical = params.get('revision') ?? ''
  const { subjects, showToast } = useAppStore()
  const [items, setItems] = useState<MemoSummary[]>([]),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState<'all' | 'inbox' | 'routed'>('all'),
    [archived, setArchived] = useState(false),
    [next, setNext] = useState<number | null>(null)
  const [detail, setDetail] = useState<MemoDetail | null>(null),
    [content, setContent] = useState(''),
    [subject, setSubject] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [capture, setCapture] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([]),
    [providers, setProviders] = useState<Provider[]>([]),
    [model, setModel] = useState('')
  const [proposal, setProposal] = useState<MemoProposal | null>(null),
    [formKey, setFormKey] = useState(0),
    [routeDirty, setRouteDirty] = useState(false)
  const [autoDirty, setAutoDirty] = useState(false)
  const request = useRef(0),
    listRequest = useRef(0)
  const rawDirty =
      !!detail &&
      (content !== detail.memo.content ||
        subject !== (detail.memo.subject_id ?? '')),
    dirty = rawDirty || routeDirty || autoDirty
  const editing = useRef({
    id: detail?.memo.id,
    revision: detail?.memo.revision,
    dirty
  })
  editing.current = {
    id: detail?.memo.id,
    revision: detail?.memo.revision,
    dirty
  }
  const guard = (): boolean =>
    !dirty || window.confirm('放弃尚未保存的备忘修改或归档草稿？')
  const reload = useCallback(
    async (offset = 0): Promise<void> => {
      const token = ++listRequest.current,
        r = await window.api.memos.list({
          query,
          archived,
          offset,
          state: filter
        })
      if (token !== listRequest.current) return
      if (r.ok) {
        setItems((old) => (offset ? [...old, ...r.data.items] : r.data.items))
        setNext(r.data.next_offset)
      } else setError(r.error)
    },
    [query, archived, filter]
  )
  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!id) return
      const token = ++request.current,
        r = await window.api.memos.get(id)
      if (token !== request.current) return
      if (r.ok) {
        if (
          !force &&
          editing.current.id === id &&
          editing.current.dirty &&
          editing.current.revision &&
          editing.current.revision !== r.data.memo.revision
        ) {
          setError(
            '其他窗口已修改此备忘，当前草稿已保留。请先复制需要保留的内容，再重新载入；旧修订不能归档。'
          )
          setDetail((old) =>
            old ? { ...old, recognitions: r.data.recognitions } : r.data
          )
          return
        }
        setDetail(r.data)
        if (force) {
          setContent(r.data.memo.content)
          setSubject(r.data.memo.subject_id ?? '')
          setProposal(null)
          setRouteDirty(false)
          setFormKey((k) => k + 1)
          setError('')
        }
      } else setError(r.error)
    },
    [id]
  )
  useEffect(() => {
    void reload()
    const listener = (): void => {
      void reload()
    }
    window.addEventListener('memos-changed', listener)
    return () => {
      listRequest.current++
      window.removeEventListener('memos-changed', listener)
    }
  }, [reload])
  useEffect(() => {
    setDetail(null)
    setError('')
    setProposal(null)
    setRouteDirty(false)
    setFormKey((k) => k + 1)
    void refresh()
    return () => {
      request.current++
    }
  }, [refresh])
  useEffect(() => {
    if (detail) {
      setContent(detail.memo.content)
      setSubject(detail.memo.subject_id ?? '')
    }
  }, [detail?.memo.id, detail?.memo.revision])
  useEffect(() => {
    if (!detail?.recognitions.some((j) => j.status === 'running')) return
    const timer = setInterval(() => void refresh(), 1000)
    return () => clearInterval(timer)
  }, [detail?.recognitions, refresh])
  useEffect(() => {
    const beforeOpen = (e: Event): void => {
      if (
        dirty &&
        !window.confirm('放弃当前未保存的备忘修改或归档草稿并离开？')
      )
        e.preventDefault()
    }
    const followLink = (e: MouseEvent): void => {
      const a = (e.target as Element).closest?.(
        'a[href]'
      ) as HTMLAnchorElement | null
      if (
        dirty &&
        a &&
        a.href !== window.location.href &&
        a.origin === window.location.origin &&
        e.button === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !window.confirm('放弃尚未保存的备忘修改或归档草稿？')
      ) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('memo-before-navigate', beforeOpen)
    document.addEventListener('click', followLink, true)
    return () => {
      window.removeEventListener('memo-before-navigate', beforeOpen)
      document.removeEventListener('click', followLink, true)
    }
  }, [dirty])
  useEffect(() => {
    if (historical && detail) {
      document
        .getElementById('memo-version-' + historical)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [historical, detail?.memo.id])
  useEffect(() => {
    const before = (e: BeforeUnloadEvent): void => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [dirty])
  useEffect(() => {
    let alive = true
    void useConceptStore.getState().load()
    void Promise.all([
      window.api.models.list(),
      window.api.providers.list()
    ]).then(([m, p]) => {
      if (!alive) return
      if (m.ok) setModels(m.data)
      if (p.ok) setProviders(p.data)
      if (m.ok && p.ok)
        setModel(
          m.data.find((x) =>
            p.data.some((y) => y.id === x.provider_id && y.enabled)
          )?.id ?? ''
        )
    })
    return () => {
      alive = false
    }
  }, [])
  const updated = (d: MemoDetail): void => {
    request.current++
    setDetail(d)
    setContent(d.memo.content)
    setSubject(d.memo.subject_id ?? '')
    setProposal(null)
    setRouteDirty(false)
    setFormKey((k) => k + 1)
    void reload()
    void useConceptStore.getState().load()
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }
  const save = (): void => {
    if (!detail) return
    void run(async () => {
      const r = await window.api.memos.save({
        id,
        expected_revision: detail.memo.revision,
        content,
        subject_id: subject || null
      })
      if (r.ok) {
        updated(r.data)
        showToast('备忘已保存')
      } else setError(r.error)
    })
  }
  const archive = (): void => {
    if (!detail || !guard()) return
    void run(async () => {
      const r = await window.api.memos.archive({
        id,
        expected_revision: detail.memo.revision,
        archived: !detail.memo.archived
      })
      if (r.ok) updated(r.data)
      else setError(r.error)
    })
  }
  const recognize = (): void => {
    if (!detail) return
    void run(async () => {
      const r = await window.api.memos.recognize({
        id,
        expected_revision: detail.memo.revision,
        model_db_id: model
      })
      if (r.ok) setDetail(r.data)
      else setError(r.error)
    })
  }
  return (
    <div className="page memos-page">
      <div className="memo-heading">
        <div>
          <h1>备忘</h1>
          <p className="muted">原文先留下，知识与待办随后整理。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => setCapture(true)}
        >
          随手记
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <MemoAutomation
        models={models}
        providers={providers}
        disabled={busy}
        onDirty={setAutoDirty}
        onChanged={() => {
          void reload()
          void refresh()
        }}
      />
      <div className="memo-workspace">
        <aside className="memo-list" aria-label="备忘列表">
          <input
            aria-label="搜索备忘"
            value={query}
            maxLength={500}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索原文"
          />
          <select
            aria-label="备忘整理状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">全部备忘</option>
            <option value="inbox">待整理</option>
            <option value="routed">已归档</option>
          </select>
          <label className="memo-check">
            <input
              type="checkbox"
              aria-label="备忘回收站"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            查看回收站
          </label>
          {!items.length && (
            <p className="muted">尚无匹配记录。随手记支持离线保存。</p>
          )}
          {items.map((m) => (
            <button
              key={m.id}
              disabled={busy}
              className={`memo-row ${m.id === id ? 'selected' : ''}`}
              onClick={() => {
                if (guard()) setParams({ memo: m.id })
              }}
            >
              <span>{m.content.slice(0, 100)}</span>
              <small>
                {m.routed ? '已归档' : '待整理'} ·{' '}
                {subjects.find((s) => s.id === m.subject_id)?.name ??
                  '学科待定'}{' '}
                · {new Date(m.updated_at).toLocaleDateString('zh-CN')}
              </small>
            </button>
          ))}
          {next !== null && (
            <button onClick={() => void reload(next)}>加载更多备忘</button>
          )}
        </aside>
        <section className="memo-detail" aria-label="备忘详情">
          {!id ? (
            <p className="muted">
              选择一条备忘，或用“随手记”记录。灵感库中的旧记录可单独转入，原记录保留。
            </p>
          ) : !detail ? (
            <p>正在载入备忘…</p>
          ) : (
            <>
              <div className="memo-heading">
                <h2>{detail.memo.archived ? '回收站中的备忘' : '备忘原文'}</h2>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (guard()) void refresh(true)
                  }}
                >
                  重新载入
                </button>
                <button disabled={busy} onClick={archive}>
                  {detail.memo.archived ? '恢复备忘' : '移入回收站'}
                </button>
              </div>
              <p className="meta">
                {new Date(detail.memo.created_at).toLocaleString('zh-CN')}
                {detail.memo.inspiration_id ? ' · 从灵感转入，原记录保留' : ''}
              </p>
              {detail.automation
                .filter((j) => j.revision === detail.memo.revision)
                .map((j) => (
                  <section
                    className="memo-job"
                    aria-label="本条自动整理"
                    key={j.id}
                  >
                    <strong>
                      {
                        {
                          pending: '等待补处理',
                          running: '正在自动识别',
                          review: '需要确认',
                          routed: '已自动归档',
                          cancelled: '自动整理已停止'
                        }[j.status]
                      }
                    </strong>
                    <p>
                      {j.status === 'routed' &&
                      detail.routes.some(
                        (r) => r.revision === j.revision && r.undone_at
                      )
                        ? '此条归档已撤销，不会自动重新创建。'
                        : j.reason || '等待处理'}
                    </p>
                    {j.status !== 'routed' && (
                      <button
                        disabled={busy || rawDirty}
                        onClick={() =>
                          void run(async () => {
                            const r = await window.api.memos.autoAction({
                              id: j.id,
                              action: ['pending', 'running'].includes(j.status)
                                ? 'cancel'
                                : 'retry'
                            })
                            if (!r.ok) setError(r.error)
                            else await refresh()
                          })
                        }
                      >
                        {['pending', 'running'].includes(j.status)
                          ? '停止此条自动整理'
                          : '按当前规则重试此条'}
                      </button>
                    )}
                  </section>
                ))}
              <fieldset disabled={busy || detail.memo.archived}>
                <div inert={busy || detail.memo.archived}>
                  <MathInput
                    label="编辑备忘原文"
                    value={content}
                    onChange={setContent}
                    placeholder="备忘原文"
                  />
                </div>
                <label>
                  学科
                  <select
                    aria-label="备忘原文学科"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  >
                    <option value="">待定</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={!rawDirty || !content.trim()} onClick={save}>
                  保存原文
                </button>
              </fieldset>
              {rawDirty && (
                <p className="memo-warning">
                  请先保存原文，再识别或归档。修改会保留历史，已有知识和日程不会随原文修改而覆盖。
                </p>
              )}
              {!detail.memo.archived && (
                <>
                  <section className="memo-ai" aria-label="备忘智能识别">
                    <h2>助理识别</h2>
                    <p className="muted">
                      手动识别只发送本条已保存原文、记录时间和时区给所选供应商，生成待核对候选。自动归档由上方单独启用的规则控制。
                    </p>
                    <div className="toolbar">
                      <select
                        aria-label="备忘识别模型"
                        value={model}
                        disabled={busy || rawDirty}
                        onChange={(e) => setModel(e.target.value)}
                      >
                        <option value="">请选择模型</option>
                        {models
                          .filter((m) =>
                            providers.some(
                              (p) => p.enabled && p.id === m.provider_id
                            )
                          )
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {
                                providers.find((p) => p.id === m.provider_id)
                                  ?.name
                              }{' '}
                              / {m.display_name || m.model_id}
                            </option>
                          ))}
                      </select>
                      <button
                        disabled={
                          busy ||
                          rawDirty ||
                          !model ||
                          detail.recognitions.some(
                            (j) => j.status === 'running'
                          )
                        }
                        onClick={recognize}
                      >
                        识别这条备忘
                      </button>
                    </div>
                    {!models.length && (
                      <p>
                        <Link to="/settings">先配置模型</Link>
                        ，也可直接在下方手工整理。
                      </p>
                    )}
                    {detail.recognitions.map((job) => (
                      <div key={job.id} className="memo-job">
                        <strong>
                          {
                            {
                              running: '正在识别',
                              ready: '待核对',
                              failed: '识别失败',
                              cancelled: '已取消'
                            }[job.status]
                          }
                        </strong>{' '}
                        · {job.provider_name} / {job.model_id}
                        {job.revision !== detail.memo.revision && (
                          <span> · 旧修订</span>
                        )}
                        {job.error && <p role="alert">{job.error}</p>}
                        {job.status === 'running' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const r =
                                  await window.api.memos.cancelRecognition(
                                    job.id
                                  )
                                if (!r.ok) setError(r.error)
                                await refresh()
                              })
                            }
                          >
                            取消识别
                          </button>
                        )}
                        {job.proposal && (
                          <>
                            <p>
                              分类：
                              {
                                {
                                  knowledge: '知识',
                                  task: '待办',
                                  mixed: '知识与待办',
                                  idea: '项目想法',
                                  other: '其他重要记录'
                                }[job.proposal.kind]
                              }
                            </p>
                            {job.proposal.knowledge && (
                              <blockquote>
                                {job.proposal.knowledge.excerpt}
                              </blockquote>
                            )}
                            {job.proposal.task && (
                              <blockquote>
                                {job.proposal.task.excerpt}
                              </blockquote>
                            )}
                            {job.proposal.uncertainties.map((s, i) => (
                              <p key={i}>待核对：{s}</p>
                            ))}
                            <button
                              disabled={
                                busy ||
                                rawDirty ||
                                job.revision !== detail.memo.revision
                              }
                              onClick={() => {
                                if (
                                  !routeDirty ||
                                  window.confirm('替换当前未归档的整理草稿？')
                                ) {
                                  setProposal(job.proposal)
                                  setFormKey((k) => k + 1)
                                  setRouteDirty(true)
                                }
                              }}
                            >
                              填入整理草稿
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </section>
                  <MemoRouteEditor
                    key={`${detail.memo.revision}:${formKey}`}
                    detail={detail}
                    proposal={proposal}
                    disabled={busy || rawDirty}
                    onDirty={() => setRouteDirty(true)}
                    onBusy={setBusy}
                    onSaved={(d) => {
                      updated(d)
                      showToast('已归档，原文保留')
                    }}
                  />
                </>
              )}
              <section aria-label="备忘归档记录">
                <h2>归档记录</h2>
                {!detail.routes.length && <p className="muted">尚未归档。</p>}
                {detail.routes.map((r) => (
                  <div key={r.id} className="memo-receipt">
                    <p>
                      {new Date(r.created_at).toLocaleString('zh-CN')}
                      {r.undone_at ? ' · 已撤销' : ''}
                      {r.revision !== detail.memo.revision
                        ? ' · 基于旧修订'
                        : ''}
                    </p>
                    {r.targets.map((t) => (
                      <p key={t.id}>
                        {t.kind === 'concept' ? '知识' : '待办'} ·{' '}
                        {t.target_id ? (
                          <Link
                            to={
                              (t.kind === 'concept'
                                ? '/knowledge?concept='
                                : '/review?task=') +
                              encodeURIComponent(t.target_id)
                            }
                          >
                            {t.title}
                          </Link>
                        ) : (
                          <span>{t.title}（目标已删除）</span>
                        )}
                        {t.created ? ' · 新建' : ' · 复用'}
                      </p>
                    ))}
                    {!r.undone_at && (
                      <button
                        disabled={busy || dirty}
                        onClick={() => {
                          if (
                            window.confirm(
                              '撤销本次归档？未改动且未排程的待办将删除，知识点保留，原文不变。'
                            )
                          )
                            void run(async () => {
                              const result = await window.api.memos.undo(r.id)
                              if (result.ok) updated(result.data)
                              else setError(result.error)
                            })
                        }}
                      >
                        撤销此归档
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <details open={historical ? true : undefined}>
                <summary>原文历史（{detail.versions.length}）</summary>
                {detail.versions.map((v) => (
                  <article
                    id={'memo-version-' + v.id}
                    key={v.id}
                    className={
                      v.id === historical ? 'memo-history-selected' : ''
                    }
                  >
                    <p>
                      {new Date(v.created_at).toLocaleString('zh-CN')} ·{' '}
                      {v.timezone === 'unknown'
                        ? '原灵感时区未记录'
                        : v.timezone}
                      {v.id === detail.memo.revision ? ' · 当前修订' : ''}
                    </p>
                    <MarkdownSegment
                      text={v.content}
                      subjectId={v.subject_id}
                    />
                  </article>
                ))}
              </details>
            </>
          )}
        </section>
      </div>
      {capture && (
        <MemoCapture
          onClose={() => {
            setCapture(false)
            void reload()
          }}
        />
      )}
    </div>
  )
}
