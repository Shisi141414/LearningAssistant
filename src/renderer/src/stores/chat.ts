/**
 * stores/chat.ts —— 会话与流式消息状态
 * 流式事件（llm:chunk/done/error）在 App 挂载时统一订阅，写入本 store。
 */
import { create } from 'zustand'
import type { ChatSession, ChatMessage, ContextRef, ID } from '@shared/types'

function upsertAssistant(messages: ChatMessage[], sessionId: ID, id: ID, content: string, append = false): ChatMessage[] {
  const exists = messages.some((m) => m.id === id)
  if (exists) return messages.map((m) => m.id === id ? { ...m, content: append ? m.content + content : content } : m)
  return [...messages, { id, session_id: sessionId, role: 'assistant', content, context_json: null, created_at: Date.now() }]
}

interface ChatState {
  sessions: ChatSession[]
  activeSessionId: ID | null
  messages: ChatMessage[]
  /** 正在生成的 message id 集合 */
  streamingIds: Set<ID>
  streamSessions: Record<ID, ID>
  /** 各 assistant 消息的模型标注 */
  modelLabels: Record<ID, string>
  loadSessions: () => Promise<void>
  openSession: (id: ID | null) => Promise<ChatSession | null>
  createSession: (subjectId: ID | null, title?: string, activityId?: ID | null) => Promise<ChatSession | null>
  removeSession: (id: ID) => Promise<void>
  sendMessage: (content: string, opts?: { contextRefs?: ContextRef[]; modelDbId?: ID | null }) => Promise<void>
  abort: (messageId: ID) => Promise<void>
  appendChunk: (sessionId: ID, messageId: ID, delta: string) => void
  finishMessage: (sessionId: ID, messageId: ID, content: string, modelDisplay: string) => void
  failMessage: (sessionId: ID, messageId: ID, error: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamingIds: new Set(),
  streamSessions: {},
  modelLabels: {},

  loadSessions: async () => {
    const res = await window.api.chat.listSessions()
    if (res.ok) set({ sessions: res.data })
  },

  openSession: async (id) => {
    if (!id) {
      set({ activeSessionId: null, messages: [] })
      return null
    }
    const res = await window.api.chat.getMessages(id)
    if (!res.ok) return null
    set({ activeSessionId: id, messages: res.data })
    return get().sessions.find((s) => s.id === id) ?? null
  },

  createSession: async (subjectId, title, activityId) => {
    const res = await window.api.chat.createSession({ subject_id: subjectId, activity_id: activityId, title })
    if (!res.ok) return null
    set((st) => ({ sessions: [res.data, ...st.sessions], activeSessionId: res.data.id, messages: [] }))
    return res.data
  },

  removeSession: async (id) => {
    await window.api.chat.removeSession(id)
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id)
      const active = st.activeSessionId === id ? null : st.activeSessionId
      return { sessions, activeSessionId: active, messages: active === null ? [] : st.messages }
    })
    void get().loadSessions()
  },

  sendMessage: async (content, opts) => {
    let sessionId = get().activeSessionId
    if (!sessionId) {
      throw new Error('没有活动会话')
    }
    // 乐观插入用户消息（真实记录以 DB 为准，刷新后从 DB 读）
    const optimistic: ChatMessage = {
      id: `tmp-u-${Date.now()}`,
      session_id: sessionId,
      role: 'user',
      content,
      context_json: null,
      created_at: Date.now()
    }
    set((st) => ({ messages: [...st.messages, optimistic] }))
    const res = await window.api.chat.send({
      session_id: sessionId,
      content,
      context_refs: opts?.contextRefs ?? undefined,
      model_db_id: opts?.modelDbId ?? null
    })
    if (!res.ok) throw new Error(res.error)
  },

  abort: async (messageId) => {
    await window.api.chat.abort(messageId)
  },

  appendChunk: (sessionId, messageId, delta) => {
    const st = get()
    set({
      messages: st.activeSessionId === sessionId ? upsertAssistant(st.messages, sessionId, messageId, delta, true) : st.messages,
      streamingIds: new Set([...st.streamingIds, messageId]),
      streamSessions: { ...st.streamSessions, [messageId]: sessionId }
    })
  },

  finishMessage: (sessionId, messageId, content, modelDisplay) => {
    const st = get()
    const streaming = new Set(st.streamingIds)
    streaming.delete(messageId)
    const streamSessions = { ...st.streamSessions }
    delete streamSessions[messageId]
    const modelLabels = { ...st.modelLabels, [messageId]: modelDisplay }
    // 内容以 DB 为准（中断时保留已生成部分）
    set({
      messages: st.activeSessionId === sessionId ? upsertAssistant(st.messages, sessionId, messageId, content) : st.messages,
      streamingIds: streaming,
      streamSessions,
      modelLabels
    })
  },

  failMessage: (sessionId, messageId, error) => {
    const st = get()
    const streaming = new Set(st.streamingIds)
    streaming.delete(messageId)
    const streamSessions = { ...st.streamSessions }
    delete streamSessions[messageId]
    set({ streamingIds: streaming, streamSessions })
    if (st.activeSessionId !== sessionId) return
    if (messageId === '' || !st.messages.some((m) => m.id === messageId)) {
      // 发送前就失败：把错误挂到最后一条消息后
      set({ streamingIds: streaming })
      throw new Error(error)
    }
    set({
      messages: upsertAssistant(st.messages, sessionId, messageId, `${st.messages.find((m) => m.id === messageId)?.content ?? ''}\n\n[生成失败] ${error}`),
      streamingIds: streaming
    })
  }
}))
