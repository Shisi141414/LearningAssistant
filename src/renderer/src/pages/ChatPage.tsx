/**
 * pages/ChatPage.tsx —— 智能体对话
 *
 * - 多会话侧栏（挂当前学科）
 * - 流式渲染（chunk 事件驱动，见 stores/chat.ts）
 * - 中断生成
 * - 模型选择（跨供应商的所有已配置模型）
 */
import { useEffect, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'

export function ChatPage() {
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const showToast = useAppStore((s) => s.showToast)
  const chat = useChatStore()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelDbId, setModelDbId] = useState<string>('')
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void chat.loadSessions()
    void window.api.models.list().then((res) => {
      if (res.ok) setModels(res.data)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 流式时自动滚动到底
  useEffect(() => {
    if (chat.streamingIds.size > 0 && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [chat.messages, chat.streamingIds])

  const send = async (): Promise<void> => {
    const content = input.trim()
    if (!content) return
    let sessionId = chat.activeSessionId
    if (!sessionId) {
      const s = await chat.createSession(currentSubjectId, content.slice(0, 20))
      sessionId = s?.id ?? null
    }
    if (!sessionId) {
      showToast('无法创建会话')
      return
    }
    setInput('')
    try {
      await chat.sendMessage(content, { modelDbId: modelDbId || null })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const streamingMsgId = [...chat.streamingIds][0]

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>对话</h1>
        <select value={modelDbId} onChange={(e) => setModelDbId(e.target.value)} style={{ minWidth: 240 }}>
          <option value="">默认模型（第一个可用）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}（{m.model_id}）
            </option>
          ))}
        </select>
        {models.length === 0 && (
          <span className="muted">
            还没有配置模型，到 <a href="#/settings">设置 → 模型服务</a> 添加
          </span>
        )}
      </div>

      <div className="chat-wrap">
        <div className="chat-sessions">
          <button className="primary" onClick={() => void chat.createSession(currentSubjectId)}>
            + 新会话
          </button>
          {chat.sessions.map((s) => (
            <div
              key={s.id}
              className={`row-item${s.id === chat.activeSessionId ? ' active' : ''}`}
              style={{
                padding: '8px 10px',
                cursor: 'pointer',
                borderColor: s.id === chat.activeSessionId ? 'var(--accent)' : undefined
              }}
              onClick={() => void chat.openSession(s.id)}
            >
              <div className="grow">
                <div style={{ fontWeight: s.id === chat.activeSessionId ? 700 : 500, fontSize: 13 }}>{s.title}</div>
                <div className="meta">{new Date(s.updated_at).toLocaleDateString('zh-CN')}</div>
              </div>
              <button
                style={{ padding: '2px 6px', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation()
                  void chat.removeSession(s.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="chat-main">
          <div className="chat-scroll" ref={scrollRef}>
            {chat.messages.length === 0 && (
              <div className="empty">向智能体提问吧——支持数学公式（LaTeX）、多轮追问；底部快捷栏可从任意页面发起提问</div>
            )}
            {chat.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.content}
                {m.id === streamingMsgId && <span className="cursor" />}
                {m.role === 'assistant' && m.id !== streamingMsgId && chat.modelLabels[m.id] && (
                  <div className="msg-meta">{chat.modelLabels[m.id]}</div>
                )}
              </div>
            ))}
          </div>

          <div className="chat-input">
            <textarea
              placeholder="输入问题，Enter 发送，Shift+Enter 换行"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {streamingMsgId ? (
              <button onClick={() => void chat.abort(streamingMsgId)}>停止</button>
            ) : (
              <button className="primary" onClick={() => void send()}>
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
