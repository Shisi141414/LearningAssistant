/**
 * services/llm.ts —— LLM 统一代理（主进程侧）
 *
 * 职责（docs/02-architecture.md §2/ADR-4）：
 *  - 屏蔽上游差异：openai 格式（DeepSeek/Qwen/GLM/Kimi/OpenAI…）与 anthropic 格式（Claude 系）
 *  - 密钥只在本模块内存中出现，渲染进程经 IPC 调用
 *  - 流式：chunk 经 IPC_EVENTS 推回渲染进程
 *  - 上下文组装（ADR-2）：由 ipc/chat.ipc.ts 查库拼装，本模块只管"发出去"
 *
 * M0 范围：非流式（连通性测试/模型导入）+ 流式（对话）。
 */
import type { ApiFormat, LlmMessage } from '@shared/types'

export interface LlmEndpoint {
  base_url: string
  api_format: ApiFormat
  apiKey: string
}

export interface StreamCallbacks {
  onChunk: (delta: string) => void
}

/* ---------------- 连通性测试（发一个极小请求） ---------------- */

export async function testProvider(endpoint: LlmEndpoint): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now()
  try {
    // 用"列模型"做测试：不消耗 token，能验证 baseURL+Key 是否有效
    await listRemoteModels(endpoint)
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e instanceof Error ? e.message : e) }
  }
}

/* ---------------- 模型导入 ---------------- */

/** GET {base}/models —— openai 格式与 anthropic 格式该端点结构相近 */
export async function listRemoteModels(endpoint: LlmEndpoint): Promise<string[]> {
  const url = joinUrl(endpoint.base_url, '/models')
  const res = await fetch(url, {
    headers: authHeaders(endpoint),
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeText(res)}`)
  const json = (await res.json()) as { data?: unknown[]; models?: unknown[] }
  const arr = (json.data ?? json.models ?? []) as Array<{ id?: string; name?: string }>
  const ids = arr.map((m) => m.id ?? m.name ?? '').filter(Boolean)
  if (ids.length === 0) throw new Error('响应中没有模型列表')
  return ids
}

/* ---------------- 流式对话 ---------------- */

export async function streamChat(
  endpoint: LlmEndpoint,
  model: string,
  messages: LlmMessage[],
  signal: AbortSignal,
  cb: StreamCallbacks
): Promise<string> {
  if (endpoint.api_format === 'anthropic') {
    return streamAnthropic(endpoint, model, messages, signal, cb)
  }
  return streamOpenaiCompatible(endpoint, model, messages, signal, cb)
}

/** openai 兼容格式：直接用官方 SDK（其对所有兼容端点工作良好） */
async function streamOpenaiCompatible(
  endpoint: LlmEndpoint,
  model: string,
  messages: LlmMessage[],
  signal: AbortSignal,
  cb: StreamCallbacks
): Promise<string> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({
    baseURL: endpoint.base_url,
    apiKey: endpoint.apiKey,
    // 中转站证书不一定规范，但默认校验保持打开（安全优先）；超时给足
    timeout: 120_000
  })
  const stream = await client.chat.completions.create(
    { model, messages, stream: true },
    { signal }
  )
  let full = ''
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content ?? ''
    if (delta) {
      full += delta
      cb.onChunk(delta)
    }
  }
  return full
}

/** anthropic 格式：手写 fetch+SSE（事件结构简单，免装 SDK；M0 该格式使用频率低） */
async function streamAnthropic(
  endpoint: LlmEndpoint,
  model: string,
  messages: LlmMessage[],
  signal: AbortSignal,
  cb: StreamCallbacks
): Promise<string> {
  // anthropic 要求 system 独立字段
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const url = joinUrl(endpoint.base_url, '/messages')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': endpoint.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, system: system || undefined, messages: rest, stream: true, max_tokens: 8192 }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeText(res)}`)
  if (!res.body) throw new Error('无响应体')

  let full = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (event: string): void => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return
    let obj: { type?: string; delta?: { text?: string }; error?: { message?: string } }
    try { obj = JSON.parse(data) } catch { return }
    if (obj.type === 'error') throw new Error(obj.error?.message ?? '上游错误')
    if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') {
      full += obj.delta.text
      cb.onChunk(obj.delta.text)
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
      }
      if (done) { if (buffer.trim()) consume(buffer); break }
      if (buffer.length > 1_000_000) throw new Error('模型流事件过大')
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return full
}

/** 非流式补全（AI 整理等后台任务用）：内部走流式拼接，屏蔽两种格式差异 */
export async function completeChat(
  endpoint: LlmEndpoint,
  model: string,
  messages: LlmMessage[]
): Promise<string> {
  return streamChat(endpoint, model, messages, new AbortController().signal, { onChunk: () => undefined })
}

/* ---------------- 识图（vision 多模态） ---------------- */

export interface VisionImage {
  /** 如 image/png */
  mime: string
  base64: string
}

/**
 * 识图测试/图片识别归位（M1b）用：一张图 + 一句指令。
 * openai 格式：content 数组 image_url(data: URL)；anthropic 格式：image block base64 source。
 */
export async function completeVision(
  endpoint: LlmEndpoint,
  model: string,
  prompt: string,
  image: VisionImage
): Promise<string> {
  const { default: OpenAI } = await import('openai')

  if (endpoint.api_format === 'anthropic') {
    const res = await fetch(joinUrl(endpoint.base_url, '/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': endpoint.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } },
              { type: 'text', text: prompt }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeText(res)}`)
    const json = (await res.json()) as { content?: Array<{ text?: string }> }
    return (json.content ?? []).map((c) => c.text ?? '').join('').trim()
  }

  // openai 兼容格式（DeepSeek-VL/Qwen-VL/GLM-4V/GPT-4o 等）
  const client = new OpenAI({ baseURL: endpoint.base_url, apiKey: endpoint.apiKey, timeout: 60_000 })
  const res = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }
        ]
      }
    ]
  })
  return (res.choices[0]?.message?.content ?? '').trim()
}

/* ---------------- 工具 ---------------- */

function authHeaders(endpoint: LlmEndpoint): Record<string, string> {
  if (endpoint.api_format === 'anthropic') {
    return { 'x-api-key': endpoint.apiKey, 'anthropic-version': '2023-06-01' }
  }
  return { authorization: `Bearer ${endpoint.apiKey}` }
}

/** 拼 URL：容忍用户填的 base 末尾有无 `/`，避免出现 `//models` */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return b + p
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return ''
  }
}
