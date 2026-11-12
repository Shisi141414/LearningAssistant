import type { LearningEntry, LearningState, NoteLearningBlock, NoteLearningSyncSummary } from './types'
import { validateLearningState } from './learning-document'

/** 仅为正文完全相同的来源保留字符范围；变化范围完整重建，绝不猜测公式/拆分偏移。 */
export function reconcileNoteLearning(previous: LearningState, oldBlocks: NoteLearningBlock[], newBlocks: NoteLearningBlock[], newId: () => string): { state: LearningState; summary: NoteLearningSyncSummary } {
  const oldBySegment = new Map(oldBlocks.map(block => [block.origin.segment_id, block]))
  const newBySegment = new Map(newBlocks.map(block => [block.origin.segment_id, block]))
  const sources = newBlocks.map((block, ordinal) => ({ ...block.source, ordinal }))
  const ordinal = new Map(sources.map(source => [source.id, source.ordinal]))
  const mapped = new Map<string, string>(), affected = new Set<string>()
  for (const old of oldBlocks) {
    const next = newBySegment.get(old.origin.segment_id)
    if (next && old.source.raw_text === next.source.raw_text) mapped.set(old.source.id, next.source.id)
  }
  const oldSourcesToEntries = new Map<string, LearningEntry[]>()
  for (const entry of previous.entries) for (const ref of entry.sources) {
    const list = oldSourcesToEntries.get(ref.source_id) ?? []; list.push(entry); oldSourcesToEntries.set(ref.source_id, list)
  }
  for (const entry of previous.entries) {
    const positions = entry.sources.map(ref => ordinal.get(mapped.get(ref.source_id) ?? '') ?? -1)
    if (positions.includes(-1) || positions.some((position, index) => index > 0 && position < positions[index - 1])) { affected.add(entry.id); continue }
    const covered = new Set(entry.sources.map(ref => mapped.get(ref.source_id)!))
    const first = Math.min(...positions), last = Math.max(...positions)
    // 也检查已有来源重排后插入合并条目的情形，不能只检查新增来源。
    for (let index = first + 1; index < last; index++) if (!covered.has(sources[index].id)) { affected.add(entry.id); break }
  }
  // 拆分条目可能共享一个来源；合并条目可能跨多个来源。闭包保证完整覆盖，不产生重复/漏字。
  const byEntry = new Map(previous.entries.map(entry => [entry.id, entry])), queue = [...affected], affectedSources = new Set<string>()
  for (let at = 0; at < queue.length; at++) for (const ref of byEntry.get(queue[at])!.sources) {
    if (affectedSources.has(ref.source_id)) continue
    affectedSources.add(ref.source_id)
    for (const other of oldSourcesToEntries.get(ref.source_id) ?? []) if (!affected.has(other.id)) { affected.add(other.id); queue.push(other.id) }
  }
  const retained = structuredClone(previous.entries.filter(entry => !affected.has(entry.id)))
  const used = new Set<string>()
  for (const entry of retained) for (const ref of entry.sources) { ref.source_id = mapped.get(ref.source_id)!; used.add(ref.source_id) }
  const generated = newBlocks.filter(block => !used.has(block.source.id)).flatMap(block => structuredClone(block.state.entries))
  // 不能把重新建立的普通段落沿用为旧定理 ID，否则旧证明可能悄悄指向不同语义。
  for (const entry of generated) if (byEntry.has(entry.id)) entry.id = newId()
  const generatedIds = new Set(generated.map(entry => entry.id)), entries = [...retained, ...generated]
  entries.sort((a, b) => ordinal.get(a.sources[0].source_id)! - ordinal.get(b.sources[0].source_id)! || (a.sources[0].text_range?.[0] ?? 0) - (b.sources[0].text_range?.[0] ?? 0))
  const alive = new Set(entries.map(entry => entry.id))
  let open: string[] = [], reparented = 0
  for (const entry of entries) {
    let parent = generatedIds.has(entry.id) ? open.at(-1) ?? null : entry.parent_id ?? null
    // 已移除/已结束的章节不能重新打开；依次寻找仍有效的祖先。
    while (parent && (!alive.has(parent) || !open.includes(parent))) parent = byEntry.get(parent)?.parent_id ?? null
    if ((entry.parent_id ?? null) !== parent && !generatedIds.has(entry.id)) reparented++
    if (parent || entry.parent_id !== undefined) entry.parent_id = parent
    open = parent ? open.slice(0, open.indexOf(parent) + 1) : []
    if (entry.type === 'section') open.push(entry.id)
  }
  const relations = structuredClone(previous.relations.filter(relation => alive.has(relation.from) && alive.has(relation.to)))
  const baseline = new Map(oldBlocks.map(block => [block.source.id, block.state.entries[0]]))
  const removedRelations = previous.relations.length - relations.length
  const state = { entries, relations }
  if (sources.length) validateLearningState(state, sources)
  const summary: NoteLearningSyncSummary = {
    added_segments: newBlocks.filter(block => !oldBySegment.has(block.origin.segment_id)).length,
    changed_segments: newBlocks.filter(block => { const old = oldBySegment.get(block.origin.segment_id); return old && old.source.id !== block.source.id }).length,
    removed_segments: oldBlocks.filter(block => !newBySegment.has(block.origin.segment_id)).length,
    affected_entry_ids: previous.entries.filter(entry => affected.has(entry.id)).map(entry => entry.id), retained_entries: retained.length, recreated_entries: generated.length,
    removed_relations: removedRelations, reparented_entries: reparented,
    removed_formulas: previous.entries.filter(entry => affected.has(entry.id)).reduce((sum, entry) => sum + (entry.formulas?.length ?? 0), 0),
    requires_review: removedRelations > 0 || reparented > 0 || previous.entries.some(entry => {
      const initial = baseline.get(entry.sources[0].source_id)
      return affected.has(entry.id) && JSON.stringify({ ...entry, id: initial?.id }) !== JSON.stringify(initial)
    })
  }
  return { state, summary }
}
