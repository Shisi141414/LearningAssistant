export type GuideKind =
  | 'focus'
  | 'pitfall'
  | 'derivation'
  | 'assessment'
  | 'concept'
export const guideLabels: Record<GuideKind, string> = {
  focus: '讲授重点',
  pitfall: '易错提醒',
  derivation: '推导提示',
  assessment: '考核线索',
  concept: '概念引入'
}
export const GUIDE_RULE_VERSION = 'zh-classroom-1'
export interface GuideEvidence {
  rule: string
  kind: GuideKind
  start: number
  end: number
  quote: string
  reason: string
  priority: number
}
export interface GuideMatch {
  kind: GuideKind
  priority: number
  evidence: GuideEvidence[]
}
export interface ClassroomGuideHint {
  id: string
  revision: string
  session_id: string
  segment_id: string | null
  kind: GuideKind
  evidence: GuideEvidence[]
  excerpt: string
  rule_version: string
  notice: boolean
  quiet_reason: string
  status: 'open' | 'dismissed' | 'adopted'
  annotation_id: string | null
  annotation_kind: 'keypoint' | 'question' | null
  stale: boolean
  created_at: number
}
export interface ClassroomGuideState {
  revision: string | null
  enabled: boolean
  cooldown_seconds: number
  active: boolean
  session_id: string | null
  queued: number
  dropped: number
  error: string
  hints: ClassroomGuideHint[]
  total: number
  offset: number
}
export interface ClassroomGuideSave {
  note_id: string
  revision: string | null
  enabled: boolean
  cooldown_seconds: number
}
export interface ClassroomGuideAction {
  id: string
  revision: string
  action: 'dismiss' | 'keypoint' | 'question'
}

const rules: Array<{
  id: string
  kind: GuideKind
  priority: number
  pattern: RegExp
  reason: string
}> = [
  {
    id: 'assessment',
    kind: 'assessment',
    priority: 100,
    pattern:
      /考试(?:会|要|常|需要|可能|重点)|期末(?:会|要|常|重点)|必考|考点|考核要求/gu,
    reason: '出现考核或考试相关用语，请核对具体要求'
  },
  {
    id: 'pitfall',
    kind: 'pitfall',
    priority: 90,
    pattern:
      /容易(?:出错|混淆|漏掉|忽略)|常见错误|易错|不要(?:混淆|漏掉|忽略|忘记)|不能(?:混淆|漏掉|忽略)|切忌/gu,
    reason: '出现易错或防止遗漏的提醒'
  },
  {
    id: 'proof-key',
    kind: 'derivation',
    priority: 80,
    pattern: /证明的(?:关键|思路)|推导的(?:关键|思路)|关键(?:一步|步骤)/gu,
    reason: '出现证明或推导的关键步骤用语'
  },
  {
    id: 'emphasis',
    kind: 'focus',
    priority: 70,
    pattern:
      /重点|关键(?:是|在于)|特别注意|务必(?:记住|掌握)|必须(?:记住|掌握)|非常重要|很重要|重要的是/gu,
    reason: '出现明确的重点或强调用语'
  },
  {
    id: 'proof-start',
    kind: 'derivation',
    priority: 55,
    pattern: /下面(?:证明|推导)|接下来(?:证明|推导)/gu,
    reason: '出现证明或推导的开始线索'
  },
  {
    id: 'definition',
    kind: 'concept',
    priority: 50,
    pattern: /定义为|我们定义|定义是|称之为|定理表明|定理指出/gu,
    reason: '出现定义或定理的引入线索'
  }
]
/** Bounded literal rules, no model/network and no interpretation of transcript instructions. */
export function detectClassroomGuide(raw: string): GuideMatch | null {
  const offset = Math.max(0, raw.length - 4000),
    text = raw.slice(offset)
  const evidence: GuideEvidence[] = []
  // Mask quotations without changing UTF-16 offsets into the original source.
  const masked = text.replace(
    /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu,
    (s) => ' '.repeat(s.length)
  )
  for (const clause of masked.matchAll(/[^，,；;。！？!?\n]+/gu)) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      for (const match of clause[0].matchAll(rule.pattern)) {
        const before = clause[0]
          .slice(Math.max(0, match.index! - 14), match.index!)
          .replace(/\s/g, '')
        // Conservative local negation; it is not a general Chinese semantic parser.
        if (
          /(?:不是|并非|不算|谈不上|无需|不用|不必|没有|没什么|不要|别|不)(?:[\p{Script=Han}]{0,5})$/u.test(
            before
          ) &&
          !/不是不$/u.test(before)
        )
          continue
        const start = offset + clause.index! + match.index!,
          end = start + match[0].length
        evidence.push({
          rule: rule.id,
          kind: rule.kind,
          start,
          end,
          quote: raw.slice(start, end),
          reason: rule.reason,
          priority: rule.priority
        })
        break
      }
    }
  }
  evidence.sort((a, b) => b.priority - a.priority || a.start - b.start)
  if (!evidence.length) return null
  return {
    kind: evidence[0].kind,
    priority: evidence[0].priority,
    evidence: evidence.slice(0, 4)
  }
}
