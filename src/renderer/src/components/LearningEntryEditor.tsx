import { useState, type ReactNode } from 'react'
import type { LearningEntry, LearningEntryType, LearningOperation, LearningState } from '@shared/types'
import { availableLearningParents, learningAncestors, learningTypes, relationAllowed } from '@shared/learning-document'
import { LearningFormulaEditor } from './LearningFormulaContent'

export function LearningEntryEditor({ entry, text, state, first, busy, onOperation, figures }: { entry: LearningEntry; text: string; state: LearningState; first: boolean; busy: boolean; onOperation: (operation: LearningOperation) => Promise<void>; figures?: ReactNode }) {
  const [type, setType] = useState(entry.type), [title, setTitle] = useState(entry.title)
  const [position, setPosition] = useState<number | null>(null)
  const [selection, setSelection] = useState<[number, number] | null>(null)
  const [target, setTarget] = useState(state.relations.find(r => r.from === entry.id)?.to ?? '')
  const [parent, setParent] = useState(entry.parent_id ?? ''), [endId, setEndId] = useState(entry.id)
  const index = state.entries.findIndex(item => item.id === entry.id)
  const parents = availableLearningParents(state.entries, index)
  const targets = state.entries.filter(e => e.id !== entry.id && relationAllowed(entry.type, e.type))
  const readPosition = (input: HTMLTextAreaElement): void => { setPosition(input.selectionStart === input.selectionEnd ? input.selectionStart : null); setSelection(input.selectionStart < input.selectionEnd ? [input.selectionStart, input.selectionEnd] : null) }
  return <div className="learning-editor">
    <div className="toolbar"><label>类型 <select aria-label="条目语义类型" value={type} disabled={busy} onChange={e => setType(e.target.value as LearningEntryType)}>{Object.entries(learningTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <input aria-label="学习条目标题" maxLength={500} placeholder="条目标题（可留空）" value={title} disabled={busy} onChange={e => setTitle(e.target.value)} />
      <button className="primary" disabled={busy} onClick={() => void onOperation({ action: 'edit', type, title })}>保存类型与标题</button></div>
    <label>在来源文字中放置光标，确定拆分点<textarea aria-label="选择学习条目拆分位置" readOnly value={text} onSelect={e => readPosition(e.currentTarget)} onMouseUp={e => readPosition(e.currentTarget)} onKeyUp={e => readPosition(e.currentTarget)} /></label>
    <div className="toolbar"><button disabled={busy || position === null || position <= 0 || position >= text.length} onClick={() => void onOperation({ action: 'split', position: position! })}>在光标处拆分</button><button disabled={busy || first} onClick={() => void onOperation({ action: 'merge' })}>合并到上一条</button></div>
    <p className="muted">合并保留前一条的类型和标题；涉及证明/解答关联时，请先解除关联。每次保存生成新修订，来源正文保持不变。</p>
    <LearningFormulaEditor text={text} formulas={entry.formulas} selection={selection} busy={busy} onOperation={onOperation} />
    {figures}
    <div className="learning-outline-editor"><h4>章节归属</h4><p className="muted">从本条起选择连续范围。已有子章节保留，所选章节须包含完整子树；本操作不改变正文或语义确认状态。</p>
      <label>父章节<select aria-label="学习条目父章节" value={parent} disabled={busy} onChange={event => setParent(event.target.value)}><option value="">顶层 / 未分章</option>{parents.map(section => <option key={section.id} value={section.id}>{'　'.repeat(learningAncestors(section.id, state.entries).length)}{section.title || `章节 · 第 ${state.entries.indexOf(section) + 1} 条`}</option>)}</select></label>
      <label>范围结束于<select aria-label="章节归属结束条目" value={endId} disabled={busy} onChange={event => setEndId(event.target.value)}>{state.entries.slice(index).map((item, offset) => <option key={item.id} value={item.id}>第 {index + offset + 1} 条 · {item.title || learningTypes[item.type]}</option>)}</select></label>
      <button disabled={busy} onClick={() => void onOperation({ action: 'outline', parent_id: parent || null, end_entry_id: endId })}>保存章节归属</button></div>
    {['proof', 'solution'].includes(entry.type) && <div className="toolbar"><label>{entry.type === 'proof' ? '证明对象' : '解答对象'} <select aria-label="学习条目关联目标" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="">未指定 / 解除关联</option>{targets.map(e => <option key={e.id} value={e.id}>{learningTypes[e.type]} · {e.title || `第 ${state.entries.indexOf(e) + 1} 条`}</option>)}</select></label><button disabled={busy} onClick={() => void onOperation({ action: 'relate', target_id: target || null })}>保存关联</button></div>}
  </div>
}
