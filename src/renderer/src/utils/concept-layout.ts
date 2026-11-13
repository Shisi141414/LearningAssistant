import { graphlib, layout } from '@dagrejs/dagre'
import type { ConceptPosition, ConceptRelation } from '@shared/knowledge-graph'

export function conceptLayout(ids: string[], relations: ConceptRelation[]): ConceptPosition[] {
  const graph = new graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'LR', nodesep: 42, ranksep: 95, marginx: 35, marginy: 35 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const id of ids) graph.setNode(id, { width: 210, height: 82 })
  const included = new Set(ids)
  for (const [index, edge] of relations.entries())
    if (included.has(edge.from_id) && included.has(edge.to_id))
      graph.setEdge(edge.from_id, edge.to_id, {}, String(index))
  layout(graph)
  return ids.map((id) => {
    const point = graph.node(id)
    return { concept_id: id, x: point.x - 105, y: point.y - 41 }
  })
}
