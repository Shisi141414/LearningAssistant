/** Storage stays plain text plus $/$$ math; the rich editor is only an editing view. */
export interface MathEditorNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  content?: MathEditorNode[]
}
export interface MathToken {
  type: 'text' | 'formula'
  text: string
  latex?: string
  display?: boolean
}
export function mathTokens(text: string): MathToken[] {
  const tokens: MathToken[] = []
  // Protect code and escaped dollars. Delimiters without a closing partner remain editable text.
  const regex =
    /```math\r?\n?([\s\S]*?)```|```[\s\S]*?```|`[^`\n]+`|\\\$|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
  let last = 0,
    match: RegExpExecArray | null
  while ((match = regex.exec(text))) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    const latex = match[1] ?? match[2] ?? match[3]
    tokens.push(
      latex?.trim() && latex.length <= 4000
        ? {
            type: 'formula',
            text: match[0],
            latex,
            display: match[1] !== undefined || match[2] !== undefined
          }
        : { type: 'text', text: match[0] }
    )
    last = regex.lastIndex
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
  return tokens
}
export function mathEditorDocument(text: string): MathEditorNode {
  const paragraphs: MathEditorNode[] = [{ type: 'paragraph', content: [] }]
  for (const token of mathTokens(text)) {
    if (token.type === 'formula') {
      paragraphs.at(-1)!.content!.push({
        type: 'visualMath',
        attrs: { latex: token.latex, display: token.display, source: token.text }
      })
    } else {
      token.text.split('\n').forEach((line, index) => {
        if (index) paragraphs.push({ type: 'paragraph', content: [] })
        if (line) paragraphs.at(-1)!.content!.push({ type: 'text', text: line })
      })
    }
  }
  return { type: 'doc', content: paragraphs }
}
export function mathEditorText(node: MathEditorNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'visualMath') {
    if (typeof node.attrs?.source === 'string') return node.attrs.source
    const delimiter = node.attrs?.display ? '$$' : '$'
    return (
      delimiter +
      String(node.attrs?.latex ?? '').replace(/\\placeholder(?:\[[^\]]*\])?\{[^{}]*\}/g, '') +
      delimiter
    )
  }
  const separator =
    node.type === 'doc' && node.content?.some((child) => child.type === 'paragraph') ? '\n' : ''
  return (node.content ?? []).map(mathEditorText).join(separator)
}
