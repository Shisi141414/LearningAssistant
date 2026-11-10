/**
 * pages/ActivityDetail.tsx —— 单场活动：信息 + 该活动的笔记 + 就本场内容发起对话
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import type { Activity, Note } from '@shared/types'
import { ACTIVITY_KIND_META } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'

export function ActivityDetail() {
  const { activityId } = useParams<{ activityId: string }>()
  const navigate = useNavigate()
  const subjects = useAppStore((s) => s.subjects)
  const showToast = useAppStore((s) => s.showToast)
  const chat = useChatStore()
  const [activity, setActivity] = useState<Activity | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [newTitle, setNewTitle] = useState('')

  const reload = useCallback(async () => {
    if (!activityId) return
    const [listRes, notesRes] = await Promise.all([
      window.api.activities.list(),
      window.api.notes.list({ activity_id: activityId })
    ])
    if (listRes.ok) setActivity(listRes.data.find((a) => a.id === activityId) ?? null)
    if (notesRes.ok) setNotes(notesRes.data)
  }, [activityId])

  useEffect(() => {
    void reload()
  }, [reload])

  if (!activity) return <div className="page">加载中…</div>

  const meta = ACTIVITY_KIND_META[activity.kind]
  const subjectName = subjects.find((s) => s.id === activity.subject_id)?.name

  const createNote = async (): Promise<void> => {
    const title = newTitle.trim() || `${activity.title} · 记录`
    const res = await window.api.notes.create({ title, activity_id: activity.id })
    if (res.ok) {
      setNewTitle('')
      navigate(`/notes/${res.data.id}`)
    } else {
      showToast(`创建失败：${res.error}`)
    }
  }

  const askAboutThis = async (): Promise<void> => {
    const s = await chat.createSession(null, activity.title, activity.id)
    if (s) navigate('/chat')
    else showToast('创建会话失败')
  }

  return (
    <div className="page">
      <div className="toolbar">
        <Link to="/activities">← 活动</Link>
        <h1 style={{ margin: 0, flex: 1 }}>{activity.title}</h1>
        <span className="pill" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, white)` }}>
          {meta.label}
        </span>
        <button onClick={() => void askAboutThis()}>💬 就本场提问</button>
      </div>
      <div className="muted" style={{ marginBottom: 14 }}>
        {activity.happened_at ? new Date(activity.happened_at).toLocaleDateString('zh-CN') : '日期未定'}
        {subjectName && ` · 关联学科：${subjectName}`}
        {activity.description && ` · ${activity.description}`}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 10px' }}>本活动的笔记</h3>
        <div className="toolbar">
          <input
            placeholder={`新笔记标题（默认「${activity.title} · 记录”）`}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createNote()
            }}
            style={{ flex: 1, maxWidth: 420 }}
          />
          <button className="primary" onClick={() => void createNote()}>
            + 新建笔记
          </button>
        </div>
        {notes.length === 0 && <div className="empty">本场还没有笔记——讲座开始前先建一篇，课上用课堂模式记录</div>}
        <div className="row-list">
          {notes.map((n) => (
            <div key={n.id} className="row-item">
              <div className="grow">
                <Link to={`/notes/${n.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="title">{n.title}</div>
                </Link>
                <div className="meta">更新于 {new Date(n.updated_at).toLocaleString('zh-CN')}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
