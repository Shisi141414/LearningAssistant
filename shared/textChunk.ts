/**
 * shared/textChunk.ts —— 文档切块器（知识库 M3 的核心前置能力，自检面板可单测）
 *
 * 策略（面向教材/讲义 Markdown）：
 *  1. 按标题层级切节（# ~ ####），每块记录所属标题链，便于索引与溯源
 *  2. 节内按空行分段；段超过 maxChars 再按句号细切
 *  3. 细切时保留 overlap 字符上下文（降低检索时语义割裂）
 */
export interface TextChunk {
  /** 纯文本内容 */
  text: string
  /** 所属标题链，如 "第二章 极限 > §2.1 数列的极限" */
  heading: string
}

export interface ChunkOptions {
  /** 单块目标长度（字符），默认 500 */
  maxChars?: number
  /** 句子细切时的重叠字符数，默认 50 */
  overlap?: number
}

export function chunkText(md: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChars = opts.maxChars ?? 500
  const overlap = opts.overlap ?? Math.min(50, maxChars - 1)
  if (!Number.isInteger(maxChars) || maxChars < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= maxChars) throw new Error('切块长度必须为正整数，重叠必须在 0 到长度减 1 之间')
  const chunks: TextChunk[] = []
  const headingStack: string[] = []

  const pushChunk = (text: string): void => {
    const t = text.trim()
    if (t) chunks.push({ text: t, heading: headingStack.join(' > ') })
  }

  /** 长文本按句子边界细切（中文句号/问号/感叹号/换行） */
  const splitLong = (text: string): string[] => {
    if (text.length <= maxChars) return [text]
    const out: string[] = []
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length)
      if (end < text.length) {
        const window = text.slice(start, end)
        const matches = [...window.matchAll(/[。！？!?；;\n]/g)]
        const boundary = matches.at(-1)
        if (boundary && boundary.index + 1 > Math.max(overlap, maxChars / 2)) end = start + boundary.index + 1
      }
      out.push(text.slice(start, end))
      if (end === text.length) break
      start = end - overlap
    }
    return out
  }

  const lines = md.split('\n')
  let buffer: string[] = []

  const flush = (): void => {
    const paras = buffer.join('\n').split(/\n\s*\n/)
    for (const p of paras) {
      for (const piece of splitLong(p.trim())) pushChunk(piece)
    }
    buffer = []
  }

  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const level = h[1].length
      headingStack.length = level - 1 // 弹出到父级
      headingStack[level - 1] = h[2].trim()
      // 标题本身也作为块（短，便于精确命中）
      pushChunk(`## ${h[2].trim()}`)
    } else {
      buffer.push(line)
    }
  }
  flush()
  return chunks
}
