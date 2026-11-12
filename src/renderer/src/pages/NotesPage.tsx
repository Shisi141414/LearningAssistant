/**
 * pages/NotesPage.tsx —— 笔记列表（按当前学科过滤）
 */
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Note } from '@shared/types'
import { NotePackageImport } from '../components/NotePackageImport'
import { useAppStore } from '../stores/app'

const SOURCE_LABEL: Record<Note['source'], string> = {
  manual: '手动',
  class: '课堂',
  import: '导入'
}

export function NotesPage() {
  const navigate = useNavigate()
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const subjects = useAppStore((s) => s.subjects)
  const showToast = useAppStore((s) => s.showToast)
  const [notes, setNotes] = useState<Note[]>([])
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const reload = useCallback(async () => {
    // 按当前学科过滤课程笔记；"全部"时混入活动笔记（带活动标题标识）
    const res = await window.api.notes.list(currentSubjectId ? { subject_id: currentSubjectId } : undefined)
    if (res.ok) setNotes(res.data)
  }, [currentSubjectId])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    const res = await window.api.notes.create({ title, subject_id: currentSubjectId })
    if (res.ok) {
      setNewTitle('')
      setCreating(false)
      void reload()
    } else {
      showToast(`创建失败：${res.error}`)
    }
  }

  const remove = async (id: string): Promise<void> => {
    const res = await window.api.notes.remove(id)
    if (res.ok) void reload()
    else showToast(`删除失败：${res.error}`)
  }

  return (
    <div className="page">
      <h1>笔记</h1>
      <NotePackageImport subjectId={currentSubjectId || ''} onImported={async result => { await reload(); navigate(`/notes/${result.note_id}?view=uniform`) }} />
      <div className="toolbar">
        <button className="primary" onClick={() => setCreating(true)}>
          + 新建笔记
        </button>
        <span className="muted">
          {currentSubjectId ? `当前学科：${subjects.find((s) => s.id === currentSubjectId)?.name}` : '全部学科'}
        </span>
      </div>

      {creating && (
        <div className="toolbar">
          <input
            autoFocus
            placeholder="笔记标题，如：11月10日 数学分析 课上"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
              if (e.key === 'Escape') setCreating(false)
            }}
            style={{ flex: 1, maxWidth: 420 }}
          />
          <button onClick={() => void create()}>创建</button>
          <button onClick={() => setCreating(false)}>取消</button>
        </div>
      )}

      {notes.length === 0 && <div className="empty">还没有笔记——点击「新建笔记」开始</div>}

      <div className="row-list">
        {notes.map((n) => (
          <div key={n.id} className="row-item">
            <div className="grow">
              <Link to={`/notes/${n.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="title">{n.title}</div>
              </Link>
              <div className="meta">
                {n.activity_id ? `活动：${n.activity_title ?? ''} · ` : ''}
                {SOURCE_LABEL[n.source]} · 更新于 {new Date(n.updated_at).toLocaleString('zh-CN')}
              </div>
            </div>
            <button onClick={() => void remove(n.id)}>删除</button>
          </div>
        ))}
      </div>
    </div>
  )
}
