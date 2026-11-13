import { TaskResources } from '../components/TaskResources'
/**
 * pages/ProjectDetail.tsx —— 项目详情：目标 / 里程碑 / 任务（按状态分组）/ 知识点引用
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import type { ProjectDetail, Task, TaskKnowledgeRef, Concept } from '@shared/types'
import { ProjectDocuments } from '../components/ProjectDocuments'
import { useAppStore } from '../stores/app'

const TASK_GROUPS: Array<{ status: Task['status']; label: string }> = [
  { status: 'open', label: '待办' },
  { status: 'doing', label: '进行中' },
  { status: 'blocked', label: '阻塞' },
  { status: 'done', label: '已完成' }
]

function parseRefs(json: string): TaskKnowledgeRef[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function ProjectDetail() {
  const [params] = useSearchParams()
  const targetTask = params.get('task') ?? ''
  const { projectId } = useParams<{ projectId: string }>()
  const showToast = useAppStore((s) => s.showToast)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskMilestone, setTaskMilestone] = useState('')
  const [msTitle, setMsTitle] = useState('')
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [refEditor, setRefEditor] = useState<{ taskId: string; conceptId: string; why: string } | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    const res = await window.api.projects.detail(projectId)
    if (res.ok) setDetail(res.data)
    else showToast(res.error)
  }, [projectId, showToast])

  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    if (detail && targetTask) document.getElementById(`project-task-${targetTask}`)?.scrollIntoView({ block:'center' })
  },[detail,targetTask])

  useEffect(() => {
    void window.api.concepts.list().then((r) => {
      if (r.ok) setConcepts(r.data)
    })
  }, [])

  const conceptName = useCallback((id: string): string => concepts.find((c) => c.id === id)?.name ?? '未知概念', [concepts])

  /** 保存知识引用：追加/更新 why（不动其他引用） */
  const saveRef = async (): Promise<void> => {
    if (!refEditor || !refEditor.conceptId) {
      showToast('请选择知识点')
      return
    }
    const task = detail?.tasks.find((t) => t.id === refEditor.taskId)
    if (!task) return
    const refs = parseRefs(task.knowledge_refs_json).filter((r) => r.concept_id !== refEditor.conceptId)
    refs.push({ concept_id: refEditor.conceptId, why: refEditor.why.trim() })
    const res = await window.api.tasks.update(task.id, { knowledge_refs: refs })
    if (res.ok) {
      setRefEditor(null)
      void reload()
    } else showToast(`保存失败：${res.error}`)
  }

  const removeRef = async (taskId: string, conceptId: string): Promise<void> => {
    const task = detail?.tasks.find((t) => t.id === taskId)
    if (!task) return
    const refs = parseRefs(task.knowledge_refs_json).filter((r) => r.concept_id !== conceptId)
    const res = await window.api.tasks.update(taskId, { knowledge_refs: refs })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  if (!detail) return <div className="page">加载中…</div>

  const addMilestone = async (): Promise<void> => {
    if (!msTitle.trim()) return
    const res = await window.api.milestones.create({ project_id: detail.id, title: msTitle.trim() })
    if (res.ok) {
      setMsTitle('')
      void reload()
    } else showToast(`创建失败：${res.error}`)
  }

  const addTask = async (): Promise<void> => {
    if (!taskTitle.trim()) return
    const res = await window.api.tasks.create({
      project_id: detail.id,
      milestone_id: taskMilestone || null,
      title: taskTitle.trim()
    })
    if (res.ok) {
      setTaskTitle('')
      void reload()
    } else showToast(`创建失败：${res.error}`)
  }

  const cycleStatus = async (task: Task): Promise<void> => {
    const order: Task['status'][] = ['open', 'doing', 'done']
    const next = task.status === 'blocked' ? 'doing' : order[(order.indexOf(task.status) + 1) % order.length]
    const res = await window.api.tasks.update(task.id, { status: next })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  const blockTask = async (task: Task): Promise<void> => {
    const reason = window.prompt('阻塞原因：', task.blocked_reason)
    if (reason === null) return
    if (!reason.trim()) {
      showToast('阻塞需要填写原因')
      return
    }
    const res = await window.api.tasks.update(task.id, { status: 'blocked', blocked_reason: reason.trim() })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  const toggleMilestone = async (id: string, current: 'open' | 'done'): Promise<void> => {
    const res = await window.api.milestones.update(id, { status: current === 'done' ? 'open' : 'done' })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  const setStatus = async (status: ProjectDetail['status']): Promise<void> => {
    const res = await window.api.projects.update(detail.id, { status })
    if (res.ok) void reload()
    else showToast(res.error)
  }

  return (
    <div className="page">
      <div className="toolbar">
        <Link to="/projects">← 项目</Link>
        <h1 style={{ margin: 0, flex: 1 }}>{detail.title}</h1>
        <select value={detail.status} onChange={(e) => void setStatus(e.target.value as ProjectDetail['status'])}>
          <option value="active">进行中</option>
          <option value="paused">暂停</option>
          <option value="done">已完成</option>
          <option value="archived">归档</option>
        </select>
      </div>
      {detail.goal && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="meta" style={{ marginBottom: 4 }}>项目要求</div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{detail.goal}</div>
        </div>
      )}

      <ProjectDocuments key={detail.id} projectId={detail.id} />

      {/* 里程碑 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 10px' }}>里程碑</h3>
        <div className="toolbar">
          <input value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder="新里程碑，如：完成建模与求解" style={{ flex: 1, maxWidth: 420 }}
            onKeyDown={(e) => { if (e.key === 'Enter') void addMilestone() }} />
          <button className="primary" onClick={() => void addMilestone()}>+ 里程碑</button>
        </div>
        {detail.milestones.length === 0 && <div className="muted">还没有里程碑</div>}
        <div className="row-list">
          {detail.milestones.map((m) => (
            <div key={m.id} className="row-item">
              <input type="checkbox" checked={m.status === 'done'} onChange={() => void toggleMilestone(m.id, m.status)} />
              <div className="grow" style={{ textDecoration: m.status === 'done' ? 'line-through' : 'none' }}>
                <div style={{ fontWeight: 600 }}>{m.title}</div>
                <div className="meta">
                  {m.due_at ? `截止 ${new Date(m.due_at).toLocaleDateString('zh-CN')} · ` : ''}任务 {m.tasks_done}/{m.tasks_count}
                </div>
              </div>
              <button style={{ fontSize: 12 }} onClick={() => { if (window.confirm('删除该里程碑？其任务退回项目级（不删除）。')) void window.api.milestones.remove(m.id).then(() => void reload()) }}>删除</button>
            </div>
          ))}
        </div>
      </div>

      {/* 任务 */}
      <div className="card">
        <h3 style={{ margin: '0 0 10px' }}>任务</h3>
        <div className="toolbar">
          <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="新任务" style={{ flex: 1, maxWidth: 360 }}
            onKeyDown={(e) => { if (e.key === 'Enter') void addTask() }} />
          <select value={taskMilestone} onChange={(e) => setTaskMilestone(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">（项目级，不挂里程碑）</option>
            {detail.milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.title}</option>
            ))}
          </select>
          <button className="primary" onClick={() => void addTask()}>+ 任务</button>
        </div>

        <div className="project-task-board" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 10 }}>
          {TASK_GROUPS.map((group) => {
            const items = detail.tasks.filter((t) => t.status === group.status)
            return (
              <div key={group.status} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, minHeight: 80 }}>
                <div className="meta" style={{ fontWeight: 700, marginBottom: 6 }}>{group.label}（{items.length}）</div>
                {items.map((t) => {
                  const refs = parseRefs(t.knowledge_refs_json)
                  const ms = detail.milestones.find((m) => m.id === t.milestone_id)
                  return (
                    <div key={t.id} id={`project-task-${t.id}`} className={targetTask === t.id ? 'evidence-target' : ''} style={{ borderBottom: '1px solid var(--border)', padding: '6px 0' }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <button style={{ padding: '1px 8px', fontSize: 12 }} title="切换状态" onClick={() => void cycleStatus(t)}>↻</button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500 }}>{t.title}</div>
                          {ms && <div className="meta">⊆ {ms.title}</div>}
                          {t.status === 'blocked' && t.blocked_reason && <div className="meta" style={{ color: 'var(--danger)' }}>阻塞：{t.blocked_reason}</div>}
                          {t.due_at && <div className="meta">截止 {new Date(t.due_at).toLocaleDateString('zh-CN')}</div>}
                          {refs.map((r) => (
                            <span key={r.concept_id} className="pill" style={{ color: 'var(--accent)', background: 'var(--accent-weak)', marginTop: 3, display: 'inline-flex', gap: 4 }} title={r.why || '未填写用途'}>
                              ⚛ <Link to={`/knowledge?concept=${encodeURIComponent(r.concept_id)}`}>{conceptName(r.concept_id)}</Link>
                              <span style={{ opacity: 0.5, cursor: 'pointer' }} onClick={() => void removeRef(t.id, r.concept_id)}>×</span>
                            </span>
                          ))}
                          {refEditor?.taskId === t.id ? (
                            <div style={{ marginTop: 4, padding: 6, border: '1px solid var(--border)', borderRadius: 6 }}>
                              <select value={refEditor.conceptId} onChange={(e) => setRefEditor({ ...refEditor, conceptId: e.target.value })} style={{ width: '100%', marginBottom: 4 }}>
                                <option value="">选择知识点…</option>
                                {concepts.map((c) => (
                                  <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                              </select>
                              <input value={refEditor.why} onChange={(e) => setRefEditor({ ...refEditor, why: e.target.value })} placeholder="这个任务如何用到该知识点（选填）" style={{ width: '100%', marginBottom: 4 }} />
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button className="primary" style={{ fontSize: 12, padding: '2px 10px' }} onClick={() => void saveRef()}>保存</button>
                                <button style={{ fontSize: 12, padding: '2px 10px' }} onClick={() => setRefEditor(null)}>取消</button>
                              </div>
                            </div>
                          ) : (
                            <button style={{ fontSize: 11, padding: '1px 8px', marginTop: 4 }} title="关联知识点（学习/应用路径）" onClick={() => setRefEditor({ taskId: t.id, conceptId: '', why: '' })}>
                              ⚛ 关联知识点
                            </button>
                          )}
                        </div>
                        <button style={{ padding: '1px 8px', fontSize: 12 }} title="标记阻塞" onClick={() => void blockTask(t)}>⛔</button>
                      </div>
                      <TaskResources taskId={t.id} initiallyOpen={targetTask === t.id} />
                      <Link to={`/review?task=${encodeURIComponent(t.id)}`} style={{ fontSize: 12 }}>安排学习时间</Link>
                    </div>
                  )
                })}
                {items.length === 0 && <div className="muted" style={{ fontSize: 12 }}>—</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
