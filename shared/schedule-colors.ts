import type { Subject, TaskWithProject } from './types'

// Light backgrounds with dark, readable text. A category keeps its color across reloads.
const PALETTE = [
  { background: '#dceefc', text: '#245780' },
  { background: '#d8f1ea', text: '#236353' },
  { background: '#fce5eb', text: '#8a3853' },
  { background: '#eee3fa', text: '#654487' },
  { background: '#fff0cb', text: '#795b17' },
  { background: '#d9f1f4', text: '#28626c' },
  { background: '#ffe6d5', text: '#874e2c' },
  { background: '#e7efd5', text: '#526632' }
]
export function scheduleCategory(
  task: TaskWithProject,
  subjects: Pick<Subject, 'id' | 'name'>[]
): string {
  const subjectId = task.project_subject_id ?? task.review_subject_id ?? task.assignment_subject_id
  const linked = subjects.find((subject) => subject.id === subjectId)
  if (linked) return '学科：' + linked.name
  if (subjectId) return '学科：' + subjectId
  if (task.review_id) return '复习'
  if (task.assignment_id) return '作业'
  if (task.project_id) return '项目：' + (task.project_title ?? task.project_id)
  const title = task.title.normalize('NFKC').trim()
  const matched = [...subjects]
    .sort((a, b) => b.name.length - a.name.length)
    .find((subject) => title.includes(subject.name))
  if (matched) return '学科：' + matched.name
  for (const [category, pattern] of [
    ['考试', /考试|测验/],
    ['实验', /实验/],
    ['讨论会议', /会议|讨论/]
  ] as const) {
    if (pattern.test(title)) return '分类：' + category
  }
  return (
    '课程或事项：' +
    title
      .replace(/第[一二三四五六七八九十百\d]+[讲章节周次]/g, '')
      .replace(/预习|复习|作业|课堂|课程/g, '')
      .replace(/\s+/g, '')
      .trim()
  )
}
export function scheduleColor(category: string): { background: string; text: string } {
  let hash = 2166136261
  for (const character of category) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  return PALETTE[(hash >>> 0) % PALETTE.length]
}
