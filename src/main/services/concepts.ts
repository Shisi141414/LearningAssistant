import { nanoid } from 'nanoid'
import type { Concept, ConceptInput, ConceptReferences } from '@shared/types'
import { conceptKey, createConceptMatcher } from '@shared/concept-matcher'
import { getDb } from './db'

type Row = Omit<Concept, 'aliases'>
export function listConcepts(): Concept[] {
  const db = getDb()
  const aliases = db.prepare('SELECT concept_id, name FROM concept_aliases ORDER BY normalized').all() as Array<{ concept_id: string; name: string }>
  const grouped = new Map<string, string[]>()
  for (const a of aliases) { if (!grouped.has(a.concept_id)) grouped.set(a.concept_id, []); grouped.get(a.concept_id)!.push(a.name) }
  return (db.prepare('SELECT id, subject_id, name, summary, revision, created_at FROM knowledge_points ORDER BY created_at DESC, id').all() as Row[])
    .map(row => ({ ...row, aliases: grouped.get(row.id) ?? [] }))
}
export function saveConcept(input: ConceptInput): Concept {
  const db = getDb(), name = input.name.trim(), id = input.id ?? nanoid()
  if (!name || name.length > 120 || input.aliases.length > 20) throw new Error('名称最多 120 字，别名最多 20 个')
  const dictionarySize = listConcepts().filter(c => c.id !== id).reduce((sum, c) => sum + c.name.length + c.aliases.reduce((n, a) => n + a.length, 0), 0)
  if (dictionarySize + name.length + input.aliases.reduce((sum, a) => sum + a.length, 0) > 100_000) throw new Error('首版概念名称与别名总计最多 10 万字符，请先整理词典')
  db.transaction(() => {
    if (input.subject_id && !db.prepare('SELECT id FROM subjects WHERE id = ?').get(input.subject_id)) throw new Error('学科不存在')
    const old = db.prepare('SELECT revision FROM knowledge_points WHERE id = ?').get(id) as { revision: number } | undefined
    if (input.id) {
      if (!old) throw new Error('概念不存在')
      if (input.revision !== old.revision) throw new Error('概念已被修改，请重新载入后再保存')
      db.prepare('UPDATE knowledge_points SET name = ?, summary = ?, subject_id = ?, revision = revision + 1 WHERE id = ?').run(name, input.summary, input.subject_id, id)
    } else {
      const count = (db.prepare('SELECT count(*) AS n FROM knowledge_points').get() as { n: number }).n
      if (count >= 2000) throw new Error('首版最多支持 2000 个概念，请整理后再添加')
      db.prepare('INSERT INTO knowledge_points (id, subject_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(id, input.subject_id, name, input.summary, Date.now())
    }
    db.prepare('DELETE FROM concept_aliases WHERE concept_id = ?').run(id)
    const insert = db.prepare('INSERT INTO concept_aliases (concept_id, name, normalized) VALUES (?, ?, ?)')
    const seen = new Set([conceptKey(name)])
    for (const alias of input.aliases) {
      const clean = alias.trim(), key = conceptKey(clean)
      if (!clean || clean.length > 120) throw new Error('别名不能为空，且最多 120 字')
      if (seen.has(key)) continue
      seen.add(key); insert.run(id, clean, key)
    }
  })()
  return listConcepts().find(c => c.id === id)!
}

/** 分批扫描现存文字，不持有正文编辑后会失效的提及偏移，不改原文。 */
export function conceptReferences(input: { id: string; offset?: number }): ConceptReferences {
  const db = getDb(), concepts = listConcepts()
  if (!concepts.some(c => c.id === input.id)) throw new Error('概念不存在')
  const offset = input.offset ?? 0
  const rows = db.prepare(`SELECT * FROM (
    SELECT 'material' AS type, b.id, b.version_id AS parent_id, m.title, b.text,
      '' AS organized_text, m.subject_id, m.id AS material_id, b.ordinal, b.locator_json
    FROM material_blocks b JOIN material_versions v ON v.id = b.version_id JOIN materials m ON m.id = v.material_id
    WHERE v.status = 'ready' AND m.archived = 0
    UNION ALL
    SELECT 'note', s.id, n.id, n.title, s.raw_text, s.organized_text, n.subject_id, NULL, NULL, NULL
    FROM note_segments s JOIN notes n ON n.id = s.note_id
  ) ORDER BY type, id LIMIT 301 OFFSET ?`).all(offset) as Array<{ type: 'material' | 'note'; id: string; parent_id: string; title: string; text: string; organized_text: string; subject_id: string | null; material_id: string | null; ordinal: number | null; locator_json: string | null }>
  const matchers = new Map<string | null, ReturnType<typeof createConceptMatcher>>()
  const result: ConceptReferences = { items: [], scanned: Math.min(rows.length, 300), next_offset: rows.length > 300 ? offset + 300 : null }
  for (const row of rows.slice(0, 300)) {
    if (!matchers.has(row.subject_id)) matchers.set(row.subject_id, createConceptMatcher(concepts, row.subject_id))
    const match = matchers.get(row.subject_id)!
    const fields = row.type === 'material' ? [['text', row.text]] as const : [['raw_text', row.text], ['organized_text', row.organized_text]] as const
    for (const [field, text] of fields) {
      const mention = match(text).find(m => m.status === 'linked' && m.concept_ids[0] === input.id)
      if (!mention) continue
      result.items.push({ type: row.type, id: row.id, parent_id: row.parent_id, title: row.title, text: text.slice(Math.max(0, mention.start - 55), mention.end + 90), field, mention,
        ...(row.type === 'material' ? { material_id: row.material_id!, ordinal: row.ordinal!, locator_json: row.locator_json! } : {}) })
    }
  }
  return result
}
