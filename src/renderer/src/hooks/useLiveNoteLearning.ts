import { useEffect, useEffectEvent, useRef } from 'react'
import type { NoteLearningDocument } from '@shared/types'

/** 同一课堂的持久化变化合并为串行读取；连续事件不延后已有定时器。 */
export function useLiveNoteLearning({ noteId, token, applied, enabled, onDocument, onError }: {
  noteId: string; token?: object; applied?: object; enabled: boolean
  onDocument: (document: NoteLearningDocument, token: object) => void; onError: (message: string) => void
}) {
  const accept = useEffectEvent(onDocument), fail = useEffectEvent(onError)
  const invalidate = useRef<(token?: object, applied?: object) => void>(() => undefined)
  useEffect(() => {
    if (!enabled) return
    let alive = true, running = false, queued: object | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { if (alive && queued && !running && !timer) timer = setTimeout(() => { timer = undefined; void read() }, 250) }
    const read = async () => {
      if (!alive || !queued) return
      const requested = queued; queued = undefined; running = true
      try {
        const result = await window.api.notes.learningGet({ note_id: noteId })
        if (alive) { if (result.ok) accept(result.data, requested); else fail(result.error) }
      } catch (error) { if (alive) fail(error instanceof Error ? error.message : '课堂文档更新失败，请读取最新笔记重试') }
      finally { running = false; if (queued === requested) queued = undefined; schedule() }
    }
    invalidate.current = (next, current) => {
      if (!alive || !next) return
      if (next === current) { if (queued === next) queued = undefined; return }
      queued = next; schedule()
    }
    return () => { alive = false; if (timer) clearTimeout(timer); invalidate.current = () => undefined }
  }, [noteId, enabled])
  useEffect(() => { invalidate.current(token, applied) }, [noteId, enabled, token, applied])
}
