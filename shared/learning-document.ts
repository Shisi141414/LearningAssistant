import type { LearningChange, LearningEntry, LearningEntryType, LearningSource, LearningSourceRef, LearningState } from './types'

export const learningTypes: Record<LearningEntryType, string> = { section: '章节', narrative: '叙述', definition: '定义', theorem: '定理', proposition: '命题', lemma: '引理', corollary: '推论', proof: '证明', example: '例题', exercise: '习题', solution: '解答', figure: '配图说明', table: '表格文字', equation: '公式文字', note: '注意' }
const statements: LearningEntryType[] = ['theorem', 'proposition', 'lemma', 'corollary']
export function relationAllowed(from: LearningEntryType, to: LearningEntryType): boolean {
  return from === 'proof' ? statements.includes(to) : from === 'solution' && ['example', 'exercise'].includes(to)
}
function bounds(ref: LearningSourceRef, sources: Map<string, LearningSource>): [number, number] {
  const source = sources.get(ref.source_id)
  if (!source) throw new Error('条目引用的来源不存在')
  return ref.text_range ?? [0, source.raw_text.length]
}
export function entryText(entry: LearningEntry, sources: Map<string, LearningSource>): string {
  return entry.sources.map(ref => { const [start, end] = bounds(ref, sources); return sources.get(ref.source_id)!.raw_text.slice(start, end) }).join('\n')
}
const safeBoundary = (text: string, index: number): boolean => !(index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]))
/** 本批和后续 AI 候选共用的来源覆盖约束：所有正文恰好出现一次。 */
export function validateLearningState(state: LearningState, sourceList: LearningSource[]): void {
  if (!state.entries.length || state.entries.length > 5000) throw new Error('学习文档条目数须在 1–5000 之间')
  const sources = new Map(sourceList.map(s => [s.id, s])), ids = new Set<string>()
  const coverage = new Map<string, [number, number][]>()
  let lastOrdinal = -1, lastEnd = -1
  for (const entry of state.entries) {
    if (!entry.id || ids.has(entry.id) || !Object.hasOwn(learningTypes, entry.type) || entry.title.length > 500 || entry.title.includes('\0') || !entry.sources.length) throw new Error('条目 ID、类型、标题或来源不合法')
    ids.add(entry.id)
    if (!['extracted', 'manual', 'ai'].includes(entry.analysis.method) || !['unreviewed', 'confirmed'].includes(entry.analysis.review_status) || entry.analysis.method === 'ai' && !entry.analysis.model.trim()) throw new Error('条目整理来源或模型标识缺失')
    for (const ref of entry.sources) {
      const source = sources.get(ref.source_id)
      if (!source) throw new Error('条目引用的来源不存在')
      const [start, end] = bounds(ref, sources)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > source.raw_text.length || (end <= start && (source.raw_text.length > 0 || ref.text_range)) || !safeBoundary(source.raw_text, start) || !safeBoundary(source.raw_text, end)) throw new Error('来源范围越界或切断字符')
      if (source.ordinal < lastOrdinal || source.ordinal === lastOrdinal && start < lastEnd) throw new Error('来源顺序错误或重复覆盖')
      lastOrdinal = source.ordinal; lastEnd = end
      const ranges = coverage.get(source.id) ?? []; ranges.push([start, end]); coverage.set(source.id, ranges)
    }
  }
  for (const source of sourceList) {
    const ranges = coverage.get(source.id)
    if (!ranges?.length) throw new Error('来源文字存在遗漏')
    let end = 0
    for (const range of ranges) { if (range[0] !== end) throw new Error('来源文字有遗漏或重复覆盖'); end = range[1] }
    if (end !== source.raw_text.length || source.raw_text.length === 0 && ranges.length !== 1) throw new Error('来源文字有遗漏或重复覆盖')
  }
  const byId = new Map(state.entries.map(e => [e.id, e])), related = new Set<string>()
  for (const relation of state.relations) {
    const from = byId.get(relation.from), to = byId.get(relation.to)
    if (!from || !to || from.id === to.id || related.has(from.id) || !relationAllowed(from.type, to.type) || !['unreviewed', 'confirmed'].includes(relation.review_status) || relation.type !== (from.type === 'proof' ? 'proves' : 'solves')) throw new Error('证明/解答的关联目标或方向无效')
    related.add(from.id)
  }
}
export function initialLearningState(sources: LearningSource[], newId: () => string): LearningState {
  return { entries: sources.map(source => ({ id: newId(), type: 'narrative', title: '', sources: [{ source_id: source.id }], analysis: { method: 'extracted', review_status: 'unreviewed' } })), relations: [] }
}
export function changeLearningState(previous: LearningState, sourceList: LearningSource[], change: LearningChange, newId: () => string): LearningState {
  const state = structuredClone(previous), index = state.entries.findIndex(e => e.id === change.entry_id)
  if (index < 0) throw new Error('条目不存在于当前修订')
  const entry = state.entries[index], sources = new Map(sourceList.map(s => [s.id, s]))
  if (change.action === 'edit') {
    entry.type = change.type; entry.title = change.title.trim()
    entry.analysis = { method: 'manual', review_status: 'confirmed' }
  } else if (change.action === 'split') {
    const text = entryText(entry, sources), position = change.position
    if (!Number.isSafeInteger(position) || position <= 0 || position >= text.length || !safeBoundary(text, position)) throw new Error('请把光标放在正文内部的完整字符之间')
    const left: LearningSourceRef[] = [], right: LearningSourceRef[] = []
    let cursor = 0
    for (const ref of entry.sources) {
      const [start, end] = bounds(ref, sources), next = cursor + end - start
      if (position >= next) left.push(ref)
      else if (position <= cursor) right.push(ref)
      else {
        const cut = start + position - cursor
        left.push({ source_id: ref.source_id, text_range: [start, cut] })
        right.push({ source_id: ref.source_id, text_range: [cut, end] })
      }
      cursor = next + 1
    }
    if (!left.length || !right.length) throw new Error('拆分后两侧都需要有来源文字')
    entry.sources = left
    entry.analysis = { method: 'manual', review_status: 'confirmed' }
    state.entries.splice(index + 1, 0, { id: newId(), type: 'narrative', title: '', sources: right, analysis: { method: 'extracted', review_status: 'unreviewed' } })
  } else if (change.action === 'merge') {
    if (!index) throw new Error('第一条前面没有可合并的条目')
    const before = state.entries[index - 1]
    if (state.relations.some(r => [r.from, r.to].includes(entry.id) || [r.from, r.to].includes(before.id))) throw new Error('请先解除这两条涉及的证明/解答关联，再合并')
    for (const ref of entry.sources) {
      const last = before.sources.at(-1)!, [start, end] = bounds(ref, sources), [lastStart, lastEnd] = bounds(last, sources)
      if (last.source_id === ref.source_id && lastEnd === start && end > start) last.text_range = [lastStart, end]
      else before.sources.push(ref)
    }
    before.analysis = { method: 'manual', review_status: 'confirmed' }
    state.entries.splice(index, 1)
  } else {
    state.relations = state.relations.filter(r => r.from !== entry.id)
    if (change.target_id) state.relations.push({ from: entry.id, to: change.target_id, type: entry.type === 'proof' ? 'proves' : 'solves', review_status: 'confirmed' })
  }
  validateLearningState(state, sourceList)
  return state
}
