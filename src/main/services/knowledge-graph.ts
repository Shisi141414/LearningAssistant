import { nanoid } from 'nanoid'
import type {
  ConceptPosition,
  ConceptRelation,
  ConceptRelationInput,
  ConceptRelationRemove,
  ConceptUsage,
  ConceptUsagePage,
  KnowledgeGraph
} from '@shared/knowledge-graph'
import { prerequisiteCycle } from '@shared/knowledge-graph'
import { getDb } from './db'
import { listConcepts } from './concepts'

function requireConcept(id: string): void {
  if (!getDb().prepare('SELECT id FROM knowledge_points WHERE id=?').get(id))
    throw new Error('知识点不存在，请刷新')
}
export function knowledgeGraph(): KnowledgeGraph {
  return getDb().transaction(() => ({
    concepts: listConcepts(),
    relations: getDb()
      .prepare('SELECT * FROM knowledge_edges ORDER BY from_id,to_id')
      .all() as ConceptRelation[],
    positions: getDb()
      .prepare('SELECT concept_id,x,y FROM concept_graph_positions ORDER BY concept_id')
      .all() as ConceptPosition[]
  }))()
}
export function saveConceptRelation(input: ConceptRelationInput): ConceptRelation {
  const db = getDb()
  return db.transaction(() => {
    requireConcept(input.from_id)
    requireConcept(input.to_id)
    if (input.from_id === input.to_id) throw new Error('不能将知识点关联到自身')
    const existing = db
      .prepare('SELECT * FROM knowledge_edges WHERE from_id=? AND to_id=?')
      .get(input.from_id, input.to_id) as ConceptRelation | undefined
    if (
      existing
        ? existing.revision !== input.expected_revision
        : input.expected_revision !== undefined
    )
      throw new Error('关系已变化，请刷新后再编辑；重复建立不会覆盖已有说明')
    if (
      !existing &&
      (db.prepare('SELECT count(*) AS n FROM knowledge_edges').get() as { n: number }).n >= 5000
    )
      throw new Error('当前最多支持 5000 条关系，请先整理图谱')
    const reverse = db
      .prepare('SELECT * FROM knowledge_edges WHERE from_id=? AND to_id=?')
      .get(input.to_id, input.from_id) as ConceptRelation | undefined
    if (reverse && (input.relation === 'related' || reverse.relation === 'related'))
      throw new Error('已有反向关系，相关关系不区分方向，请编辑或删除原关系后重建')
    if (
      input.relation === 'prerequisite' &&
      prerequisiteCycle(
        db.prepare('SELECT * FROM knowledge_edges').all() as ConceptRelation[],
        input.from_id,
        input.to_id
      )
    )
      throw new Error('前置知识形成循环，请检查学习顺序')
    const now = Date.now(),
      revision = nanoid()
    if (existing)
      db.prepare(
        'UPDATE knowledge_edges SET relation=?,memo=?,revision=?,updated_at=? WHERE from_id=? AND to_id=?'
      ).run(input.relation, input.memo.trim(), revision, now, input.from_id, input.to_id)
    else
      db.prepare(
        'INSERT INTO knowledge_edges(from_id,to_id,relation,memo,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run(input.from_id, input.to_id, input.relation, input.memo.trim(), revision, now, now)
    return db
      .prepare('SELECT * FROM knowledge_edges WHERE from_id=? AND to_id=?')
      .get(input.from_id, input.to_id) as ConceptRelation
  })()
}
export function removeConceptRelation(input: ConceptRelationRemove): boolean {
  const changes = getDb()
    .prepare('DELETE FROM knowledge_edges WHERE from_id=? AND to_id=? AND revision=?')
    .run(input.from_id, input.to_id, input.expected_revision).changes
  if (!changes) throw new Error('关系已变化或已删除，请刷新后再操作')
  return true
}
export function saveConceptPositions(positions: ConceptPosition[]): boolean {
  return getDb().transaction(() => {
    if (new Set(positions.map((item) => item.concept_id)).size !== positions.length)
      throw new Error('布局知识点不能重复')
    const save = getDb().prepare(
      'INSERT INTO concept_graph_positions(concept_id,x,y) VALUES (?,?,?) ON CONFLICT(concept_id) DO UPDATE SET x=excluded.x,y=excluded.y'
    )
    for (const item of positions) {
      requireConcept(item.concept_id)
      save.run(item.concept_id, item.x, item.y)
    }
    return true
  })()
}
/** Explicit learning uses, distinct from name mentions and evidence quotes. */
export function conceptUsage(input: { concept_id: string; offset?: number }): ConceptUsagePage {
  requireConcept(input.concept_id)
  const db = getDb(),
    offset = input.offset ?? 0
  const sql = `SELECT 'exercise' AS kind,e.id,CASE WHEN e.title='' THEN substr(e.statement,1,80) ELSE e.title END AS title,e.status,'' AS why,NULL AS project_id,NULL AS project_title
    FROM exercises e WHERE e.deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(e.review_concepts_json) THEN e.review_concepts_json ELSE '[]' END) WHERE value=@concept)
    UNION ALL
    SELECT 'task',t.id,t.title,t.status,COALESCE((SELECT json_extract(value,'$.why') FROM json_each(CASE WHEN json_valid(t.knowledge_refs_json) THEN t.knowledge_refs_json ELSE '[]' END) WHERE json_extract(value,'$.concept_id')=@concept LIMIT 1),''),p.id,p.title
    FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.knowledge_refs_json) THEN t.knowledge_refs_json ELSE '[]' END) WHERE json_extract(value,'$.concept_id')=@concept)
    UNION ALL
    SELECT 'project_document',d.id,d.title,'document','项目资料中关联的知识',p.id,p.title
    FROM project_documents d JOIN projects p ON p.id=d.project_id JOIN project_document_revisions r ON r.id=d.head_revision_id
    WHERE d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(r.snapshot_json,'$.concept_ids') WHERE value=@concept)`
  return db.transaction(() => {
    const args = { concept: input.concept_id },
      items = db
        .prepare(`SELECT * FROM (${sql}) ORDER BY kind,id LIMIT 50 OFFSET @offset`)
        .all({ ...args, offset }) as ConceptUsage[]
    const total = (db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(args) as { n: number }).n
    return {
      items,
      total,
      next_offset: offset + items.length < total ? offset + items.length : null
    }
  })()
}
