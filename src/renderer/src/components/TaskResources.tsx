import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { TaskWithProject } from '@shared/types'
import type {
  TaskResource,
  TaskResourceFields,
  TaskResourcePage,
  TaskResourceSource
} from '@shared/task-resources'
import {
  taskResourceHref,
  taskResourceKey,
  taskResourceRoles
} from '@shared/task-resources'
import { useConceptStore } from '../stores/concepts'
import { MarkdownSegment } from './MarkdownSegment'
import { LearningFormulaContent } from './LearningFormulaContent'
import { LearningEntryFigures } from './LearningFigures'
import './task-resources.css'

const empty = (): TaskResourcePage => ({
  items: [],
  total: 0,
  next_offset: null
})
const blank = (): TaskResourceFields => ({
  role: 'learn',
  concept_id: null,
  why: '',
  verification: ''
})
const taskHref = (resource: TaskResource): string =>
  resource.project_id
    ? `/projects/${encodeURIComponent(resource.project_id)}?task=${encodeURIComponent(resource.task_id)}`
    : `/review?task=${encodeURIComponent(resource.task_id)}`

function ResourceFields({
  value,
  onChange,
  disabled
}: {
  value: TaskResourceFields
  onChange: (value: TaskResourceFields) => void
  disabled: boolean
}) {
  const { items, load, error } = useConceptStore()
  const [query, setQuery] = useState('')
  useEffect(() => {
    void load()
  }, [load])
  return (
    <fieldset className="task-resource-fields" disabled={disabled}>
      <label>
        资料用途
        <select
          aria-label="任务资料用途"
          value={value.role}
          onChange={(e) =>
            onChange({
              ...value,
              role: e.target.value as TaskResourceFields['role']
            })
          }
        >
          {Object.entries(taskResourceRoles).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        搜索知识点
        <input
          aria-label="搜索任务资料知识点"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名称或别名（可选）"
        />
      </label>
      <label>
        关联知识点
        <select
          aria-label="任务资料知识点"
          value={value.concept_id ?? ''}
          onChange={(e) =>
            onChange({ ...value, concept_id: e.target.value || null })
          }
        >
          <option value="">暂不关联知识点</option>
          {items
            .filter(
              (item) =>
                item.id === value.concept_id ||
                `${item.name} ${item.aliases.join(' ')}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <label className="task-resource-wide">
        为什么需要、如何应用
        <textarea
          aria-label="任务资料用途说明"
          value={value.why}
          maxLength={4000}
          onChange={(e) => onChange({ ...value, why: e.target.value })}
          placeholder="例如：用简谐振动模型解释测得的共振峰，并估计固有频率。"
        />
      </label>
      <label className="task-resource-wide">
        怎样验证理解
        <textarea
          aria-label="任务资料验证方法"
          value={value.verification}
          maxLength={4000}
          onChange={(e) => onChange({ ...value, verification: e.target.value })}
          placeholder="例如：独立完成一次计算，对照测量结果并解释误差。"
        />
      </label>
    </fieldset>
  )
}

/** No entry requests until the user expands this part of a source. */
export function TaskSourceLinks({
  source,
  disabled = false
}: {
  source: TaskResourceSource
  disabled?: boolean
}) {
  const [opened, setOpened] = useState(false)
  return (
    <details
      className="task-source-links"
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true)
      }}
    >
      <summary>用于任务 · 查看与关联</summary>
      {opened && (
        <SourceEditor
          key={taskResourceKey(source)}
          source={source}
          disabled={disabled}
        />
      )}
    </details>
  )
}

function SourceEditor({
  source,
  disabled
}: {
  source: TaskResourceSource
  disabled: boolean
}) {
  const [tasks, setTasks] = useState<TaskWithProject[]>([]),
    [task, setTask] = useState(''),
    [query, setQuery] = useState('')
  const [fields, setFields] = useState(blank),
    [page, setPage] = useState<TaskResourcePage>(empty)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const request = useRef(0),
    lock = useRef(false),
    key = JSON.stringify(source)
  const refresh = useCallback(
    async (offset = 0) => {
      const token = ++request.current
      setBusy(true)
      setError('')
      try {
        const [links, choices] = await Promise.all([
          window.api.taskResources.backlinks({
            source: JSON.parse(key),
            offset
          }),
          window.api.tasks.listAll()
        ])
        if (token !== request.current) return
        if (links.ok)
          setPage((previous) => ({
            ...links.data,
            items: offset
              ? [...previous.items, ...links.data.items]
              : links.data.items
          }))
        else setError(links.error)
        if (choices.ok) setTasks(choices.data)
        else setError(choices.error)
      } catch {
        if (token === request.current) setError('读取任务关联失败，请重试')
      } finally {
        if (token === request.current) setBusy(false)
      }
    },
    [key]
  )
  useEffect(() => {
    void refresh()
    return () => {
      request.current++
    }
  }, [refresh])
  const save = async () => {
    if (lock.current || busy || disabled || !task) return
    lock.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await window.api.taskResources.add({
        ...fields,
        task_id: task,
        source
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setMessage(
        result.data.created
          ? '已关联到任务；引用时内容已保留。'
          : '此条目已关联到该任务，保留已有用途与验证方法。'
      )
      await refresh()
    } catch {
      setError('保存关联失败，填写内容已保留，请重试')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <div className="task-resource-panel">
      <p className="muted">
        关联当前所见的已保存条目。在任务里记录用途和验证方法，来源后来修改时仍可回看此版。
      </p>
      {disabled && <p role="status">请先保存或收起当前编辑，再关联任务。</p>}
      <label>
        搜索任务
        <input
          aria-label="搜索资料关联任务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="任务或项目名称"
        />
      </label>
      <label>
        用于哪个任务
        <select
          aria-label="资料关联任务"
          disabled={busy || disabled}
          value={task}
          onChange={(e) => setTask(e.target.value)}
        >
          <option value="">选择已有任务</option>
          {tasks
            .filter(
              (item) =>
                item.id === task ||
                `${item.title} ${item.project_title ?? ''}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase())
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.project_title ?? '日程任务'}
                {item.status === 'done' ? '（已完成）' : ''}
              </option>
            ))}
        </select>
      </label>
      {!tasks.length && !busy && (
        <p>
          先在<Link to="/projects">项目</Link>或<Link to="/review">日程</Link>
          中新建任务。
        </p>
      )}
      <ResourceFields
        value={fields}
        onChange={setFields}
        disabled={busy || disabled}
      />
      <div className="toolbar">
        <button
          type="button"
          className="primary"
          disabled={busy || disabled || !task}
          onClick={() => void save()}
        >
          关联到任务
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          刷新关联任务
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <h4>使用此处内容的任务（{page.total}）</h4>
      {page.items.map((item) => (
        <div className="task-resource-backlink" key={item.id}>
          <Link to={taskHref(item)}>{item.task_title}</Link>
          <span className="muted">
            {item.project_title ?? '日程任务'} · {taskResourceRoles[item.role]}
          </span>
          {item.why && <p>{item.why}</p>}
          {item.verification && <p>验证：{item.verification}</p>}
        </div>
      ))}
      {!page.total && !busy && <p className="muted">尚未用于任务。</p>}
      {page.next_offset !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh(page.next_offset!)}
        >
          继续读取关联任务
        </button>
      )}
    </div>
  )
}

export function TaskResources({
  taskId,
  disabled = false,
  initiallyOpen = false
}: {
  taskId: string
  disabled?: boolean
  initiallyOpen?: boolean
}) {
  const [opened, setOpened] = useState(initiallyOpen),
    [loaded, setLoaded] = useState(initiallyOpen)
  return (
    <details
      className="task-resources"
      open={opened}
      onToggle={(e) => {
        setOpened(e.currentTarget.open)
        if (e.currentTarget.open) setLoaded(true)
      }}
    >
      <summary>学习与资料</summary>
      {loaded && (
        <TaskResourceList key={taskId} taskId={taskId} disabled={disabled} />
      )}
    </details>
  )
}

function TaskResourceList({
  taskId,
  disabled
}: {
  taskId: string
  disabled: boolean
}) {
  const [page, setPage] = useState<TaskResourcePage>(empty),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [editing, setEditing] = useState<TaskResource | null>(null),
    [fields, setFields] = useState(blank)
  const { items: concepts, load } = useConceptStore()
  useEffect(() => {
    void load()
  }, [load])
  const request = useRef(0),
    lock = useRef(false)
  const refresh = useCallback(
    async (offset = 0) => {
      const token = ++request.current
      setBusy(true)
      setError('')
      try {
        const result = await window.api.taskResources.list({
          task_id: taskId,
          offset
        })
        if (token !== request.current) return
        if (result.ok)
          setPage((previous) => ({
            ...result.data,
            items: offset
              ? [...previous.items, ...result.data.items]
              : result.data.items
          }))
        else setError(result.error)
      } catch {
        if (token === request.current) setError('读取任务资料失败，请重试')
      } finally {
        if (token === request.current) setBusy(false)
      }
    },
    [taskId]
  )
  useEffect(() => {
    void refresh()
    return () => {
      request.current++
    }
  }, [refresh])
  const closeEdit = () => {
    if (
      editing &&
      JSON.stringify(fields) !==
        JSON.stringify({
          role: editing.role,
          concept_id: editing.concept_id,
          why: editing.why,
          verification: editing.verification
        }) &&
      !window.confirm('放弃未保存的资料用途修改？')
    )
      return false
    setEditing(null)
    return true
  }
  const save = async () => {
    if (!editing || lock.current || busy || disabled) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.api.taskResources.edit({
        ...fields,
        id: editing.id,
        expected_revision: editing.revision
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setEditing(null)
      await refresh()
    } catch {
      setError('保存失败，填写内容已保留，请重试')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const remove = async (item: TaskResource) => {
    if (
      lock.current ||
      busy ||
      disabled ||
      !window.confirm('仅移除此任务的资料关联？原资料和其他任务的关联会保留。')
    )
      return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.api.taskResources.remove({
        id: item.id,
        expected_revision: item.revision
      })
      if (!result.ok) setError(result.error)
      else await refresh()
    } catch {
      setError('移除失败，请刷新后重试')
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <div className="task-resource-panel">
      <p className="muted">
        从教材、课堂笔记、习题或项目文档的具体条目展开“用于任务”，添加到这里。
      </p>
      <div className="toolbar">
        <Link to="/library">教材</Link>
        <Link to="/notes">课堂笔记</Link>
        <Link to="/exercises">习题</Link>
        <Link to="/projects">项目文档</Link>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (closeEdit()) void refresh()
          }}
        >
          刷新任务资料
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在处理任务资料…</p>}
      {!page.total && !busy && (
        <p className="muted">
          暂无关联资料。可先建立任务，再逐步补充学习路径。
        </p>
      )}
      {page.items.map((item) => {
        const s = item.snapshot,
          href = taskResourceHref(item)
        return (
          <article
            className="task-resource-record"
            key={item.id}
            data-resource-id={item.id}
          >
            <div className="toolbar">
              <strong>{taskResourceRoles[item.role]}</strong>
              <span>
                {s.title} · {s.entry_title || '正文条目'}
              </span>
            </div>
            {s.location && <p className="muted">{s.location} · 引用时内容</p>}
            <details className="task-resource-quote">
              <summary>查看引用内容</summary>
              {s.formulas.length ? (
                <LearningFormulaContent
                  text={s.quote}
                  formulas={s.formulas}
                  subjectId={null}
                />
              ) : (
                <MarkdownSegment text={s.quote} />
              )}
              {!!s.figures.length && (
                <LearningEntryFigures figures={s.figures} assets={s.assets} />
              )}
              {s.original_text !== undefined && (
                <details>
                  <summary>引用时的原始转写</summary>
                  <div className="learning-entry-text">
                    {s.original_text || '（原文为空）'}
                  </div>
                </details>
              )}
            </details>
            {item.concept_id && (
              <p>
                关联知识：
                <Link
                  to={`/knowledge?concept=${encodeURIComponent(item.concept_id)}`}
                >
                  {concepts.find((c) => c.id === item.concept_id)?.name ??
                    '查看知识点'}
                </Link>
              </p>
            )}
            {editing?.id === item.id ? (
              <>
                <ResourceFields
                  value={fields}
                  onChange={setFields}
                  disabled={busy || disabled}
                />
                <div className="toolbar">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || disabled}
                    onClick={() => void save()}
                  >
                    保存资料用途
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => closeEdit()}
                  >
                    取消资料编辑
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>为什么需要、如何应用：{item.why || '待填写'}</p>
                <p>怎样验证理解：{item.verification || '待填写'}</p>
                <div className="toolbar">
                  {href ? (
                    <Link to={href}>打开引用时条目</Link>
                  ) : (
                    <span className="muted">
                      来源已删除，保留引用文字；配图需原附件仍可用。
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={busy || disabled || !!editing}
                    onClick={() => {
                      setEditing(item)
                      setFields({
                        role: item.role,
                        concept_id: item.concept_id,
                        why: item.why,
                        verification: item.verification
                      })
                    }}
                  >
                    编辑资料用途
                  </button>
                  <button
                    type="button"
                    disabled={busy || disabled || !!editing}
                    onClick={() => void remove(item)}
                  >
                    移除资料关联
                  </button>
                </div>
              </>
            )}
          </article>
        )
      })}
      {page.next_offset !== null && (
        <button
          type="button"
          disabled={busy || !!editing}
          onClick={() => void refresh(page.next_offset!)}
        >
          继续读取任务资料
        </button>
      )}
    </div>
  )
}
