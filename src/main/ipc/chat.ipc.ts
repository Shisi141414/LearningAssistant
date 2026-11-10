/**
 * ipc/chat.ipc.ts —— 智能体对话：上下文组装（ADR-2）+ 流式转发 + 中断
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type { ChatSession, ChatMessage, ChatSendInput, ContextRef, ID, LlmMessage } from '@shared/types'
import { getDb } from '../services/db'
import { streamChat } from '../services/llm'
import { getProviderWithKey } from './providers.ipc'
import { handleResult } from './helpers'
import { nanoid } from 'nanoid'

interface SessionRow {
  id: string
  subject_id: string | null
  title: string
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  context_json: string | null
  created_at: number
}

const rowToSession = (r: SessionRow): ChatSession => ({ ...r })
const rowToMessage = (r: MessageRow): ChatMessage => ({ ...r })

/** 进行中的流：messageId -> AbortController */
const activeStreams = new Map<ID, AbortController>()

/** 历史消息条数上限（控制上下文长度；M2 换成基于 token 的裁剪） */
const HISTORY_LIMIT = 20

export function registerChatIpc(): void {
  /* ---------- 会话 ---------- */

  ipcMain.handle(IPC.ChatListSessions, () =>
    handleResult(() => {
      const rows = getDb().prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as SessionRow[]
      return rows.map(rowToSession)
    })
  )

  ipcMain.handle(IPC.ChatCreateSession, (_e, input: { subject_id?: ID | null; title?: string }) =>
    handleResult(() => {
      const db = getDb()
      const now = Date.now()
      const s: ChatSession = {
        id: nanoid(),
        subject_id: input.subject_id ?? null,
        title: input.title ?? '新会话',
        created_at: now,
        updated_at: now
      }
      db.prepare('INSERT INTO chat_sessions (id, subject_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        s.id, s.subject_id, s.title, s.created_at, s.updated_at
      )
      return s
    })
  )

  ipcMain.handle(IPC.ChatRemoveSession, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
      return true
    })
  )

  ipcMain.handle(IPC.ChatGetMessages, (_e, sessionId: ID) =>
    handleResult(() => {
      const rows = getDb().prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at').all(sessionId) as MessageRow[]
      return rows.map(rowToMessage)
    })
  )

  /* ---------- 发送（流式） ---------- */

  ipcMain.handle(IPC.ChatSend, async (event: IpcMainInvokeEvent, input: ChatSendInput) => {
    try {
      await runChat(event.sender, input)
      return { ok: true as const, data: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      event.sender.send(IPC_EVENTS.LlmError, { session_id: input.session_id, message_id: '', error: msg })
      return { ok: false as const, error: msg }
    }
  })

  ipcMain.handle(IPC.ChatAbort, (_e, messageId: ID) => {
    activeStreams.get(messageId)?.abort()
    return { ok: true as const, data: true }
  })
}

async function runChat(sender: WebContents, input: ChatSendInput): Promise<void> {
  const db = getDb()

  // 1. 会话校验与学科信息
  const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(input.session_id) as SessionRow | undefined
  if (!session) throw new Error('会话不存在')
  let subjectName = ''
  if (session.subject_id) {
    const subj = db.prepare('SELECT name FROM subjects WHERE id = ?').get(session.subject_id) as { name: string } | undefined
    subjectName = subj?.name ?? ''
  }

  // 2. 存用户消息
  const now = Date.now()
  const userMsg: ChatMessage = {
    id: nanoid(),
    session_id: session.id,
    role: 'user',
    content: input.content,
    context_json: input.context_refs ? JSON.stringify(input.context_refs) : null,
    created_at: now
  }
  db.prepare('INSERT INTO chat_messages (id, session_id, role, content, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userMsg.id, userMsg.session_id, userMsg.role, userMsg.content, userMsg.context_json, userMsg.created_at
  )

  // 3. 组装上下文（ADR-2：渲染进程只传 id，主进程查库拼全文）
  const contextText = buildContextText(input.context_refs ?? [])

  // 4. 选模型
  const model = pickModel(input.model_db_id ?? null)
  const { provider, apiKey } = getProviderWithKey(model.provider_id)
  if (!apiKey) throw new Error(`供应商「${provider.name}」未配置 API Key，请到设置页配置`)

  // 5. 组装消息序列
  const history = (db.prepare(
    'SELECT * FROM chat_messages WHERE session_id = ? AND role != ? ORDER BY created_at DESC LIMIT ?'
  ).all(session.id, 'system', HISTORY_LIMIT) as MessageRow[]).reverse()

  const messages: LlmMessage[] = []
  messages.push({
    role: 'system',
    content: [
      '你是"学习助手"应用里的智能体，服务对象是清华大学本科生。',
      subjectName ? `当前会话学科：《${subjectName}》。` : '',
      '回答使用简体中文；条理清晰，优先用 Markdown 结构化；数学公式用 LaTeX（行内 $...$，独立 $$...$$）。',
      '学生提问若涉及具体课程内容，优先基于提供的上下文材料作答，再补充一般性知识。',
      contextText ? `\n以下是本次提问挂载的上下文材料（笔记/资料摘录）：\n${contextText}` : ''
    ].filter(Boolean).join('\n')
  })
  for (const h of history) {
    messages.push({ role: h.role as LlmMessage['role'], content: h.content })
  }

  // 6. 建助手占位消息（前端据此渲染"生成中"气泡）
  const assistantMsg: ChatMessage = {
    id: nanoid(),
    session_id: session.id,
    role: 'assistant',
    content: '',
    context_json: null,
    created_at: Date.now()
  }
  db.prepare('INSERT INTO chat_messages (id, session_id, role, content, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    assistantMsg.id, assistantMsg.session_id, assistantMsg.role, assistantMsg.content, assistantMsg.context_json, assistantMsg.created_at
  )
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), session.id)

  // 7. 流式调用与转发
  const ac = new AbortController()
  activeStreams.set(assistantMsg.id, ac)
  let full = ''
  try {
    full = await streamChat(
      { base_url: provider.base_url, api_format: provider.api_format, apiKey },
      model.model_id,
      messages,
      ac.signal,
      {
        onChunk: (delta) => {
          // full 由 streamChat 返回值统一负责，这里只负责实时转发
          sender.send(IPC_EVENTS.LlmChunk, { session_id: session.id, message_id: assistantMsg.id, delta })
        }
      }
    )
  } catch (e) {
    // 中断不算错误：保留已生成内容
    const aborted = ac.signal.aborted
    if (!aborted) {
      const msg = e instanceof Error ? e.message : String(e)
      db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(`[生成失败] ${msg}`, assistantMsg.id)
      sender.send(IPC_EVENTS.LlmError, { session_id: session.id, message_id: assistantMsg.id, error: msg })
      return
    }
  } finally {
    activeStreams.delete(assistantMsg.id)
  }

  // 8. 落库并通知完成
  db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(full, assistantMsg.id)
  sender.send(IPC_EVENTS.LlmDone, {
    session_id: session.id,
    message_id: assistantMsg.id,
    content: full,
    model_display: `${provider.name} / ${model.display_name}`
  })
}

/** 把上下文引用展开为文本块（M0 支持 note_segment / note 两种引用） */
function buildContextText(refs: ContextRef[]): string {
  if (refs.length === 0) return ''
  const db = getDb()
  const parts: string[] = []
  for (const ref of refs) {
    if (ref.type === 'note_segment') {
      const seg = db.prepare(
        'SELECT s.organized_text, s.raw_text, s.seg_type, n.title FROM note_segments s JOIN notes n ON s.note_id = n.id WHERE s.id = ?'
      ).get(ref.id) as { organized_text: string; raw_text: string; seg_type: string; title: string } | undefined
      if (seg) parts.push(`【来自笔记《${seg.title}》（${seg.seg_type}）】\n${seg.organized_text || seg.raw_text}`)
    } else if (ref.type === 'note') {
      const note = db.prepare('SELECT title FROM notes WHERE id = ?').get(ref.id) as { title: string } | undefined
      if (note) {
        const segs = db.prepare('SELECT organized_text, raw_text FROM note_segments WHERE note_id = ? ORDER BY sort_order').all(ref.id) as Array<{ organized_text: string; raw_text: string }>
        const text = segs.map((s) => s.organized_text || s.raw_text).filter(Boolean).join('\n\n')
        if (text) parts.push(`【来自笔记《${note.title}》全文】\n${text}`)
      }
    }
  }
  return parts.join('\n\n---\n\n')
}

/** 模型选择：指定 id > 第一个启用供应商下的第一个模型 */
function pickModel(modelDbId: ID | null): { provider_id: string; model_id: string; display_name: string } {
  const db = getDb()
  if (modelDbId) {
    const m = db.prepare(
      'SELECT m.*, p.enabled FROM models m JOIN providers p ON m.provider_id = p.id WHERE m.id = ?'
    ).get(modelDbId) as { provider_id: string; model_id: string; display_name: string; enabled: number } | undefined
    if (m && m.enabled === 1) return m
    throw new Error('所选模型不可用（供应商被停用或模型已删除）')
  }
  const m = db.prepare(
    'SELECT m.provider_id, m.model_id, m.display_name FROM models m JOIN providers p ON m.provider_id = p.id WHERE p.enabled = 1 ORDER BY p.created_at, m.created_at LIMIT 1'
  ).get() as { provider_id: string; model_id: string; display_name: string } | undefined
  if (!m) throw new Error('还没有可用模型：请先到「设置 → 模型服务」添加供应商并导入模型')
  return m
}
