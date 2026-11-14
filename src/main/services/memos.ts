import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type {
  MemoDetail,
  MemoInput,
  MemoPage,
  MemoReference,
  MemoRoutePlan,
  MemoRoutePreview,
  MemoSummary,
  MemoVersion
} from '@shared/memos'
import { conceptKey } from '@shared/concept-matcher'
import { getDb, dbFilePath } from './db'
import { listConcepts, saveConcept } from './concepts'
import { createTask, listAllTasks } from './projects'
import { calendarConflicts, occupiedEnd } from './calendar-conflicts'

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)])
        )
      : value
export const memoHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
function current(id: string): MemoSummary {
  const row = getDb()
    .prepare(
      'SELECT m.*,EXISTS(SELECT 1 FROM memo_routes r WHERE r.memo_id=m.id AND r.revision=m.revision AND r.undone_at IS NULL) AS routed FROM memos m WHERE m.id=?'
    )
    .get(id) as
    | (Omit<MemoSummary, 'archived' | 'routed'> & {
        archived: number
        routed: number
      })
    | undefined
  if (!row) throw new Error('备忘不存在')
  return { ...row, archived: !!row.archived, routed: !!row.routed }
}
function editable(id: string, revision: string): MemoSummary {
  const memo = current(id)
  if (memo.revision !== revision)
    throw new Error('备忘已变化，请重新载入后核对')
  if (memo.archived) throw new Error('请先从回收站恢复备忘')
  return memo
}
export function listMemos(input: {
  query: string
  archived: boolean
  offset: number
  state?: 'all' | 'inbox' | 'routed'
}): MemoPage {
  const state = input.state ?? 'all'
  const rows = getDb()
    .prepare(
      `SELECT * FROM (SELECT m.*,EXISTS(SELECT 1 FROM memo_routes r WHERE r.memo_id=m.id AND r.revision=m.revision AND r.undone_at IS NULL) AS routed FROM memos m) WHERE archived=? AND instr(lower(content),lower(?))>0 AND (?='all' OR routed=?) ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?`
    )
    .all(
      Number(input.archived),
      input.query,
      state,
      Number(state === 'routed'),
      input.offset
    ) as Array<
    Omit<MemoSummary, 'archived' | 'routed'> & {
      archived: number
      routed: number
    }
  >
  return {
    items: rows
      .slice(0, 50)
      .map((r) => ({ ...r, archived: !!r.archived, routed: !!r.routed })),
    next_offset: rows.length > 50 ? input.offset + 50 : null
  }
}
export function memoDetail(id: string): MemoDetail {
  const db = getDb(),
    memo = current(id)
  const versions = db
    .prepare(
      'SELECT id,content,subject_id,created_at,timezone FROM memo_versions WHERE memo_id=? ORDER BY created_at DESC,id'
    )
    .all(id) as MemoVersion[]
  const routes = (
    db
      .prepare(
        'SELECT id,revision,created_at,undone_at FROM memo_routes WHERE memo_id=? ORDER BY created_at DESC,id'
      )
      .all(id) as MemoDetail['routes']
  ).map((route) => ({
    ...route,
    targets: (
      db
        .prepare(
          'SELECT id,kind,COALESCE(concept_id,task_id) AS target_id,title,created FROM memo_targets WHERE route_id=? ORDER BY kind,id'
        )
        .all(route.id) as Array<
        Omit<MemoDetail['routes'][number]['targets'][number], 'created'> & {
          created: number
        }
      >
    ).map((t) => ({ ...t, created: !!t.created }))
  }))
  const recognitions = (
    db
      .prepare(
        'SELECT * FROM memo_recognitions WHERE memo_id=? ORDER BY created_at DESC,id LIMIT 20'
      )
      .all(id) as Array<
      Omit<MemoDetail['recognitions'][number], 'proposal'> & {
        proposal_json: string | null
      }
    >
  ).map(({ proposal_json, ...row }) => ({
    ...row,
    proposal: proposal_json ? JSON.parse(proposal_json) : null
  }))
  return { memo, versions, routes, recognitions }
}
export function saveMemo(input: MemoInput): MemoDetail {
  return getDb().transaction(() => {
    const db = getDb(),
      content = input.content.trim()
    if (!content || content.length > 12000 || content.includes('\0'))
      throw new Error('备忘内容应为 1–12000 个字符')
    if (
      input.subject_id &&
      !db.prepare('SELECT 1 FROM subjects WHERE id=?').get(input.subject_id)
    )
      throw new Error('学科不存在')
    if (input.id) {
      if (!input.expected_revision) throw new Error('修改备忘须指定原修订')
      const old = editable(input.id, input.expected_revision)
      if (old.content === content && old.subject_id === input.subject_id)
        return memoDetail(old.id)
    }
    const id = input.id ?? nanoid(),
      revision = nanoid(),
      now = Date.now(),
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (input.id)
      db.prepare(
        'UPDATE memos SET content=?,subject_id=?,revision=?,updated_at=? WHERE id=?'
      ).run(content, input.subject_id, revision, now, id)
    else
      db.prepare(
        'INSERT INTO memos(id,revision,subject_id,content,created_at,updated_at) VALUES(?,?,?,?,?,?)'
      ).run(id, revision, input.subject_id, content, now, now)
    db.prepare('INSERT INTO memo_versions VALUES(?,?,?,?,?,?)').run(
      revision,
      id,
      content,
      input.subject_id,
      now,
      zone
    )
    return memoDetail(id)
  })()
}
export function importInspiration(id: string): MemoDetail {
  return getDb().transaction(() => {
    const db = getDb(),
      old = db
        .prepare('SELECT id FROM memos WHERE inspiration_id=?')
        .get(id) as { id: string } | undefined
    if (old) return memoDetail(old.id)
    const source = db
      .prepare(
        'SELECT content,context_text,subject_id,created_at FROM inspirations WHERE id=?'
      )
      .get(id) as
      | {
          content: string
          context_text: string
          subject_id: string | null
          created_at: number
        }
      | undefined
    if (!source) throw new Error('灵感不存在')
    const result = saveMemo({
      content: source.content,
      subject_id: source.subject_id
    })
    db.prepare('UPDATE memos SET inspiration_id=?,created_at=? WHERE id=?').run(
      id,
      source.created_at,
      result.memo.id
    )
    // The initial version is still unpublished inside this transaction. Legacy inspirations did not record a zone.
    db.prepare(
      "UPDATE memo_versions SET created_at=?,timezone='unknown' WHERE id=?"
    ).run(source.created_at, result.memo.revision)
    return memoDetail(result.memo.id)
  })()
}
export function archiveMemo(input: {
  id: string
  expected_revision: string
  archived: boolean
}): MemoDetail {
  return getDb().transaction(() => {
    const memo = current(input.id)
    if (memo.revision !== input.expected_revision)
      throw new Error('备忘已变化，请重新载入')
    // Keep content revisions stable; archive state is checked again on every write.
    getDb()
      .prepare('UPDATE memos SET archived=?,updated_at=? WHERE id=?')
      .run(Number(input.archived), Date.now(), memo.id)
    return memoDetail(memo.id)
  })()
}
function resolvePlan(input: MemoRoutePlan) {
  const memo = editable(input.id, input.expected_revision),
    k = input.knowledge,
    t = input.task
  if (!k && !t) throw new Error('请至少选择知识或待办')
  let concept: ReturnType<typeof listConcepts>[number] | null = null
  if (k) {
    const concepts = listConcepts()
    if (k.kind === 'existing') {
      concept = concepts.find((c) => c.id === k.id) ?? null
      if (!concept || concept.revision !== k.revision)
        throw new Error('知识点已变化，请重新选择')
    } else {
      if (
        !k.name.trim() ||
        k.name.trim().length > 120 ||
        k.summary.length > 4000 ||
        !getDb().prepare('SELECT 1 FROM subjects WHERE id=?').get(k.subject_id)
      )
        throw new Error('请填写知识名称并选择已有学科')
      const matches = concepts.filter(
        (c) =>
          (c.subject_id === k.subject_id || c.subject_id === null) &&
          [c.name, ...c.aliases].some(
            (n) => conceptKey(n.trim()) === conceptKey(k.name.trim())
          )
      )
      if (matches.length > 1)
        throw new Error('存在多个同名知识点，请明确选择已有知识点')
      concept = matches[0] ?? null
    }
  }
  if (t) {
    if (
      !t.title.trim() ||
      t.title.length > 500 ||
      t.detail.length > 4000 ||
      t.location.length > 1000
    )
      throw new Error('待办名称或说明无效')
    for (const v of [t.due_at, t.planned_at, t.planned_end_at])
      if (
        v !== null &&
        (!Number.isSafeInteger(v) || v < 0 || v > 8640000000000000)
      )
        throw new Error('请输入正确日期')
    if (
      (t.planned_at === null) !== (t.planned_end_at === null) ||
      (t.planned_at !== null && t.planned_end_at! <= t.planned_at)
    )
      throw new Error('日程必须填写完整且有效的起止时间')
  }
  const tasks = listAllTasks(),
    blocks = getDb()
      .prepare(
        'SELECT b.*,t.title,t.status FROM schedule_blocks b JOIN tasks t ON b.task_id=t.id ORDER BY b.id'
      )
      .all() as {
      id: string
      start_at: number
      end_at: number
      title: string
      status: string
    }[]
  const incoming =
    t?.planned_at !== null && t?.planned_at !== undefined
      ? [
          {
            key: 'memo',
            title: t.title,
            start: t.planned_at,
            end: t.planned_end_at!
          }
        ]
      : []
  const conflicts = calendarConflicts(incoming, [
    ...tasks
      .filter((t) => t.status !== 'done' && t.planned_at !== null)
      .map((t) => ({
        key: t.id,
        title: t.title,
        start: t.planned_at!,
        end: occupiedEnd(t.planned_at!, t.planned_end_at, t.all_day)
      })),
    ...blocks
      .filter((b) => b.status !== 'done')
      .map((b) => ({
        key: b.id,
        title: b.title,
        start: b.start_at,
        end: b.end_at
      }))
  ])
  const key = memoHash(input),
    duplicate = getDb()
      .prepare('SELECT id FROM memo_routes WHERE request_key=?')
      .get(key) as { id: string } | undefined
  const preview: MemoRoutePreview = {
    fingerprint: memoHash([dbFilePath(), memo, input, concept, tasks, blocks]),
    conflicts,
    existing_concept_id: concept?.id ?? null,
    duplicate_route_id: duplicate?.id ?? null
  }
  return { memo, concept, key, preview }
}
export function previewMemoRoute(input: MemoRoutePlan): MemoRoutePreview {
  return resolvePlan(input).preview
}
export function applyMemoRoute(input: {
  plan: MemoRoutePlan
  fingerprint: string
  ignore_conflicts: boolean
}): MemoDetail {
  return getDb().transaction(() => {
    const db = getDb(),
      { memo, concept, key, preview } = resolvePlan(input.plan)
    if (preview.duplicate_route_id) return memoDetail(memo.id)
    if (preview.fingerprint !== input.fingerprint)
      throw new Error('备忘、知识或日程已变化，请重新检查；输入已保留')
    if (preview.conflicts.items.length && !input.ignore_conflicts)
      throw new Error('存在时间冲突，请核对后明确忽略')
    const route = nanoid(),
      now = Date.now(),
      k = input.plan.knowledge,
      t = input.plan.task
    db.prepare(
      'INSERT INTO memo_routes(id,memo_id,revision,request_key,decision_json,created_at) VALUES(?,?,?,?,?,?)'
    ).run(route, memo.id, memo.revision, key, JSON.stringify(input), now)
    const insert = db.prepare(
      'INSERT INTO memo_targets VALUES(?,?,?,?,?,?,?,?)'
    )
    let knowledge = concept
    if (k) {
      if (!knowledge && k.kind === 'new')
        knowledge = saveConcept({
          subject_id: k.subject_id,
          name: k.name,
          summary: k.summary,
          aliases: []
        })
      insert.run(
        nanoid(),
        route,
        'concept',
        knowledge!.id,
        null,
        knowledge!.name,
        Number(!concept),
        JSON.stringify(knowledge)
      )
    }
    if (t) {
      const task = createTask({
        ...t,
        kind: 'manual',
        knowledge_refs: knowledge
          ? [{ concept_id: knowledge.id, why: '来自同一备忘的知识与待办' }]
          : []
      })
      insert.run(
        nanoid(),
        route,
        'task',
        null,
        task.id,
        task.title,
        1,
        JSON.stringify(task)
      )
    }
    return memoDetail(memo.id)
  })()
}
export function undoMemoRoute(id: string): MemoDetail {
  return getDb().transaction(() => {
    const db = getDb(),
      route = db.prepare('SELECT * FROM memo_routes WHERE id=?').get(id) as
        | { memo_id: string; undone_at: number | null }
        | undefined
    if (!route) throw new Error('归档记录不存在')
    if (route.undone_at !== null) return memoDetail(route.memo_id)
    const targets = db
      .prepare(
        "SELECT task_id,snapshot_json FROM memo_targets WHERE route_id=? AND kind='task'"
      )
      .all(id) as { task_id: string | null; snapshot_json: string }[]
    for (const t of targets) {
      if (!t.task_id) continue
      const row = db
        .prepare('SELECT * FROM tasks WHERE id=?')
        .get(t.task_id) as Record<string, unknown> | undefined
      if (!row) continue
      const before = JSON.parse(t.snapshot_json),
        after = { ...row, all_day: !!row.all_day }
      if (memoHash(before) !== memoHash(after))
        throw new Error('待办已被编辑或完成，撤销不会删除它；请先在日程中核对')
      for (const [table, column] of [
        ['schedule_blocks', 'task_id'],
        ['task_resource_links', 'task_id'],
        ['task_planning', 'task_id'],
        ['task_dependencies', 'task_id'],
        ['task_dependencies', 'depends_on_id']
      ] as const)
        if (
          db
            .prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`)
            .get(t.task_id)
        )
          throw new Error(
            '待办已有排程或关联资料，不能直接撤销；请先在日程中处理'
          )
      db.prepare('DELETE FROM tasks WHERE id=?').run(t.task_id)
    }
    db.prepare('UPDATE memo_routes SET undone_at=? WHERE id=?').run(
      Date.now(),
      id
    )
    // Knowledge is shared. Even a newly created concept survives undo; only this memo link is removed.
    return memoDetail(route.memo_id)
  })()
}
export function memoReferences(input: {
  kind: 'concept' | 'task'
  id: string
}): MemoReference[] {
  const column = input.kind === 'concept' ? 'concept_id' : 'task_id'
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT m.id AS memo_id,r.revision,v.content,m.archived,r.created_at FROM memo_targets t JOIN memo_routes r ON r.id=t.route_id JOIN memos m ON m.id=r.memo_id JOIN memo_versions v ON v.id=r.revision WHERE t.${column}=? AND r.undone_at IS NULL ORDER BY r.created_at DESC LIMIT 100`
      )
      .all(input.id) as Array<
      Omit<MemoReference, 'archived'> & { archived: number }
    >
  ).map((r) => ({ ...r, archived: !!r.archived }))
}
