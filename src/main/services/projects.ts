/**
 * services/projects.ts —— R4 项目管理：项目 / 里程碑 / 统一任务模型
 *
 * tasks 表是 R5 日程与 R6 备忘分流的统一任务模型（kind 区分来源）；
 * 知识点引用（knowledge_refs_json）实现"任务引用知识点并展示学习/应用路径"。
 */
import type { Project, ProjectDetail, ProjectInput, Milestone, MilestoneInput, Task, TaskInput, TaskKnowledgeRef, ID, Timestamp } from '@shared/types'
import { getDb } from './db'
import { nanoid } from 'nanoid'

interface ProjectRow {
  id: string
  subject_id: string | null
  title: string
  goal: string
  description: string
  status: Project['status']
  created_at: number
  updated_at: number
}

interface MilestoneRow extends Omit<Milestone, 'due_at'> {
  due_at: number | null
}

interface TaskRow {
  id: string
  kind: Task['kind']
  project_id: string | null
  milestone_id: string | null
  title: string
  detail: string
  status: Task['status']
  blocked_reason: string
  due_at: number | null
  planned_at: number | null
  knowledge_refs_json: string
  created_at: number
  updated_at: number
}

const rowToProject = (r: ProjectRow): Project => ({ ...r })
const rowToMilestone = (r: MilestoneRow): Milestone => ({ ...r })
const rowToTask = (r: TaskRow): Task => ({ ...r })

function touchProject(projectId: ID): void {
  getDb().prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId)
}

export function listProjects(subjectId?: ID | null): Project[] {
  const db = getDb()
  const rows = subjectId
    ? (db.prepare('SELECT * FROM projects WHERE subject_id = ? ORDER BY updated_at DESC').all(subjectId) as ProjectRow[])
    : (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[])
  return rows.map((row) => {
    const counts = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = ?) AS milestones,
         (SELECT COUNT(*) FROM project_milestones m WHERE m.project_id = ? AND m.status = 'done') AS milestones_done,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = ?) AS tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = ? AND t.status = 'done') AS tasks_done`
    ).get(row.id, row.id, row.id, row.id) as { milestones: number; milestones_done: number; tasks: number; tasks_done: number }
    return { ...rowToProject(row), counts }
  })
}

export function createProject(input: ProjectInput): Project {
  const db = getDb()
  const now = Date.now()
  const project: Project = {
    id: nanoid(),
    subject_id: input.subject_id ?? null,
    title: input.title,
    goal: input.goal ?? '',
    description: input.description ?? '',
    status: input.status ?? 'active',
    created_at: now,
    updated_at: now
  }
  db.prepare('INSERT INTO projects (id, subject_id, title, goal, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    project.id, project.subject_id, project.title, project.goal, project.description, project.status, project.created_at, project.updated_at
  )
  return project
}

export function updateProject(id: ID, patchInput: Partial<ProjectInput>): Project {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  if (!cur) throw new Error('项目不存在')
  const next: Project = { ...rowToProject(cur), ...patchInput }
  db.prepare('UPDATE projects SET title = ?, subject_id = ?, goal = ?, description = ?, status = ?, updated_at = ? WHERE id = ?').run(
    next.title, next.subject_id, next.goal, next.description, next.status, Date.now(), id
  )
  return next
}

export function removeProject(id: ID): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id) // 里程碑/项目任务级联删除；手动任务 project_id 置 NULL 由 FK 处理（project_task 亦级联，符合语义）
}

export function projectDetail(id: ID): ProjectDetail {
  const db = getDb()
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  if (!row) throw new Error('项目不存在')
  const milestones = (db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id) AS tasks_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'done') AS tasks_done
     FROM project_milestones m WHERE m.project_id = ? ORDER BY m.sort_order, m.created_at`
  ).all(id) as Array<MilestoneRow & { tasks_count: number; tasks_done: number }>)
  const tasks = (db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at').all(id) as TaskRow[]).map(rowToTask)
  return { ...rowToProject(row), milestones, tasks }
}

/* ---------- 里程碑 ---------- */

export function createMilestone(input: MilestoneInput): Milestone {
  const db = getDb()
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.project_id)
  if (!project) throw new Error('项目不存在')
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_milestones WHERE project_id = ?').get(input.project_id) as { m: number }
  const now = Date.now()
  const ms: Milestone = {
    id: nanoid(),
    project_id: input.project_id,
    title: input.title,
    detail: input.detail ?? '',
    due_at: input.due_at ?? null,
    status: 'open',
    sort_order: max.m + 1,
    created_at: now,
    updated_at: now
  }
  db.prepare('INSERT INTO project_milestones (id, project_id, title, detail, due_at, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    ms.id, ms.project_id, ms.title, ms.detail, ms.due_at, ms.status, ms.sort_order, ms.created_at, ms.updated_at
  )
  touchProject(ms.project_id)
  return ms
}

export function updateMilestone(id: ID, patchInput: Partial<MilestoneInput> & { status?: 'open' | 'done' }): Milestone {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM project_milestones WHERE id = ?').get(id) as MilestoneRow | undefined
  if (!cur) throw new Error('里程碑不存在')
  const next: Milestone = { ...rowToMilestone(cur), ...patchInput, updated_at: Date.now() as Timestamp }
  db.prepare('UPDATE project_milestones SET title = ?, detail = ?, due_at = ?, status = ?, updated_at = ? WHERE id = ?').run(
    next.title, next.detail, next.due_at, next.status, next.updated_at, id
  )
  touchProject(cur.project_id)
  return next
}

export function removeMilestone(id: ID): void {
  const db = getDb()
  const cur = db.prepare('SELECT project_id FROM project_milestones WHERE id = ?').get(id) as { project_id: string } | undefined
  db.prepare('DELETE FROM project_milestones WHERE id = ?').run(id) // 关联任务 milestone_id 置 NULL（退回项目级任务）
  if (cur) touchProject(cur.project_id)
}

/* ---------- 任务（统一任务模型） ---------- */

function parseKnowledgeRefs(json: string): TaskKnowledgeRef[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function createTaskRow(input: TaskInput): Task {
  const db = getDb()
  if (input.project_id) {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.project_id)
    if (!project) throw new Error('项目不存在')
  }
  if (input.milestone_id && !input.project_id) throw new Error('里程碑任务必须挂项目')
  if (input.milestone_id) {
    const ms = db.prepare('SELECT project_id FROM project_milestones WHERE id = ?').get(input.milestone_id) as { project_id: string } | undefined
    if (!ms) throw new Error('里程碑不存在')
    if (ms.project_id !== input.project_id) throw new Error('任务挂载的里程碑不属于该项目')
  }
  // 知识点引用校验：引用的知识点必须存在（防悬挂引用）
  const refs = input.knowledge_refs ?? []
  for (const ref of refs) {
    if (!db.prepare('SELECT id FROM knowledge_points WHERE id = ?').get(ref.concept_id)) {
      throw new Error(`知识点引用无效（${ref.concept_id}），请刷新知识页后重试`)
    }
  }
  const now = Date.now()
  const task: Task = {
    id: nanoid(),
    kind: input.kind ?? (input.project_id ? 'project_task' : 'manual'),
    project_id: input.project_id ?? null,
    milestone_id: input.milestone_id ?? null,
    title: input.title,
    detail: input.detail ?? '',
    status: 'open',
    blocked_reason: '',
    due_at: input.due_at ?? null,
    planned_at: null,
    knowledge_refs_json: JSON.stringify(refs),
    created_at: now,
    updated_at: now
  }
  db.prepare('INSERT INTO tasks (id, kind, project_id, milestone_id, title, detail, status, blocked_reason, due_at, planned_at, knowledge_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    task.id, task.kind, task.project_id, task.milestone_id, task.title, task.detail, task.status, task.blocked_reason, task.due_at, task.planned_at, task.knowledge_refs_json, task.created_at, task.updated_at
  )
  if (task.project_id) touchProject(task.project_id)
  return task
}

export { createTaskRow as createTask }

export function updateTask(id: ID, patchInput: Partial<TaskInput> & { status?: Task['status']; blocked_reason?: string; planned_at?: Timestamp | null }): Task {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  if (!cur) throw new Error('任务不存在')
  if (patchInput.status === 'blocked' && (patchInput.blocked_reason ?? cur.blocked_reason).trim() === '' && cur.status !== 'blocked') {
    throw new Error('标记阻塞需要填写原因（blocked_reason）')
  }
  const refs = patchInput.knowledge_refs !== undefined ? patchInput.knowledge_refs : parseKnowledgeRefs(cur.knowledge_refs_json)
  for (const ref of refs) {
    if (!db.prepare('SELECT id FROM knowledge_points WHERE id = ?').get(ref.concept_id)) {
      throw new Error(`知识点引用无效（${ref.concept_id}）`)
    }
  }
  const next: Task = {
    ...rowToTask(cur),
    ...patchInput,
    due_at: patchInput.due_at !== undefined ? patchInput.due_at : cur.due_at,
    milestone_id: patchInput.milestone_id !== undefined ? patchInput.milestone_id : cur.milestone_id,
    knowledge_refs_json: JSON.stringify(refs),
    updated_at: Date.now()
  }
  db.prepare('UPDATE tasks SET title = ?, detail = ?, status = ?, blocked_reason = ?, due_at = ?, planned_at = ?, milestone_id = ?, knowledge_refs_json = ?, updated_at = ? WHERE id = ?').run(
    next.title, next.detail, next.status, next.blocked_reason, next.due_at, next.planned_at, next.milestone_id, next.knowledge_refs_json, next.updated_at, id
  )
  if (next.project_id) touchProject(next.project_id)
  return next
}

export function removeTask(id: ID): void {
  const db = getDb()
  const cur = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as { project_id: string | null } | undefined
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  if (cur?.project_id) touchProject(cur.project_id)
}

/** 手动任务收件箱（R5 日程页与 R6 备忘分流的入口；项目任务在项目详情看） */
export function listManualTasks(): Task[] {
  return (getDb().prepare("SELECT * FROM tasks WHERE kind = 'manual' ORDER BY COALESCE(due_at, created_at)").all() as TaskRow[]).map(rowToTask)
}
