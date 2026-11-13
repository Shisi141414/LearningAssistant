import type { Concept } from './types'

export const conceptRelationLabels = {
  prerequisite: '前置知识',
  extends: '推广为',
  related: '相关'
} as const
export type ConceptRelationKind = keyof typeof conceptRelationLabels
export interface ConceptRelation {
  from_id: string
  to_id: string
  relation: string
  memo: string
  revision: string
  created_at: number
  updated_at: number
}
export interface ConceptPosition {
  concept_id: string
  x: number
  y: number
}
export interface KnowledgeGraph {
  concepts: Concept[]
  relations: ConceptRelation[]
  positions: ConceptPosition[]
}
export interface ConceptRelationInput {
  from_id: string
  to_id: string
  relation: ConceptRelationKind
  memo: string
  expected_revision?: string
}
export interface ConceptRelationRemove {
  from_id: string
  to_id: string
  expected_revision: string
}
export interface ConceptUsage {
  kind: 'exercise' | 'task' | 'project_document'
  id: string
  title: string
  status: string
  why: string
  project_id: string | null
  project_title: string | null
}
export interface ConceptUsagePage {
  items: ConceptUsage[]
  total: number
  next_offset: number | null
}
export const relationKey = (from: string, to: string): string => JSON.stringify([from, to])
export const relationLabel = (relation: string): string =>
  Object.hasOwn(conceptRelationLabels, relation)
    ? conceptRelationLabels[relation as ConceptRelationKind]
    : relation === 'cross-subject'
      ? '跨学科关联'
      : `旧关联：${relation}`

/** Only prerequisite edges form a learning order; related/extends links do not imply one. */
export function prerequisiteCycle(edges: ConceptRelation[], from: string, to: string): boolean {
  const adjacent = new Map<string, string[]>()
  for (const edge of edges)
    if (edge.relation === 'prerequisite' && !(edge.from_id === from && edge.to_id === to)) {
      const targets = adjacent.get(edge.from_id) ?? []
      targets.push(edge.to_id)
      adjacent.set(edge.from_id, targets)
    }
  const pending = [to],
    seen = new Set<string>()
  while (pending.length) {
    const node = pending.pop()!
    if (node === from) return true
    if (seen.has(node)) continue
    seen.add(node)
    pending.push(...(adjacent.get(node) ?? []))
  }
  return false
}
