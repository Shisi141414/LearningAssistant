import { useEffect, useRef, useState } from 'react'
import type {
  CampusField,
  CampusPreview,
  CampusProvenance,
  CampusState
} from '@shared/campus'
import type { ApiResult } from '@shared/types'
import { useAppStore } from '../stores/app'

const read = <T,>(r: ApiResult<T>): T => {
  if (!r.ok) throw Error(r.error)
  return r.data
}
const names: Record<CampusField, string> = {
  title: '名称',
  due_at: '截止时间',
  subject_id: '学科'
}
const kinds = {
  new: '新增',
  update: '有变化',
  unchanged: '无变化',
  trash: '已在回收站，保留删除状态'
}
export function CampusPanel({ onImported }: { onImported: () => void }) {
  const { subjects, showToast } = useAppStore()
  const [state, setState] = useState<CampusState | null>(null)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [courses, setCourses] = useState<string[]>([]),
    [preview, setPreview] = useState<CampusPreview | null>(null)
  const [keys, setKeys] = useState<string[]>([]),
    [adopt, setAdopt] = useState<Record<string, CampusField[]>>({})
  const locked = useRef(false),
    alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void window.api.campus
      .state()
      .then((r) => {
        if (alive.current) setState(read(r))
      })
      .catch((e) => {
        if (alive.current) setError(e.message)
      })
    return () => {
      alive.current = false
      void window.api.campus.discard()
    }
  }, [])
  useEffect(() => {
    if (state?.phase !== 'login') return
    let active = true,
      pending = false
    const interval = setInterval(() => {
      if (pending) return
      pending = true
      void window.api.campus
        .state()
        .then((r) => {
          if (active) setState(read(r))
        })
        .catch((e) => {
          if (active) setError(e.message)
        })
        .finally(() => {
          pending = false
        })
    }, 2000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [state?.phase])
  async function run(fn: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const value = (field: CampusField, v: string | number | null) =>
    field === 'due_at'
      ? v === null
        ? '未设置'
        : new Date(Number(v)).toLocaleString('zh-CN')
      : field === 'subject_id'
        ? (subjects.find((s) => s.id === v)?.name ?? '未分科')
        : String(v ?? '')
  return (
    <details className="campus-panel">
      <summary>网络学堂作业</summary>
      <p className="muted">
        在学校官方窗口登录后，选择课程并预览导入。仅保留本次运行的登录，重启后需重新连接；学校已提交与本地已完成分别记录。
      </p>
      {error && (
        <p role="alert" className="assignment-error">
          {error}
        </p>
      )}
      {state?.error && <p role="alert">{state.error}</p>}
      <div className="campus-actions">
        <button
          disabled={busy || !state}
          onClick={() =>
            void run(async () => {
              const s = read(await window.api.campus.login())
              if (alive.current) {
                setState(s)
                setPreview(null)
              }
            })
          }
        >
          {state?.phase === 'login'
            ? '返回官方登录窗口'
            : state?.phase === 'connected'
              ? '重新登录'
              : '连接网络学堂'}
        </button>
        {state && state.phase !== 'disconnected' && (
          <button
            onClick={() => {
              void window.api.campus
                .disconnect()
                .then((r) => {
                  if (alive.current) {
                    setState(read(r))
                    setPreview(null)
                    setCourses([])
                  }
                })
                .catch((e) => {
                  if (alive.current) setError(e.message)
                })
            }}
          >
            断开连接
          </button>
        )}
        {state?.phase === 'login' && (
          <span role="status">请在学校官方窗口完成登录与验证。</span>
        )}
        {state?.phase === 'connected' && (
          <span>
            {state.label} · {state.semester}
          </span>
        )}
      </div>
      {state?.phase === 'connected' && (
        <>
          <div className="campus-courses" aria-label="选择学校课程">
            {state.courses.map((c) => (
              <div key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={courses.includes(c.id)}
                    onChange={(e) => {
                      setCourses((list) =>
                        e.target.checked
                          ? [...list, c.id]
                          : list.filter((id) => id !== c.id)
                      )
                      setPreview(null)
                      void window.api.campus.discard()
                    }}
                  />
                  {c.title}
                </label>
                <select
                  aria-label={`${c.title}对应学科`}
                  disabled={busy}
                  value={c.subject_id ?? ''}
                  onChange={(e) => {
                    const subject_id = e.target.value || null
                    void run(async () => {
                      const s = read(
                        await window.api.campus.map({
                          id: c.id,
                          revision: c.revision,
                          subject_id
                        })
                      )
                      if (alive.current) {
                        setState(s)
                        setPreview(null)
                      }
                    })
                  }}
                >
                  <option value="">未分科</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <button
            disabled={busy || !courses.length}
            onClick={() =>
              void run(async () => {
                const p = read(await window.api.campus.preview(courses))
                if (alive.current) {
                  setPreview(p)
                  setKeys(
                    p.items
                      .filter(
                        (i) =>
                          i.kind !== 'trash' &&
                          i.kind !== 'unchanged' &&
                          (i.kind !== 'new' || !i.submitted)
                      )
                      .map((i) => i.key)
                  )
                  setAdopt({})
                }
              })
            }
          >
            {busy ? '正在读取…' : '读取并预览作业'}
          </button>
        </>
      )}
      {preview && (
        <section className="campus-preview" aria-label="学校作业导入预览">
          <p>
            新导入的作业默认为“未开始”。已提交的新作业默认不勾选，可自行选择。人工修改默认保留；勾选具体字段才采用学校值。预览有效期为十分钟。
          </p>
          {preview.failures.map((f, i) => (
            <p role="alert" key={i}>
              {f}
            </p>
          ))}
          {!preview.items.length && <p>没有可导入的作业。</p>}
          <div className="campus-actions">
            <button
              disabled={busy}
              onClick={() =>
                setKeys(
                  preview.items
                    .filter((i) => i.kind !== 'trash')
                    .map((i) => i.key)
                )
              }
            >
              全选可导入项
            </button>
            <button disabled={busy} onClick={() => setKeys([])}>
              取消选择
            </button>
          </div>
          {preview.items.map((i) => (
            <article key={i.key}>
              <label>
                <input
                  type="checkbox"
                  disabled={busy || i.kind === 'trash'}
                  checked={keys.includes(i.key)}
                  onChange={(e) =>
                    setKeys((list) =>
                      e.target.checked
                        ? [...list, i.key]
                        : list.filter((k) => k !== i.key)
                    )
                  }
                />{' '}
                <strong>{i.title}</strong> · {kinds[i.kind]}
              </label>
              <p className="muted">
                {i.course_title} · 截止{' '}
                {new Date(i.due_at).toLocaleString('zh-CN')} · 学校
                {i.submitted ? '已提交' : '未提交'}
              </p>
              {i.changes.map((c) => (
                <div key={c.field} className="campus-change">
                  <span>
                    {names[c.field]}：{value(c.field, c.local)} →{' '}
                    {value(c.field, c.remote)}
                  </span>
                  {c.protected && (
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy || !keys.includes(i.key)}
                        checked={(adopt[i.key] ?? []).includes(c.field)}
                        onChange={(e) =>
                          setAdopt((old) => ({
                            ...old,
                            [i.key]: e.target.checked
                              ? [...(old[i.key] ?? []), c.field]
                              : (old[i.key] ?? []).filter((f) => f !== c.field)
                          }))
                        }
                      />
                      采用学校值（默认保留手动修改）
                    </label>
                  )}
                </div>
              ))}
            </article>
          ))}
          <div className="campus-actions">
            <button
              className="primary"
              disabled={busy || !keys.length}
              onClick={() =>
                void run(async () => {
                  const result = read(
                    await window.api.campus.apply({
                      token: preview.token,
                      keys,
                      adopt: Object.entries(adopt)
                        .filter(
                          ([key, fields]) => keys.includes(key) && fields.length
                        )
                        .map(([key, fields]) => ({ key, fields }))
                    })
                  )
                  if (alive.current) {
                    setPreview(null)
                    onImported()
                    showToast(
                      `已新增 ${result.created} 项、更新 ${result.updated} 项作业`
                    )
                  }
                })
              }
            >
              确认导入所选作业
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setPreview(null)
                void window.api.campus.discard()
              }}
            >
              取消预览
            </button>
          </div>
        </section>
      )}
    </details>
  )
}
export function CampusSourceInfo({
  id,
  revision
}: {
  id: string
  revision: string
}) {
  const [source, setSource] = useState<CampusProvenance | null>(null)
  useEffect(() => {
    let active = true
    setSource(null)
    void window.api.campus.provenance(id).then((r) => {
      if (active && r.ok) setSource(r.data)
    })
    return () => {
      active = false
    }
  }, [id, revision])
  if (!source) return null
  return (
    <aside className="campus-source">
      <p>
        来源：网络学堂 · {source.current.course_title} · 学校
        {source.current.submitted ? '已提交' : '未提交'} · {source.versions}{' '}
        个来源版本
      </p>
      {!!source.overrides.length && (
        <p>
          已保留手动修改：{source.overrides.map((f) => names[f]).join('、')}
        </p>
      )}
      <a href={source.current.url} target="_blank" rel="noreferrer">
        在网络学堂查看
      </a>
    </aside>
  )
}
