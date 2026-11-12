import type { LearningPackage } from './learning-package'
import { createConceptMatcher } from './concept-matcher'

/** 仅携带快照文字中出现或被该修订证据引用的已确认概念；在工作线程运行。 */
export function relatedPackageConcepts(document: LearningPackage): LearningPackage {
  const related = new Set(document.evidence.map(item => item.concept_id))
  const match = createConceptMatcher(document.concepts.map(concept => ({ ...concept, subject_id: null })))
  const scan = (text: string): void => { for (const mention of match(text)) for (const id of mention.concept_ids) related.add(id) }
  scan(document.document.title)
  for (const source of document.sources) { scan(source.raw_text); scan(source.heading) }
  for (const entry of document.state.entries) {
    scan(entry.title)
    for (const figure of entry.figures ?? []) scan(figure.caption)
    for (const formula of entry.formulas ?? []) scan(formula.latex)
  }
  return { ...document, concepts: document.concepts.filter(concept => related.has(concept.id)) }
}
