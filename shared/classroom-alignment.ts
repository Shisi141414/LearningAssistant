import MiniSearch from 'minisearch'

export interface AlignmentBlock {
  id: string
  ordinal: number
  text: string
  locator_json: string
}
export interface AlignmentCandidate extends AlignmentBlock {
  coverage: number
  terms: string[]
}
export interface AlignmentMatch {
  candidates: AlignmentCandidate[]
  strong: boolean
  reason: string
}
export interface ClassroomAlignmentJob {
  id: string
  epoch: string
  session_id: string
  segment_id: string
  status: 'queued' | 'running' | 'applied' | 'review' | 'cancelled' | 'failed'
  reason: string
  candidates: AlignmentCandidate[]
  applied_block_id: string | null
  created_at: number
  updated_at: number
}
export interface ClassroomAlignmentState {
  revision: string | null
  enabled: boolean
  active: boolean
  session_id: string | null
  error: string
  jobs: ClassroomAlignmentJob[]
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stop = new Set(
  '我们 你们 他们 这个 那个 然后 所以 因为 就是 一个 可以 现在 接下来 这里 那里 大家 同学 今天 刚才 这样 那样 什么 多少 已经 还有 进行 下面 上面 the and that this with from have'.split(
    ' '
  )
)
export function alignmentWords(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '')
  return [
    ...new Set(
      [...segmenter.segment(normalized)]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment)
        .filter((s) => s.length >= 2 && !/^\d+$/.test(s) && !stop.has(s))
    )
  ]
}
function tokens(text: string): string[] {
  return alignmentWords(text).flatMap((word) => {
    const parts = [word]
    if (/^\p{Script=Han}{3,}$/u.test(word))
      for (let i = 0; i < word.length - 1; i++) parts.push(word.slice(i, i + 2))
    return parts
  })
}

/** MiniSearch retrieves candidates; conservative query coverage decides whether to move. */
export class ClassroomMatcher {
  private index: MiniSearch<AlignmentBlock>
  private terms = new Map<string, Set<string>>()
  private frequencies = new Map<string, number>()
  private blocks: Map<string, AlignmentBlock>
  constructor(blocks: AlignmentBlock[]) {
    this.blocks = new Map(blocks.map((b) => [b.id, b]))
    this.index = new MiniSearch({
      fields: ['text'],
      tokenize: tokens,
      searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false }
    })
    this.index.addAll(blocks)
    for (const block of blocks) {
      const words = new Set(tokens(block.text))
      this.terms.set(block.id, words)
      for (const word of words)
        this.frequencies.set(word, (this.frequencies.get(word) ?? 0) + 1)
    }
  }
  match(text: string, currentOrdinal: number): AlignmentMatch {
    const words = alignmentWords(text.slice(-4000))
    if (words.length < 3)
      return {
        candidates: [],
        strong: false,
        reason: '位置待校准：当前语段有效术语不足'
      }
    const query = [...new Set(tokens(text.slice(-4000)))]
    const weight = (word: string): number =>
      1 +
      Math.log((this.blocks.size + 1) / ((this.frequencies.get(word) ?? 0) + 1))
    const total = query.reduce((sum, w) => sum + weight(w), 0)
    // Include all equal-score hits so repeated passages cannot become false certainty.
    const hits = this.index.search(text.slice(-4000))
    const candidates = hits
      .map((hit) => {
        const block = this.blocks.get(String(hit.id))!
        const terms = query.filter((w) => this.terms.get(block.id)!.has(w))
        return {
          ...block,
          text: block.text.slice(0, 400),
          terms: terms.slice(0, 12),
          coverage: terms.reduce((sum, w) => sum + weight(w), 0) / total
        }
      })
      .sort(
        (a, b) =>
          b.coverage - a.coverage ||
          Math.abs(a.ordinal - currentOrdinal) -
            Math.abs(b.ordinal - currentOrdinal)
      )
    const best = candidates[0]
    const distinctWords = best
      ? words.filter((word) => this.terms.get(best.id)!.has(word)).length
      : 0
    const strong =
      !!best &&
      distinctWords >= 3 &&
      best.coverage >= 0.72 &&
      best.coverage - (candidates[1]?.coverage ?? 0) >= 0.15
    return {
      candidates: candidates
        .filter((candidate) => candidate.coverage >= 0.35)
        .slice(0, 3),
      strong,
      reason: strong
        ? '当前语段与教材有明确文本匹配'
        : '位置待校准：文本匹配不足或存在相近候选'
    }
  }
}
