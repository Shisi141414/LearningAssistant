/**
 * pages/ProjectsPage.tsx —— R4 项目管理：项目列表与创建
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Project } from '@shared/types'
import { useAppStore } from '../stores/app'

const STATUS_LABEL: Record<Project['status'], string> = { active: '进行中', paused: '暂停', done: '已完成', archived: '归档' }

export function ProjectsPage() {
  const subjects = useAppStore((s) => s.subjects)
  const showToast = useAppStore((s) => s.showToast)
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [subjectId, setSubjectId] = useState('')

  const reload = useCallback(async () => {
    const res = await window.api.projects.list()
    if (res.ok) setProjects(res.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = async (): Promise<void> => {
    if (!title.trim()) {
      showToast('项目标题必填')
      return
    }
    const res = await window.api.projects.create({ title: title.trim(), goal: goal.trim(), subject_id: subjectId || null })
    if (res.ok) {
      setTitle('')
      setGoal('')
      setCreating(false)
      void reload()
    } else {
      showToast(`创建失败：${res.error}`)
    }
  }

  return (
    <div className="page">
      <h1>项目</h1>
      <div className="muted" style={{ marginBottom: 14 }}>
        课程项目、科研训练、竞赛与跨学科课题：目标、里程碑、任务与知识点引用统一管理。跨学科项目可不挂学科。
      </div>

      <div className="toolbar">
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '+ 新建项目'}
        </button>
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 14, maxWidth: 720 }}>
          <div className="form-grid2">
            <div className="field">
              <label>项目标题</label>
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：桁架结构优化课程项目" />
            </div>
            <div className="field">
              <label>学科（可空 = 跨学科）</label>
              <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">跨学科</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>项目要求 / 目标</label>
              <textarea value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="交付物、验收标准、约束条件…" style={{ minHeight: 64 }} />
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => void create()}>
              保存项目
            </button>
            <button onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      )}

      {projects.length === 0 && <div className="empty">还没有项目</div>}

      <div className="row-list">
        {projects.map((p) => (
          <div key={p.id} className="row-item">
            <div className="grow">
              <Link to={`/projects/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="title" style={{ fontWeight: 700 }}>
                  {p.title}
                  <span className="pill" style={{ marginLeft: 8 }}>{STATUS_LABEL[p.status]}</span>
                </div>
              </Link>
              <div className="meta">
                {p.subject_id ? subjects.find((s) => s.id === p.subject_id)?.name ?? '' : '跨学科'}
                {p.goal && ` · ${p.goal.slice(0, 50)}`}
              </div>
              {p.counts && (
                <div className="meta">
                  里程碑 {p.counts.milestones_done}/{p.counts.milestones} · 任务 {p.counts.tasks_done}/{p.counts.tasks}
                </div>
              )}
            </div>
            <button
              onClick={() => {
                if (window.confirm(`删除项目「${p.title}」及其里程碑与项目任务？`)) {
                  void window.api.projects.remove(p.id).then(() => void reload())
                }
              }}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
