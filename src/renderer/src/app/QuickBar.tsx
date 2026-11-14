import { MemoCapture } from '../components/MemoCapture'
/**
 * app/QuickBar.tsx —— 全局底部快捷栏（需求 #9）
 *
 * 交互设计（M0 版）：
 *  - "询问智能体"：输入回车 → 跳转对话页并发送。若页面上有选中文本：
 *      · 选中文本在笔记段落内（data-segment-id 可定位）→ 作为 context_refs 引用
 *      · 否则 → 选中文字直接拼进提问
 *  - "重点" / "疑问"：抓当前选区；能定位到笔记段落 → 直接建标注；否则 toast 引导
 */
import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AnnotationKind, ContextRef } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'
import { MathInput } from '../components/MathInput'

/** 从当前 Selection 提取（文本, 段落定位） */
function captureSelection(): { text: string; segmentId: string | null } {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return { text: '', segmentId: null }
  const text = sel.toString().trim()
  if (!text) return { text: '', segmentId: null }
  let node: Node | null = sel.anchorNode
  while (node && node !== document.body) {
    if (node instanceof HTMLElement && node.dataset.segmentId) {
      return { text, segmentId: node.dataset.segmentId }
    }
    node = node.parentElement
  }
  return { text, segmentId: null }
}

export function QuickBar() {
  const [question, setQuestion] = useState('')
  const [memoOpen, setMemoOpen] = useState(false)
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const chat = useChatStore()
  const lastSelection = useRef<{ text: string; segmentId: string | null }>({ text: '', segmentId: null })

  /** mousedown 时记录选区（点击按钮会清空 selection） */
  const capture = (): void => {
    lastSelection.current = captureSelection()
  }

  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (!q) {
      showToast('请输入问题')
      return
    }
    if (!window.dispatchEvent(new Event('memo-before-navigate', { cancelable: true }))) return
    capture()
    const sel = lastSelection.current
    let content = q
    let contextRefs: ContextRef[] | undefined
    if (sel.text) {
      if (sel.segmentId) {
        contextRefs = [{ type: 'note_segment', id: sel.segmentId }]
        content = `${q}\n\n（已附上我在笔记中选中的内容作为参考）`
      } else {
        content = `${q}\n\n我选中的内容：\n${sel.text}`
      }
    }
    // 确保有会话（无则建一个挂当前学科）
    let sessionId = chat.activeSessionId
    if (!sessionId) {
      const s = await chat.createSession(currentSubjectId, q.slice(0, 20))
      sessionId = s?.id ?? null
    }
    if (!sessionId) {
      showToast('创建会话失败')
      return
    }
    navigate('/chat')
    try {
      await chat.sendMessage(content, { contextRefs })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
    setQuestion('')
  }

  const annotate = async (kind: AnnotationKind): Promise<void> => {
    capture()
    const sel = lastSelection.current
    if (!sel.segmentId) {
      showToast(kind === 'keypoint' ? '请先选中笔记中的内容再标重点（进入笔记页选中段落文本）' : '请先选中笔记中的内容再标疑问（进入笔记页选中段落文本）')
      return
    }
    const res = await window.api.annotations.add({
      segment_id: sel.segmentId,
      kind,
      comment: sel.text.slice(0, 120)
    })
    showToast(res.ok ? (kind === 'keypoint' ? '已标记重点' : '已标记疑问') : `标注失败：${res.error}`)
  }

  return (
    <>
      <div className="quickbar">
        <MathInput
          multiline={false}
          placeholder="询问智能体…（选中内容后会自动附为参考，∑ 数学符号）"
          value={question}
          onChange={setQuestion}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask()
          }}
        />
        <button className="primary" onMouseDown={capture} onClick={() => void ask()}>
          询问智能体
        </button>
        <button onClick={() => setMemoOpen(true)}>随手记</button>
        <button onMouseDown={capture} onClick={() => void annotate('keypoint')} title="选中笔记内容后一键标记重点">
          ⭐ 重点
        </button>
        <button onMouseDown={capture} onClick={() => void annotate('question')} title="选中笔记内容后一键标记疑问">
          ❓ 疑问
        </button>
      </div>
      {memoOpen && <MemoCapture onClose={() => setMemoOpen(false)} />}
    </>
  )
}
