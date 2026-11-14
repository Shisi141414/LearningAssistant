import { useEffect, useRef, useState } from 'react'
import type { ClassroomAlignmentState } from '@shared/classroom-alignment'
import type { MaterialAnchor } from '@shared/types'
import { useAppStore } from '../stores/app'

export function ClassroomAlignmentPanel({
  noteId,
  onChange,
  onCalibrate
}: {
  noteId: string
  onChange: () => Promise<void>
  onCalibrate: (anchor: MaterialAnchor) => Promise<void>
}) {
  const [state, setState] = useState<ClassroomAlignmentState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const callbacks = useRef({ onChange, onCalibrate })
  callbacks.current = { onChange, onCalibrate }
  const showToast = useAppStore((s) => s.showToast)
  useEffect(() => {
    let alive = true
    let stamp = ''
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const result = await window.api.classroom.alignment(noteId)
        if (!alive) return
        if (!result.ok) {
          setError(result.error)
          return
        }
        const next = JSON.stringify(result.data)
        if (next !== stamp) {
          stamp = next
          setState(result.data)
          setError('')
          await callbacks.current.onChange()
        }
      } catch {
        if (alive) setError('教材定位状态暂时不可读，稍后重试')
      } finally {
        if (alive) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [noteId])
  const toggle = async (): Promise<void> => {
    if (!state || busy) return
    setBusy(true)
    try {
      const result = await window.api.classroom.alignmentSave({
        note_id: noteId,
        revision: state.revision,
        enabled: !state.enabled
      })
      if (!result.ok) {
        showToast(result.error)
        return
      }
      setState(result.data)
    } finally {
      setBusy(false)
    }
  }
  const calibrate = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const anchor = await window.api.materials.anchor(id)
      if (!anchor.ok) {
        showToast(anchor.error)
        return
      }
      await callbacks.current.onCalibrate(anchor.data)
    } finally {
      setBusy(false)
    }
  }
  const latest = state?.jobs.find(
    (job) => job.epoch === state.revision && job.session_id === state.session_id
  )
  const labels = {
    queued: '等待匹配',
    running: '正在匹配',
    applied: '已自动定位',
    review: '位置待校准',
    cancelled: '已停止',
    failed: '位置待校准'
  }
  return (
    <section className="classroom-alignment" aria-label="教材自动定位">
      <label>
        <input
          type="checkbox"
          aria-label="自动跟随教材"
          checked={state?.enabled ?? false}
          disabled={!state || busy}
          onChange={() => void toggle()}
        />{' '}
        自动跟随教材
      </label>
      <span className="muted"> 本地匹配，不额外发送转写；手动校准优先。</span>
      {error && <p role="alert">{error}</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      <p role="status">
        {!state?.enabled
          ? '自动跟随已暂停，保留当前讲授位置。'
          : latest
            ? latest.reason.startsWith(labels[latest.status])
              ? latest.reason
              : `${labels[latest.status]}：${latest.reason}`
            : '已启用，等待新的课堂语段。'}
      </p>
      {latest &&
        state?.enabled &&
        latest.status === 'review' &&
        !!latest.candidates.length && (
          <details className="alignment-review">
            <summary>核对候选（{latest.candidates.length}）</summary>
            <div className="alignment-candidates">
              {latest.candidates.map((candidate) => (
                <div key={candidate.id}>
                  <strong>
                    条目 {candidate.ordinal + 1} · 文本匹配度{' '}
                    {Math.round(candidate.coverage * 100)}%
                  </strong>
                  <p>{candidate.text.slice(0, 160)}</p>
                  <small>
                    匹配词：{candidate.terms.join('、')}（匹配度不是正确概率）
                  </small>
                  <button
                    disabled={busy}
                    onClick={() => void calibrate(candidate.id)}
                  >
                    按此校准
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      {!!state?.jobs.length && (
        <details>
          <summary>定位记录（最近 {state.jobs.length} 段）</summary>
          {state.jobs.map((job) => (
            <p key={job.id}>
              {new Date(job.created_at).toLocaleTimeString('zh-CN')} ·{' '}
              {labels[job.status]} · {job.reason}
              {job.applied_block_id &&
                ` · 条目 ${(job.candidates[0]?.ordinal ?? 0) + 1}`}
            </p>
          ))}
        </details>
      )}
    </section>
  )
}
