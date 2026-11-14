import { nanoid } from 'nanoid'
import type {
  Assignment,
  AssignmentArchive,
  AssignmentDetail,
  AssignmentHistory,
  AssignmentList,
  AssignmentPage,
  AssignmentSave
} from '@shared/assignments'
import type { Task, TaskStatus } from '@shared/types'
import { getDb } from './db'
import { createTask, updateTask } from './projects'

interface Row extends Omit<Task, 'all_day'> {
  all_day: number
  assignment_id: string
  assignment_revision: string
  subject_id: string | null
  source: string
  deleted_at: number | null
  restore_status: TaskStatus | null
  legacy_snapshot_json: string | null
}
const SELECT = `SELECT t.*,a.id AS assignment_id,a.subject_id,a.source,l.revision AS assignment_revision,
  l.deleted_at,l.restore_status,l.legacy_snapshot_json FROM assignments a JOIN assignment_links l ON l.assignment_id=a.id JOIN tasks t ON t.id=l.task_id`
const row = (id: string): Row => {
  const value = getDb()
    .prepare(SELECT + ' WHERE a.id=?')
    .get(id) as Row | undefined
  if (!value) throw Error('作业不存在')
  return value
}
const present = (r: Row): Assignment => {
  const {
    assignment_id,
    assignment_revision,
    subject_id,
    source,
    deleted_at,
    restore_status,
    legacy_snapshot_json: _legacy,
    ...task
  } = r
  return {
    id: assignment_id,
    revision: assignment_revision,
    subject_id,
    source,
    deleted_at,
    restore_status,
    task: { ...task, all_day: !!task.all_day }
  }
}
export function getAssignment(id: string): AssignmentDetail {
  const r = row(id)
  const history = getDb()
    .prepare(
      'SELECT id,action,before_json,after_json,created_at FROM assignment_history WHERE assignment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100'
    )
    .all(id) as AssignmentHistory[]
  const count = getDb()
    .prepare(
      'SELECT count(*) AS n FROM assignment_history WHERE assignment_id=?'
    )
    .get(id) as { n: number }
  return {
    ...present(r),
    history,
    history_total: count.n,
    legacy_snapshot_json: r.legacy_snapshot_json
  }
}
export function listAssignments(input: AssignmentList): AssignmentPage {
  const clauses = [
    input.scope === 'trash'
      ? 'l.deleted_at IS NOT NULL'
      : 'l.deleted_at IS NULL'
  ]
  const args: Array<string | number> = []
  if (input.subject_id !== undefined) {
    clauses.push('a.subject_id IS ?')
    if (input.subject_id === null)
      clauses[clauses.length - 1] = 'a.subject_id IS NULL'
    else args.push(input.subject_id)
  }
  if (input.scope === 'open' || input.scope === 'overdue')
    clauses.push("t.status!='done'")
  if (input.scope === 'overdue') {
    clauses.push('t.due_at IS NOT NULL AND t.due_at<?')
    args.push(Date.now())
  }
  if (input.query.trim()) {
    clauses.push(
      '(instr(lower(t.title),lower(?))>0 OR instr(lower(t.detail),lower(?))>0)'
    )
    args.push(input.query.trim(), input.query.trim())
  }
  const where = ' WHERE ' + clauses.join(' AND ')
  const db = getDb()
  const total = (
    db
      .prepare('SELECT count(*) AS n FROM (' + SELECT + where + ')')
      .get(...args) as { n: number }
  ).n
  const items = (
    db
      .prepare(
        SELECT +
          where +
          ' ORDER BY t.due_at IS NULL,t.due_at,t.created_at DESC,a.id LIMIT 50 OFFSET ?'
      )
      .all(...args, input.offset) as Row[]
  ).map(present)
  return { items, total }
}
function expect(id: string, revision: string | undefined): Row {
  const current = row(id)
  if (current.assignment_revision !== revision)
    throw Error('作业或对应日程已变化，请重新载入后再保存；当前输入仍保留')
  return current
}
function record(
  id: string,
  action: string,
  before: unknown,
  after: unknown
): void {
  getDb()
    .prepare(
      'INSERT INTO assignment_history(id,assignment_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)'
    )
    .run(
      nanoid(),
      id,
      action,
      before === null ? null : JSON.stringify(before),
      JSON.stringify(after),
      Date.now()
    )
}
export function saveAssignment(input: AssignmentSave): AssignmentDetail {
  if (
    !input.title.trim() ||
    input.title.trim().length > 500 ||
    input.detail.length > 200000 ||
    input.blocked_reason.length > 2000
  )
    throw Error('作业名称或内容长度不正确')
  if (!['open', 'doing', 'blocked', 'done'].includes(input.status))
    throw Error('作业状态不正确')
  if (input.status === 'blocked' && !input.blocked_reason.trim())
    throw Error('请填写遇到的困难')
  const db = getDb()
  return db.transaction(() => {
    if (
      input.subject_id !== null &&
      !db.prepare('SELECT id FROM subjects WHERE id=?').get(input.subject_id)
    )
      throw Error('学科不存在，请重新选择')
    if (!input.id) {
      if (input.expected_revision !== undefined)
        throw Error('新作业不应包含旧编辑版本')
      const task = createTask({
        title: input.title,
        detail: input.detail,
        due_at: input.due_at
      })
      const id = nanoid()
      db.prepare(
        "INSERT INTO assignments(id,subject_id,title,due_at,source,status) VALUES(?,?,?,?,'manual',?)"
      ).run(id, input.subject_id, task.title, task.due_at, input.status)
      db.prepare(
        'INSERT INTO assignment_links(assignment_id,task_id,revision,writing) VALUES(?,?,?,1)'
      ).run(id, task.id, nanoid())
      updateTask(task.id, {
        status: input.status,
        blocked_reason: input.blocked_reason
      })
      db.prepare(
        'UPDATE assignment_links SET writing=0 WHERE assignment_id=?'
      ).run(id)
      record(id, 'create', null, present(row(id)))
      return getAssignment(id)
    }
    const current = expect(input.id, input.expected_revision)
    if (current.deleted_at !== null) throw Error('作业已在回收站，请先恢复')
    const before = present(current)
    db.prepare(
      'UPDATE assignment_links SET writing=1 WHERE assignment_id=?'
    ).run(input.id)
    db.prepare('UPDATE assignments SET subject_id=? WHERE id=?').run(
      input.subject_id,
      input.id
    )
    updateTask(current.id, {
      title: input.title,
      detail: input.detail,
      due_at: input.due_at,
      status: input.status,
      blocked_reason: input.blocked_reason
    })
    db.prepare(
      'UPDATE assignment_links SET writing=0,revision=? WHERE assignment_id=?'
    ).run(nanoid(), input.id)
    record(input.id, 'edit', before, present(row(input.id)))
    return getAssignment(input.id)
  })()
}
export function archiveAssignment(input: AssignmentArchive): AssignmentDetail {
  const db = getDb()
  return db.transaction(() => {
    const current = expect(input.id, input.expected_revision)
    if ((current.deleted_at !== null) === input.archived)
      return getAssignment(input.id)
    const blocks = db
      .prepare('SELECT * FROM schedule_blocks WHERE task_id=?')
      .all(current.id)
    const before = { ...present(current), blocks }
    db.prepare(
      'UPDATE assignment_links SET writing=1 WHERE assignment_id=?'
    ).run(input.id)
    if (input.archived) {
      db.prepare(
        'UPDATE assignment_links SET deleted_at=?,restore_status=? WHERE assignment_id=?'
      ).run(Date.now(), current.status, input.id)
      db.prepare('DELETE FROM schedule_blocks WHERE task_id=?').run(current.id)
      updateTask(current.id, {
        status: 'done',
        planned_at: null,
        planned_end_at: null,
        all_day: false
      })
    } else {
      const link = db
        .prepare(
          'SELECT restore_status FROM assignment_links WHERE assignment_id=?'
        )
        .get(input.id) as { restore_status: TaskStatus }
      db.prepare(
        'UPDATE assignment_links SET deleted_at=NULL,restore_status=NULL WHERE assignment_id=?'
      ).run(input.id)
      updateTask(current.id, { status: link.restore_status || 'open' })
    }
    db.prepare(
      'UPDATE assignment_links SET writing=0,revision=? WHERE assignment_id=?'
    ).run(nanoid(), input.id)
    record(
      input.id,
      input.archived ? 'trash' : 'restore',
      before,
      present(row(input.id))
    )
    return getAssignment(input.id)
  })()
}
