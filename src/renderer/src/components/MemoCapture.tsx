import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MathInput } from './MathInput'
import { useAppStore } from '../stores/app'
import '../pages/memos.css'

export function MemoCapture({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false),
    navigate = useNavigate()
  const { currentSubjectId, subjects, showToast } = useAppStore()
  const [content, setContent] = useState(''),
    [subject, setSubject] = useState(currentSubjectId ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const close = (): void => {
    if (!busy && (!content.trim() || window.confirm('放弃尚未保存的备忘？')))
      onClose()
  }
  const save = async (open: boolean): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.api.memos.save({
        content,
        subject_id: subject || null
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      showToast('备忘已保存')
      onClose()
      if (
        open &&
        window.dispatchEvent(
          new Event('memo-before-navigate', { cancelable: true })
        )
      )
        navigate('/memos?memo=' + encodeURIComponent(result.data.memo.id))
      window.dispatchEvent(new Event('memos-changed'))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="memo-capture"
      aria-label="随手记备忘"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="memo-heading">
        <h2>随手记</h2>
        <button aria-label="关闭备忘窗口" disabled={busy} onClick={close}>
          ×
        </button>
      </div>
      <p className="muted">先保存原文，稍后再整理为知识或日程。</p>
      <fieldset disabled={busy}>
        <div inert={busy}>
          <MathInput
            label="随手记原文"
            value={content}
            onChange={setContent}
            placeholder="重要的事情、知识点、待办或项目想法…"
          />
        </div>
        <label>
          学科
          <select
            aria-label="随手记学科"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">待定</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <button
            className="primary"
            disabled={!content.trim()}
            onClick={() => void save(false)}
          >
            保存备忘
          </button>
          <button disabled={!content.trim()} onClick={() => void save(true)}>
            保存并整理
          </button>
        </div>
      </fieldset>
    </dialog>
  )
}
