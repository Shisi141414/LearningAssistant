/**
 * App.tsx —— 路由与全局副作用
 */
import { useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Layout } from './app/Layout'
import { ErrorBoundary } from './app/ErrorBoundary'
import { Dashboard } from './pages/Dashboard'
import { NotesPage } from './pages/NotesPage'
import { NoteDetail } from './pages/NoteDetail'
import { ActivitiesPage } from './pages/ActivitiesPage'
import { ActivityDetail } from './pages/ActivityDetail'
import { ChatPage } from './pages/ChatPage'
import { ClassroomPage } from './pages/ClassroomPage'
import { SettingsPage } from './pages/SettingsPage'
import { InspirationPage } from './pages/InspirationPage'
import { Placeholder } from './pages/Placeholder'
import { MaterialLibraryPage } from './pages/MaterialLibraryPage'
import { useAppStore } from './stores/app'
import { useChatStore } from './stores/chat'
import { KnowledgePage } from './pages/KnowledgePage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ProjectDetail } from './pages/ProjectDetail'
import { SchedulePage } from './pages/SchedulePage'
import { useConceptStore } from './stores/concepts'
import './pages/knowledge.css'

export default function App() {
  const loadSubjects = useAppStore((s) => s.loadSubjects)
  const showToast = useAppStore((s) => s.showToast)
  const chat = useChatStore()

  useEffect(() => {
    void loadSubjects()
    void useConceptStore.getState().load()
  }, [loadSubjects])

  // 订阅 LLM 流式事件（全局一次）
  useEffect(() => {
    const offChunk = window.api.onLlmChunk((e) => chat.appendChunk(e.session_id, e.message_id, e.delta))
    const offDone = window.api.onLlmDone((e) => chat.finishMessage(e.session_id, e.message_id, e.content, e.model_display))
    const offError = window.api.onLlmError((e) => {
      try {
        chat.failMessage(e.session_id, e.message_id, e.error)
      } catch {
        showToast(e.error)
      }
    })
    return () => {
      offChunk()
      offDone()
      offError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/classroom" element={<ClassroomPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/notes/:noteId" element={<NoteDetail />} />
        <Route path="/activities" element={<ActivitiesPage />} />
        <Route path="/activities/:activityId" element={<ActivityDetail />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/library" element={<MaterialLibraryPage />} />
        <Route path="/exercises" element={<Placeholder title="习题库" stage="M3" desc="习题条目化管理、思路图示、错误点标记、关联教材与笔记。" />} />
        <Route path="/review" element={<SchedulePage />} />
        <Route path="/inspirations" element={<InspirationPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </ErrorBoundary>
    </Layout>
  )
}
