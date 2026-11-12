import katex from 'katex'
import type { LearningContentNode, LearningFormula } from './types'

const fields = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const boundary = (text: string, index: number): boolean => !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]))
/** 范围只替换阅读表达，原文与来源覆盖不变。存储顺序就是正文顺序。 */
export function validateLearningFormulas(value: unknown, text: string): asserts value is LearningFormula[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 20) throw new Error('每条最多保存 20 个公式校正')
  let previousEnd = 0
  for (const formula of value) {
    if (!fields(formula, ['range', 'latex', 'display']) || !Array.isArray(formula.range) || formula.range.length !== 2 || !formula.range.every(Number.isSafeInteger) || typeof formula.latex !== 'string' || !formula.latex.trim() || formula.latex.length > 2000 || formula.latex.includes('\0') || typeof formula.display !== 'boolean') throw new Error('公式字段或长度无效，每式最多 2000 字符')
    const [start, end] = formula.range as number[]
    if (start < previousEnd || start < 0 || end <= start || end > text.length || !boundary(text, start) || !boundary(text, end) || !text.slice(start, end).trim()) throw new Error('公式范围须在原文内、非空且不重叠，不能切断字符')
    previousEnd = end
  }
}
export function formulaPreview(latex: string, display: boolean): { html: string; error: string } {
  if (!latex.trim() || latex.length > 2000 || latex.includes('\0')) return { html: '', error: '请输入不超过 2000 字符的公式' }
  try { return { html: katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' }), error: '' } }
  catch (error) { return { html: '', error: error instanceof Error ? error.message.slice(0, 350) : '公式无法排版，请检查 LaTeX' } }
}
export function learningContent(text: string, formulas?: LearningFormula[]): LearningContentNode[] {
  validateLearningFormulas(formulas, text)
  const nodes: LearningContentNode[] = []
  let cursor = 0
  for (const formula of formulas ?? []) {
    if (formula.range[0] > cursor) nodes.push({ type: 'text', text: text.slice(cursor, formula.range[0]) })
    nodes.push({ type: 'math', formula, source_text: text.slice(...formula.range) })
    cursor = formula.range[1]
  }
  if (cursor < text.length || !nodes.length) nodes.push({ type: 'text', text: text.slice(cursor) })
  return nodes
}
