/**
 * pages/Dashboard.tsx —— 总览页：快速入口 + 近况
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Note, ChatSession, Inspiration } from '@shared/types'
import { useAppStore } from '../stores/app'

export function Dashboard() {
  const subjects = useAppStore((s) => s.subjects)
  const [notes, setNotes] = useState<Note[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [inspirations, setInspirations] = useState<Inspiration[]>([])

  useEffect(() => {
    void (async () => {
      const [n, c, i] = await Promise.all([
        window.api.notes.list(),
        window.api.chat.listSessions(),
        window.api.inspirations.list()
      ])
      if (n.ok) setNotes(n.data.slice(0, 5))
      if (c.ok) setSessions(c.data.slice(0, 5))
      if (i.ok) setInspirations(i.data.slice(0, 5))
    })()
  }, [])

  return (
    <div className="page">
      <h1>总览</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <div className="card">
          <h3 style={{ margin: '0 0 8px' }}>最近笔记</h3>
          {notes.length === 0 && <div className="muted">还没有笔记，去 <Link to="/notes">笔记页</Link> 创建第一篇</div>}
          <div className="row-list">
            {notes.map((n) => (
              <Link key={n.id} to={`/notes/${n.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="row-item">
                  <div className="grow">
                    <div className="title">{n.title}</div>
                    <div className="meta">{new Date(n.updated_at).toLocaleString('zh-CN')}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ margin: '0 0 8px' }}>最近对话</h3>
          {sessions.length === 0 && <div className="muted">还没有对话，用底部「询问智能体」开始提问</div>}
          <div className="row-list">
            {sessions.map((s) => (
              <Link key={s.id} to="/chat" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="row-item">
                  <div className="grow">
                    <div className="title">{s.title}</div>
                    <div className="meta">{new Date(s.updated_at).toLocaleString('zh-CN')}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 style={{ margin: '0 0 8px' }}>最新灵感</h3>
          {inspirations.length === 0 && <div className="muted">课堂上的灵光一现，记到 <Link to="/inspirations">灵感库</Link></div>}
          <div className="row-list">
            {inspirations.map((i) => (
              <div key={i.id} className="row-item">
                <div className="grow">
                  <div>{i.content.slice(0, 80)}</div>
                  <div className="meta">{new Date(i.created_at).toLocaleString('zh-CN')}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: '0 0 8px' }}>学科</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {subjects.map((s) => (
            <span key={s.id} className="pill" style={{ borderLeft: `3px solid ${s.color}`, paddingLeft: 8 }}>
              {s.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
