import type { LearningEntry, LearningSource, LearningState } from './types'
import { entryText, validateLearningState } from './learning-document'
import { learningContent } from './learning-formulas'

export interface ExerciseSetCandidate {
  id: string
  title: string
  statement: string
  approach: string
  answer: string
  location: string
  existing_id: string | null
  in_trash: boolean
}
export interface ExerciseSetPreview {
  token: string
  material_id: string
  version_id: string
  revision_id: string
  title: string
  candidates: ExerciseSetCandidate[]
  warnings: string[]
}
export interface ExerciseSetResult {
  added: number
  skipped: number
  in_trash: number
  ids: string[]
  material_id: string
  revision_id: string
}
export const isExerciseApproach = (entry: LearningEntry): boolean =>
  /^(?:解题思路|思路|提示)/.test(entry.title)
export function exerciseEntryText(
  entry: LearningEntry,
  sources: Map<string, LearningSource>
): string {
  return learningContent(entryText(entry, sources), entry.formulas)
    .map((node) =>
      node.type === 'text'
        ? node.text
        : node.formula.display
          ? `\n$$${node.formula.latex}$$\n`
          : `$${node.formula.latex}$`
    )
    .join('')
}

const number = '[0-9０-９一二三四五六七八九十百]+(?:[-－.．][0-9０-９]+)*'
const explicitQuestion = new RegExp(
  `^(?:【|\\[)?(?:例题?|习题|练习题?|题目?|问题|Exercise|Problem|Question|Q)\\s*(${number})(?:】|\\])?(?:[.．、:：)）]|\\s|$)?`,
  'i'
)
const ordinalQuestion = new RegExp(`^第\\s*(${number})\\s*题`)
const numberedQuestion = new RegExp(
  `^(${number})(?:[.．](?![0-9０-９])|[、:：)）]|\\s+)(?=\\S|\\s+\\S)`
)
const answerHeading =
  /^(?:参考答案|参考解答|答案(?:与|及|和)?解析|习题答案|解答汇总|答案|Answers|Solutions)\s*[:：]?$/i
const chapterHeading =
  /^(?:第[\d一二三四五六七八九十百]+[章节篇]|Chapter\s+\d|[一二三四五六七八九十]+[、．]\s*(?:选择|填空|计算|证明|简答|综合))/i
const solutionHeading =
  /^(?:【|\[)?(解题思路|思路|提示|参考答案|标准答案|答案|解答|解析|证明|解|Solution|Answer)(?:】|\])?(?:[:：.．]|\s|$)/i

/** Narrow, local question-boundary recognition; no source text is rewritten or discarded. */
export function splitExerciseSet(
  sources: LearningSource[],
  previous: LearningState,
  newId: () => string
): { state: LearningState; changed: boolean; warnings: string[] } {
  // Existing human/AI structure and formula/figure corrections take precedence.
  if (
    previous.relations.length ||
    previous.entries.some(
      (e) =>
        e.type !== 'narrative' ||
        e.title ||
        e.parent_id ||
        e.analysis.method !== 'extracted' ||
        e.formulas?.length ||
        e.figures?.length
    )
  ) {
    return {
      state: previous,
      changed: false,
      warnings: ['沿用已有条目与解答关联，不重新切分人工或 AI 整理过的内容。']
    }
  }
  const state: LearningState = { entries: [], relations: [] },
    warnings = new Set<string>()
  const questions = new Map<string, LearningEntry[]>()
  let active: LearningEntry | undefined,
    question: LearningEntry | undefined,
    answers = false
  const create = (type: LearningEntry['type'], title = ''): LearningEntry => {
    active = {
      id: newId(),
      type,
      title: title.slice(0, 500),
      sources: [],
      analysis: { method: 'extracted', review_status: 'unreviewed' }
    }
    state.entries.push(active)
    return active
  }
  const append = (source: LearningSource, start: number, end: number) => {
    const target = active ?? create('narrative'),
      last = target.sources.at(-1)
    if (!source.raw_text.length) target.sources.push({ source_id: source.id })
    else if (last?.source_id === source.id && last.text_range?.[1] === start)
      last.text_range[1] = end
    else target.sources.push({ source_id: source.id, text_range: [start, end] })
  }
  for (const source of sources) {
    if (!source.raw_text.length) {
      append(source, 0, 0)
      continue
    }
    for (const match of source.raw_text.matchAll(/[^\n]*(?:\n|$)/g)) {
      if (!match[0].length) continue
      const text = match[0].trim(),
        start = match.index!,
        end = start + match[0].length
      if (answerHeading.test(text)) {
        answers = true
        question = undefined
        create('narrative', text)
      } else if (chapterHeading.test(text)) {
        answers = false
        question = undefined
        create('narrative', text)
      } else {
        const marker =
          ordinalQuestion.exec(text) ??
          explicitQuestion.exec(text) ??
          numberedQuestion.exec(text)
        const solution = solutionHeading.exec(text)
        if (marker) {
          const key = marker[1].normalize('NFKC').replaceAll('－', '-'),
            matches = questions.get(key) ?? []
          if (answers) {
            question = matches.length === 1 ? matches[0] : undefined
            const part = create(
              question ? 'solution' : 'narrative',
              '参考答案 ' + key
            )
            if (question)
              state.relations.push({
                from: part.id,
                to: question.id,
                type: 'solves',
                review_status: 'unreviewed'
              })
            else
              warnings.add(
                '部分汇总答案的题号不存在或重复，已保留在材料中，未猜测配对；请在材料整理中核对。'
              )
          } else {
            question = create('exercise', text.slice(0, 100))
            questions.set(key, [...matches, question])
          }
        } else if (solution && question) {
          const part = create('solution', solution[1])
          state.relations.push({
            from: part.id,
            to: question.id,
            type: 'solves',
            review_status: 'unreviewed'
          })
        }
      }
      append(source, start, end)
    }
  }
  const count = state.entries.filter((e) => e.type === 'exercise').length
  if (!count)
    return {
      state: previous,
      changed: false,
      warnings: [
        '未识别到题号或习题条目。可在材料整理中划分题面、解答并关联后，再重新预览；不会把整本材料当成一道题。'
      ]
    }
  if (count > 500)
    throw new Error('一次最多转换 500 道题，请先将习题集按章节拆成文件')
  validateLearningState(state, sources)
  return { state, changed: true, warnings: [...warnings] }
}
