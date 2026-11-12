/**
 * pages/InspirationPage.tsx —— 灵感库（需求 #8）
 */
import { useCallback, useEffect, useState } from 'react'
import type { Inspiration } from '@shared/types'
import { useAppStore } from '../stores/app'
import { MathInput } from '../components/MathInput'

export function InspirationPage() {
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const subjects = useAppStore((s) => s.subjects)
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<Inspiration[]>([])
  const [text, setText] = useState('')

  const reload = useCallback(async () => {
    const res = await window.api.inspirations.list()
    if (res.ok) setItems(res.data)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const add = async (): Promise<void> => {
    const content = text.trim()
    if (!content) return
    const res = await window.api.inspirations.add({ content, subject_id: currentSubjectId })
    if (res.ok) {
      setText('')
      void reload()
    } else {
      showToast(`保存失败：${res.error}`)
    }
  }

  const subjectName = (id: string | null): string => subjects.find((s) => s.id === id)?.name ?? '未分类'

  return (
    <div className="page">
      <h1>灵感库</h1>
      <div className="muted" style={{ marginBottom: 12 }}>
        课堂上或自习时冒出的新想法、新问题、新角度——先记下来，别让它溜走。记录时会挂到当前学科。
      </div>
      <div className="toolbar">
        <MathInput
          minHeight={64}
          placeholder="例如：能不能把变分法用在优化课程的排课上？（∑ 数学符号）"
          value={text}
          onChange={setText}
        />
        <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={() => void add()}>
          记录灵感
        </button>
      </div>

      <div className="row-list">
        {items.length === 0 && <div className="empty">还没有记录</div>}
        {items.map((i) => (
          <div key={i.id} className="row-item">
            <div className="grow">
              <div style={{ whiteSpace: 'pre-wrap' }}>{i.content}</div>
              <div className="meta">
                {subjectName(i.subject_id)} · {new Date(i.created_at).toLocaleString('zh-CN')}
              </div>
            </div>
            <button
              onClick={() => {
                void window.api.inspirations.remove(i.id).then(() => void reload())
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
