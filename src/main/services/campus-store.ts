import { nanoid } from 'nanoid'
import type {
  CampusApply,
  CampusCourse,
  CampusField,
  CampusPreview,
  CampusPreviewItem,
  CampusProvenance,
  CampusSource
} from '@shared/campus'
import { getDb } from './db'
import { getAssignment, saveAssignment } from './assignments'
import { digest } from './campus-policy'

interface SourceRow {
  assignment_id: string
  source_json: string
  source_revision: string
  overrides_json: string
}
interface Entry {
  source: CampusSource
  subject_id: string | null
  course_revision: string
  item: CampusPreviewItem
  expected: string | null
}
export interface CampusTicket {
  preview: CampusPreview
  entries: Entry[]
  fingerprint: string
}
const fields: CampusField[] = ['title', 'due_at', 'subject_id']
export function campusCourses(
  account: string,
  semester: string
): CampusCourse[] {
  return getDb()
    .prepare(
      'SELECT id,title,subject_id,revision FROM campus_courses WHERE account_id=? AND semester=? ORDER BY title,id'
    )
    .all(account, semester) as CampusCourse[]
}
export function storeCampusCourses(
  account: string,
  label: string,
  semester: string,
  courses: Array<{ id: string; title: string }>
): void {
  getDb().transaction(() => {
    getDb()
      .prepare(
        'INSERT INTO campus_accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at'
      )
      .run(account, label, Date.now())
    const insert = getDb().prepare(
      'INSERT INTO campus_courses(account_id,semester,id,title,revision) VALUES(?,?,?,?,?) ON CONFLICT(account_id,semester,id) DO UPDATE SET title=excluded.title,revision=CASE WHEN title IS NOT excluded.title THEN excluded.revision ELSE revision END'
    )
    for (const c of courses)
      insert.run(account, semester, c.id, c.title, nanoid())
  })()
}
export function mapCampusCourse(
  account: string,
  semester: string,
  input: { id: string; revision: string; subject_id: string | null }
): void {
  const db = getDb()
  db.transaction(() => {
    if (
      input.subject_id !== null &&
      !db.prepare('SELECT id FROM subjects WHERE id=?').get(input.subject_id)
    )
      throw Error('学科不存在')
    const result = db
      .prepare(
        'UPDATE campus_courses SET subject_id=?,revision=? WHERE account_id=? AND semester=? AND id=? AND revision=?'
      )
      .run(
        input.subject_id,
        nanoid(),
        account,
        semester,
        input.id,
        input.revision
      )
    if (!result.changes) throw Error('课程设置已变化，请刷新后重试')
  })()
}
function sourceRow(s: CampusSource): SourceRow | undefined {
  return getDb()
    .prepare(
      'SELECT assignment_id,source_json,source_revision,overrides_json FROM campus_sources WHERE account_id=? AND course_id=? AND homework_id=?'
    )
    .get(s.account_id, s.course_id, s.id) as SourceRow | undefined
}
function entry(s: CampusSource): Entry {
  const course = getDb()
    .prepare(
      'SELECT subject_id,revision FROM campus_courses WHERE account_id=? AND semester=? AND id=?'
    )
    .get(s.account_id, s.semester, s.course_id) as
    | { subject_id: string | null; revision: string }
    | undefined
  if (!course) throw Error('课程已变化，请重新获取')
  const existing = sourceRow(s),
    a = existing ? getAssignment(existing.assignment_id) : null
  const overrides = JSON.parse(existing?.overrides_json ?? '{}') as Partial<
    Record<CampusField, number>
  >
  const local = a
    ? { title: a.task.title, due_at: a.task.due_at, subject_id: a.subject_id }
    : null
  const remote = {
    title: s.title,
    due_at: s.due_at,
    subject_id: course.subject_id
  }
  const changes = local
    ? fields
        .filter((f) => local[f] !== remote[f])
        .map((f) => ({
          field: f,
          local: local[f],
          remote: remote[f],
          protected: !!overrides[f]
        }))
    : []
  const item: CampusPreviewItem = {
    key: digest([s.account_id, s.course_id, s.id]),
    course_title: s.course_title,
    title: s.title,
    due_at: s.due_at,
    submitted: s.submitted,
    kind:
      a?.deleted_at != null
        ? 'trash'
        : !a
          ? 'new'
          : existing?.source_revision !== digest(s) || changes.length
            ? 'update'
            : 'unchanged',
    changes
  }
  return {
    source: s,
    subject_id: course.subject_id,
    course_revision: course.revision,
    expected: a?.revision ?? null,
    item
  }
}
function fingerprint(entries: Entry[]): string {
  return digest(
    entries.map((e) => {
      const current = entry(e.source)
      return [
        current.expected,
        current.course_revision,
        sourceRow(e.source)?.source_revision ?? null,
        sourceRow(e.source)?.overrides_json ?? null
      ]
    })
  )
}
export function buildCampusTicket(
  sources: CampusSource[],
  failures: string[]
): CampusTicket {
  const unique = new Map<string, CampusSource>()
  for (const s of sources) {
    const key = digest([s.account_id, s.course_id, s.id]),
      old = unique.get(key)
    if (old && digest(old) !== digest(s))
      throw Error('学校返回了冲突的作业记录，请稍后重试')
    unique.set(key, s)
  }
  if (unique.size > 2000) throw Error('作业过多，请减少所选课程')
  const entries = [...unique.values()].map(entry)
  return {
    preview: { token: nanoid(), items: entries.map((e) => e.item), failures },
    entries,
    fingerprint: fingerprint(entries)
  }
}
export function applyCampusTicket(
  ticket: CampusTicket,
  input: CampusApply
): { created: number; updated: number; skipped: number } {
  const db = getDb()
  return db.transaction(() => {
    if (
      input.token !== ticket.preview.token ||
      ticket.fingerprint !== fingerprint(ticket.entries)
    )
      throw Error('预览后作业或课程已变化，请重新预览；尚未导入')
    const keys = new Set(input.keys),
      known = new Set(ticket.entries.map((e) => e.item.key))
    if (keys.size !== input.keys.length || [...keys].some((k) => !known.has(k)))
      throw Error('所选作业不正确')
    const adopted = new Map<string, CampusField[]>()
    for (const a of input.adopt) {
      if (
        !keys.has(a.key) ||
        adopted.has(a.key) ||
        a.fields.some((f) => !fields.includes(f))
      )
        throw Error('覆盖选择不正确')
      adopted.set(a.key, a.fields)
    }
    const result = { created: 0, updated: 0, skipped: 0 }
    for (const e of ticket.entries) {
      if (!keys.has(e.item.key) || e.item.kind === 'trash') {
        result.skipped++
        continue
      }
      const old = sourceRow(e.source),
        a = old ? getAssignment(old.assignment_id) : null
      const overrides = JSON.parse(old?.overrides_json ?? '{}') as Partial<
        Record<CampusField, number>
      >
      for (const f of adopted.get(e.item.key) ?? []) delete overrides[f]
      const chosen = (f: CampusField) => !overrides[f]
      if (a)
        db.prepare(
          "UPDATE assignment_links SET mutation_origin='campus' WHERE assignment_id=?"
        ).run(a.id)
      const values = {
        title: a && !chosen('title') ? a.task.title : e.source.title,
        due_at: a && !chosen('due_at') ? a.task.due_at : e.source.due_at,
        subject_id: a && !chosen('subject_id') ? a.subject_id : e.subject_id
      }
      const changed =
        !a ||
        a.task.title !== values.title ||
        a.task.due_at !== values.due_at ||
        a.subject_id !== values.subject_id
      const saved = changed
        ? saveAssignment({
            ...values,
            id: a?.id,
            expected_revision: a?.revision,
            detail: a?.task.detail ?? '',
            status: a?.task.status ?? 'open',
            blocked_reason: a?.task.blocked_reason ?? ''
          })
        : a!
      const revision = digest(e.source),
        now = Date.now()
      db.prepare("UPDATE assignments SET source='campus' WHERE id=?").run(
        saved.id
      )
      db.prepare(
        'INSERT INTO campus_sources(account_id,course_id,homework_id,assignment_id,source_json,source_revision,overrides_json,synced_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,course_id,homework_id) DO UPDATE SET source_json=excluded.source_json,source_revision=excluded.source_revision,overrides_json=excluded.overrides_json,synced_at=excluded.synced_at'
      ).run(
        e.source.account_id,
        e.source.course_id,
        e.source.id,
        saved.id,
        JSON.stringify(e.source),
        revision,
        JSON.stringify(overrides),
        now
      )
      db.prepare(
        'INSERT OR IGNORE INTO campus_source_versions VALUES(?,?,?,?,?)'
      ).run(nanoid(), saved.id, revision, JSON.stringify(e.source), now)
      if (
        !old ||
        old.source_revision !== revision ||
        changed ||
        JSON.stringify(overrides) !== old.overrides_json
      ) {
        db.prepare('INSERT INTO assignment_history VALUES(?,?,?,?,?,?)').run(
          nanoid(),
          saved.id,
          'campus-sync',
          old?.source_json ?? null,
          JSON.stringify(e.source),
          now
        )
        // Source-only changes also invalidate an already open local editor.
        db.prepare(
          'UPDATE assignment_links SET revision=? WHERE assignment_id=?'
        ).run(nanoid(), saved.id)
      }
      db.prepare(
        "UPDATE assignment_links SET mutation_origin='local' WHERE assignment_id=?"
      ).run(saved.id)
      if (!a) result.created++
      else if (changed || old?.source_revision !== revision) result.updated++
      else result.skipped++
    }
    return result
  })()
}
export function campusProvenance(id: string): CampusProvenance | null {
  const row = getDb()
    .prepare(
      'SELECT source_json,overrides_json FROM campus_sources WHERE assignment_id=?'
    )
    .get(id) as { source_json: string; overrides_json: string } | undefined
  if (!row) return null
  const count = getDb()
    .prepare(
      'SELECT count(*) AS n FROM campus_source_versions WHERE assignment_id=?'
    )
    .get(id) as { n: number }
  return {
    current: JSON.parse(row.source_json),
    versions: count.n,
    overrides: Object.keys(JSON.parse(row.overrides_json)) as CampusField[]
  }
}
