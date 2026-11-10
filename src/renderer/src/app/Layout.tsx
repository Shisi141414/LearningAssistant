/**
 * app/Layout.tsx —— 侧边栏 + 内容区 + 底部快捷栏 + toast
 */
import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAppStore } from '../stores/app'
import { QuickBar } from './QuickBar'

const NAV = [
  { to: '/', label: '总览', end: true },
  { to: '/classroom', label: '课堂' },
  { to: '/notes', label: '笔记' },
  { to: '/activities', label: '活动' },
  { to: '/chat', label: '对话' },
  { to: '/knowledge', label: '知识网络', badge: 'M2' },
  { to: '/library', label: '知识库', badge: 'M3' },
  { to: '/exercises', label: '习题库', badge: 'M3' },
  { to: '/review', label: '复习', badge: 'M4' },
  { to: '/inspirations', label: '灵感' },
  { to: '/settings', label: '设置' }
]

export function Layout({ children }: { children: ReactNode }) {
  const subjects = useAppStore((s) => s.subjects)
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const setCurrentSubject = useAppStore((s) => s.setCurrentSubject)
  const toast = useAppStore((s) => s.toast)

  return (
    <div className="app-shell">
      <div className="app-body">
        <aside className="sidebar">
          <div className="brand">
            Learning<span>Assistant</span>
          </div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              {n.label}
              {n.badge && <span className="badge">{n.badge}</span>}
            </NavLink>
          ))}
          <div className="subject-box">
            <label>当前学科</label>
            <select value={currentSubjectId ?? ''} onChange={(e) => setCurrentSubject(e.target.value || null)} style={{ width: '100%' }}>
              <option value="">全部</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </aside>
        <main className="content">{children}</main>
      </div>
      <QuickBar />
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
