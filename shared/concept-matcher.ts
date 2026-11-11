import AhoCorasick from 'ahocorasick'
import type { Concept, ConceptMention } from './types'

/** 只做等长规范化，位置始终对应原文 UTF-16。 */
export function conceptKey(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ').replace(/[A-Z]/g, c => c.toLowerCase())
}
const word = (char: string | undefined): boolean => !!char && /[a-z0-9_]/.test(char)
type Dictionary = Pick<Concept, 'id' | 'name' | 'aliases' | 'subject_id'>[]
// 字典数组按不可变快照使用；同一字典跨阅读块、学科和回链批次只构建一次自动机。
const compiled = new WeakMap<Dictionary, { candidates: Map<string, Map<string, string | null>>; ac: AhoCorasick | null }>()
export function createConceptMatcher(concepts: Dictionary, subjectId?: string | null): (text: string) => ConceptMention[] {
  let dictionary = compiled.get(concepts)
  if (!dictionary) {
    const candidates = new Map<string, Map<string, string | null>>()
    for (const concept of concepts) for (const name of [concept.name, ...concept.aliases]) {
        const key = conceptKey(name.trim())
        if (!key) continue
        if (!candidates.has(key)) candidates.set(key, new Map())
        candidates.get(key)!.set(concept.id, concept.subject_id)
    }
    dictionary = { candidates, ac: candidates.size ? new AhoCorasick([...candidates.keys()]) : null }
    compiled.set(concepts, dictionary)
  }
  const { ac, candidates } = dictionary
  if (!ac) return () => []
  return text => {
    const normalized = conceptKey(text), matches: ConceptMention[] = []
    for (const [last, keys] of ac.search(normalized)) for (const key of keys) {
      const start = last + 1 - key.length, end = last + 1
      if ((word(key[0]) && word(normalized[start - 1])) || (word(key.at(-1)) && word(normalized[end]))) continue
      const ids = [...candidates.get(key)!].filter(([, scope]) => !subjectId || !scope || scope === subjectId).map(([id]) => id).sort()
      if (!ids.length) continue
      matches.push({ start, end, text: text.slice(start, end), concept_ids: ids, status: ids.length === 1 ? 'linked' : 'ambiguous' })
    }
    // 左起点优先，同起点最长优先，避免嵌套/重复链接。
    matches.sort((a, b) => a.start - b.start || b.end - a.end)
    const output: ConceptMention[] = []
    let end = 0
    for (const match of matches) { if (match.start < end) continue; output.push(match); end = match.end }
    return output
  }
}
