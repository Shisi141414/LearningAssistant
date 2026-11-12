import { Fragment, useMemo, useState } from 'react'
import type { LearningChange, LearningFormula } from '@shared/types'
import { formulaPreview, learningContent } from '@shared/learning-formulas'
import { ConceptText } from './ConceptText'
import 'katex/dist/katex.min.css'

export function FormulaView({ latex, display }: { latex: string; display: boolean }) {
  const preview = useMemo(() => formulaPreview(latex, display), [latex, display])
  return preview.error ? <span className="learning-formula-error" title={preview.error}>{latex}</span> : <span className={`learning-formula${display ? ' learning-formula-display' : ''}`} dangerouslySetInnerHTML={{ __html: preview.html }} />
}
export function LearningFormulaContent({ text, formulas, subjectId }: { text: string; formulas: LearningFormula[]; subjectId: string | null }) {
  const nodes = useMemo(() => learningContent(text, formulas), [text, formulas])
  return <>{nodes.map((node, index) => <Fragment key={index}>{node.type === 'text' ? <ConceptText text={node.text} subjectId={subjectId} /> : <FormulaView latex={node.formula.latex} display={node.formula.display} />}</Fragment>)}</>
}
export function LearningFormulaEditor({ text, formulas = [], selection, busy, base, onChange }: { text: string; formulas?: LearningFormula[]; selection: [number, number] | null; busy: boolean; base: { version_id: string; expected_revision_id: string; entry_id: string }; onChange: (input: LearningChange) => Promise<void> }) {
  const [editing, setEditing] = useState<LearningFormula | null>(null)
  const [latex, setLatex] = useState(''), [display, setDisplay] = useState(false)
  const range = editing?.range ?? selection
  const preview = useMemo(() => formulaPreview(latex, display), [latex, display])
  return <section className="learning-formula-editor" aria-label="公式校正">
    <h4>公式校正</h4><p className="muted">在上方原文框选中公式对应的文字，再输入 LaTeX。保存只调整阅读排版；原文始终保留。</p>
    {formulas.map((formula, index) => <div className="learning-formula-record" key={formula.range.join(':')}><span>公式 {index + 1} · {formula.display ? '独立' : '行内'}</span><code>{formula.latex}</code><div className="toolbar"><button disabled={busy} onClick={() => { setEditing(formula); setLatex(formula.latex); setDisplay(formula.display) }}>编辑公式 {index + 1}</button><button disabled={busy} onClick={() => void onChange({ ...base, action: 'formula-remove', range: formula.range })}>移除公式 {index + 1}</button></div></div>)}
    {editing && <button disabled={busy} onClick={() => { setEditing(null); setLatex('') }}>改为添加新公式</button>}
    <div className="learning-formula-selection"><strong>{editing ? '编辑的原文范围' : '已选原文'}</strong><p>{range ? text.slice(...range) : '尚未选择。在上方原文框中选中需要校正的部分。'}</p></div>
    <label>LaTeX<textarea aria-label="公式 LaTeX" maxLength={2000} value={latex} disabled={busy} placeholder={'例如 F = m \\frac{\\mathrm{d}v}{\\mathrm{d}t}'} onChange={event => setLatex(event.target.value)} /></label>
    <label className="learning-formula-layout">显示方式<select aria-label="公式显示方式" value={display ? 'display' : 'inline'} disabled={busy} onChange={event => setDisplay(event.target.value === 'display')}><option value="inline">行内公式</option><option value="display">独立公式</option></select></label>
    {latex.trim() && <div className="learning-formula-preview" aria-label="公式预览">{preview.error ? <p role="status">公式暂不能排版，请检查 LaTeX。{preview.error}</p> : <FormulaView latex={latex} display={display} />}</div>}
    <button className="primary" disabled={busy || !range || !!preview.error} onClick={() => range && void onChange({ ...base, action: 'formula', formula: { range, latex: latex.trim(), display } })}>保存公式校正</button>
  </section>
}
