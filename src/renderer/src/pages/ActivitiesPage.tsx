/**
 * pages/ActivitiesPage.tsx —— 活动管理（讲座/会议/研讨，ADR-5）
 *
 * 与课程共用全部笔记/对话/课堂管线，但独立分组：
 * 按类型筛选、按举行时间倒序、每场可关联学科。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Activity, ActivityKind } from '@shared/types'
import { ACTIVITY_KIND_META } from '@shared/types'
import { useAppStore } from '../stores/app'

const KINDS: Array<{ key: ActivityKind | ''; label: string }> = [
  { key: '', label: '全部' },
  { key: 'lecture', label: '讲座' },
  { key: 'seminar', label: '研讨' },
  { key: 'meeting', label: '会议' },
  { key: 'other', label: '其他' }
]

export function ActivitiesPage() {
  const subjects = useAppStore((s) => s.subjects)
  const showToast = useAppStore((s) => s.showToast)
  const [activities, setActivities] = useState<Activity[]>([])
  const [kindFilter, setKindFilter] = useState<ActivityKind | ''>('')
  const [creating, setCreating] = useState(false)

  // 新建表单
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<ActivityKind>('lecture')
  const [date, setDate] = useState('') // yyyy-MM-dd
  const [subjectId, setSubjectId] = useState('')
  const [description, setDescription] = useState('')

  const reload = useCallback(async () => {
    const res = await window.api.activities.list(kindFilter ? { kind: kindFilter } : undefined)
    if (res.ok) setActivities(res.data)
  }, [kindFilter])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = async (): Promise<void> => {
    if (!title.trim()) {
      showToast('请填写活动标题')
      return
    }
    const res = await window.api.activities.create({
      title: title.trim(),
      kind,
      happened_at: date ? new Date(`${date}T12:00:00`).getTime() : null,
      subject_id: subjectId || null,
      description: description.trim()
    })
    if (res.ok) {
      setTitle('')
      setDescription('')
      setCreating(false)
      void reload()
    } else {
      showToast(`创建失败：${res.error}`)
    }
  }

  const remove = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`删除活动「${name}」？其下笔记将保留（变为未挂载）。`)) return
    const res = await window.api.activities.remove(id)
    if (res.ok) void reload()
    else showToast(`删除失败：${res.error}`)
  }

  return (
    <div className="page">
      <h1>活动</h1>
      <div className="muted" style={{ marginBottom: 14 }}>
        讲座、会议、研讨与课程共用同一套记录管线（笔记 / 对话 / 课堂模式），但独立分组管理——每场主题独立，可关联学科以接入知识网络。
      </div>

      <div className="toolbar">
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? '收起' : '+ 新建活动'}
        </button>
        {KINDS.map((k) => (
          <button
            key={k.key}
            style={{
              padding: '4px 12px',
              fontSize: 13,
              ...(kindFilter === k.key
                ? { background: 'var(--accent-weak)', color: 'var(--accent)', borderColor: 'var(--accent)', fontWeight: 600 }
                : {})
            }}
            onClick={() => setKindFilter(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="form-grid">
            <label>标题</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：计算力学前沿学术报告" autoFocus />

            <label>类型</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
              <option value="lecture">讲座</option>
              <option value="seminar">研讨 / 讨论</option>
              <option value="meeting">会议</option>
              <option value="other">其他</option>
            </select>

            <label>日期</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

            <label>关联学科</label>
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">不关联</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <label>备注</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="主讲人、地点等（选填）" />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="primary" onClick={() => void create()}>
              保存活动
            </button>
            <button onClick={() => setCreating(false)}>取消</button>
          </div>
        </div>
      )}

      {activities.length === 0 && <div className="empty">还没有活动记录</div>}

      <div className="row-list">
        {activities.map((a) => {
          const meta = ACTIVITY_KIND_META[a.kind]
          return (
            <div key={a.id} className="row-item">
              <div className="grow">
                <Link to={`/activities/${a.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {a.title}
                    <span className="pill" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, white)` }}>
                      {meta.label}
                    </span>
                  </div>
                </Link>
                <div className="meta">
                  {a.happened_at ? new Date(a.happened_at).toLocaleDateString('zh-CN') : '日期未定'}
                  {a.subject_id && ` · 关联 ${subjects.find((s) => s.id === a.subject_id)?.name ?? ''}`}
                  {a.description && ` · ${a.description.slice(0, 40)}`}
                </div>
              </div>
              <span className="pill">{a.notes_count ?? 0} 篇笔记</span>
              <button onClick={() => void remove(a.id, a.title)}>删除</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
