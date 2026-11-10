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
  const overlap = Math.min(opts.overlap ?? 50, maxChars - 1)
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
    const sentences = text.split(/(?<=[。！？!?；;\n])/)
    let cur = ''
    for (const s of sentences) {
      // 单句超长（无标点的长公式/长行）：硬切
      if (s.length > maxChars) {
        for (let i = 0; i < s.length; i += maxChars - overlap) {
          out.push(s.slice(i, i + maxChars))
        }
        continue
      }
      if ((cur + s).length > maxChars && cur) {
        out.push(cur)
        cur = overlap > 0 ? cur.slice(-overlap) + s : s
      } else {
        cur += s
      }
    }
    if (cur.trim()) out.push(cur)
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
