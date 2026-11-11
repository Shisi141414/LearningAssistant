/**
 * components/MarkdownSegment.tsx —— 含 LaTeX 公式的文本渲染（KaTeX）
 *
 * 解析顺序：```math 代码块 / $$...$$ 独立公式（块级扫描）→ $...$ 行内公式、
 * **加粗**、`code`（行内扫描）。
 * 设计取舍（M0）：不引入完整 markdown 渲染器（AI 整理输出以文本+公式为主，
 * 完整渲染 M2 随知识库再评估）；KaTeX throwOnError:false + try/catch 双保险，
 * 坏公式显示原文不崩页面。
 */
import { Fragment, type ReactNode, useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { ConceptText } from './ConceptText'

interface Block {
  type: 'text' | 'math'
  value: string
}

/** 块级扫描：```math 与 $$...$$（跨行） */
function parseBlocks(text: string): Block[] {
  const out: Block[] = []
  const re = /```math\n?([\s\S]*?)```|\$\$([\s\S]+?)\$\$/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) })
    const formula = m[1] !== undefined ? m[1] : m[2]
    out.push({ type: 'math', value: formula.trim() })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

function renderKatex(latex: string, displayMode: boolean, key: string): ReactNode {
  try {
    const html = katex.renderToString(latex, { displayMode, throwOnError: false, strict: 'ignore' })
    return (
      <span
        key={key}
        style={displayMode ? { display: 'block', overflowX: 'auto', margin: '6px 0', textAlign: 'center' } : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  } catch {
    // 极端坏输入（throwOnError:false 已兜大多数）：原文显示
    return (
      <span key={key} style={{ color: '#b45309' }}>
        {displayMode ? `$$${latex}$$` : `$${latex}$`}
      </span>
    )
  }
}

/** 行内解析：`code` 保护 → $...$ 公式 → **加粗** */
function renderInline(text: string, keyPrefix: string, subjectId?: string | null): ReactNode[] {
  const out: ReactNode[] = []
  text.split(/(`[^`\n]+`)/g).forEach((part, ci) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code key={`${keyPrefix}c${ci}`} style={{ background: '#f1f2f4', borderRadius: 4, padding: '0 4px', fontFamily: 'Consolas, monospace', fontSize: 12.5 }}>
          {part.slice(1, -1)}
        </code>
      )
      return
    }
    part.split(/(\$[^$\n]+\$)/g).forEach((seg, si) => {
      const fm = /^\$(.+)\$$/.exec(seg)
      if (fm && fm[1].trim() && fm[1].length < 500) {
        out.push(renderKatex(fm[1], false, `${keyPrefix}c${ci}i${si}`))
        return
      }
      seg.split(/(\*\*[^*\n]+\*\*)/g).forEach((b, bi) => {
        const bm = /^\*\*(.+)\*\*$/.exec(b)
        if (bm) out.push(<strong key={`${keyPrefix}c${ci}i${si}b${bi}`}><ConceptText text={bm[1]} subjectId={subjectId} /></strong>)
        else if (b) out.push(<ConceptText key={`${keyPrefix}c${ci}i${si}b${bi}`} text={b} subjectId={subjectId} />)
      })
    })
  })
  return out
}

export function MarkdownSegment({ text, subjectId }: { text: string; subjectId?: string | null }): ReactNode {
  const nodes = useMemo(() => {
    const out: ReactNode[] = []
    parseBlocks(text).forEach((block, i) => {
      if (block.type === 'math') {
        out.push(renderKatex(block.value, true, `m${i}`))
      } else {
        out.push(
          <Fragment key={`t${i}`}>{renderInline(block.value, `t${i}`, subjectId)}</Fragment>
        )
      }
    })
    return out
  }, [text, subjectId])

  return <div className="md-seg">{nodes}</div>
}
