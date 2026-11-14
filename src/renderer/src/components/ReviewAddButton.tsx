import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReviewSource } from '@shared/reviews'
import { useAppStore } from '../stores/app'
export function ReviewAddButton({
  source,
  disabled = false
}: {
  source: ReviewSource
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    navigate = useNavigate()
  const toast = useAppStore((s) => s.showToast)
  return (
    <button
      title="使用已保存的版本加入复习"
      disabled={disabled || busy}
      onClick={async () => {
        if (lock.current) return
        lock.current = true
        setBusy(true)
        try {
          const result = await window.api.reviews.add(source)
          if (result.ok)
            navigate(`/practice?card=${encodeURIComponent(result.data.id)}`)
          else toast(result.error)
        } finally {
          lock.current = false
          setBusy(false)
        }
      }}
    >
      {busy ? '正在加入…' : '加入复习'}
    </button>
  )
}
