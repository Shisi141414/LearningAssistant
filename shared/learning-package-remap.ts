import type { LearningPackage } from './learning-package'
import type { LearningState, ParsedBlock } from './types'
import { chunkText } from './textChunk'

export function remapLearningPackage(document: LearningPackage, newId: () => string) {
  const sources = new Map(document.sources.map(row => [row.id, newId()])), entries = new Map(document.state.entries.map(row => [row.id, newId()])), assets = new Map(document.assets.map(row => [row.id, newId()]))
  const state: LearningState = {
    entries: structuredClone(document.state.entries).map(entry => ({ ...entry, id: entries.get(entry.id)!,
      ...(entry.parent_id ? { parent_id: entries.get(entry.parent_id)! } : {}), sources: entry.sources.map(ref => ({ ...ref, source_id: sources.get(ref.source_id)! })),
      ...(entry.figures ? { figures: entry.figures.map(figure => ({ ...figure, asset_id: assets.get(figure.asset_id)! })) } : {}) })),
    relations: document.state.relations.map(relation => ({ ...relation, from: entries.get(relation.from)!, to: entries.get(relation.to)! }))
  }
  return { sources, entries, assets, state, units: document.sources.map(source => ({ ...source, id: sources.get(source.id)! })) }
}
/** 复用既有切块器，在工作线程建立检索块；规范来源及条目正文不重写。 */
export function learningPackageBlocks(document: LearningPackage): ParsedBlock[] {
  return document.sources.flatMap(source => chunkText(source.raw_text || '本来源暂无可检索文字，请查看学习文档或原件。', { maxChars: 900, overlap: 60 }).map(part => ({ text: part.text, heading: source.heading || part.heading, locator: JSON.parse(source.locator_json) })))
}
