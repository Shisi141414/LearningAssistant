/**
 * ipc/activities.ipc.ts —— 活动（讲座/会议/讨论）管理，ADR-5
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { Activity, ActivityInput, ActivityKind, ID } from '@shared/types'
import { getDb } from '../services/db'
import { handleResult } from './helpers'
import { nanoid } from 'nanoid'

interface ActivityRow {
  id: string
  title: string
  kind: ActivityKind
  happened_at: number | null
  subject_id: string | null
  description: string | null
  created_at: number
  notes_count?: number
}

function rowToActivity(r: ActivityRow): Activity {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    happened_at: r.happened_at,
    subject_id: r.subject_id,
    description: r.description ?? '',
    created_at: r.created_at,
    ...(r.notes_count !== undefined ? { notes_count: r.notes_count } : {})
  }
}

const SELECT_WITH_COUNT = `
  SELECT a.*, (SELECT COUNT(*) FROM notes n WHERE n.activity_id = a.id) AS notes_count
  FROM activities a
`

export function registerActivitiesIpc(): void {
  /** 列表：按举行时间倒序（无时间按创建时间），可按 kind / subject 过滤 */
  ipcMain.handle(IPC.ActivitiesList, (_e, filter?: { kind?: ActivityKind; subject_id?: ID }) =>
    handleResult(() => {
      const db = getDb()
      const where: string[] = []
      const params: unknown[] = []
      if (filter?.kind) {
        where.push('a.kind = ?')
        params.push(filter.kind)
      }
      if (filter?.subject_id) {
        where.push('a.subject_id = ?')
        params.push(filter.subject_id)
      }
      const sql =
        SELECT_WITH_COUNT +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY COALESCE(a.happened_at, a.created_at) DESC'
      const rows = db.prepare(sql).all(...params) as ActivityRow[]
      return rows.map(rowToActivity)
    })
  )

  ipcMain.handle(IPC.ActivitiesCreate, (_e, input: ActivityInput) =>
    handleResult(() => {
      const db = getDb()
      const a: Activity = {
        id: nanoid(),
        title: input.title,
        kind: input.kind ?? 'lecture',
        happened_at: input.happened_at ?? null,
        subject_id: input.subject_id ?? null,
        description: input.description ?? '',
        created_at: Date.now()
      }
      db.prepare('INSERT INTO activities (id, title, kind, happened_at, subject_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        a.id, a.title, a.kind, a.happened_at, a.subject_id, a.description, a.created_at
      )
      return a
    })
  )

  ipcMain.handle(IPC.ActivitiesUpdate, (_e, { id, ...patch }: { id: ID } & Partial<ActivityInput>) =>
    handleResult(() => {
      const db = getDb()
      const cur = db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as ActivityRow | undefined
      if (!cur) throw new Error('活动不存在')
      const next: Activity = {
        ...rowToActivity(cur),
        ...patch,
        happened_at: patch.happened_at !== undefined ? patch.happened_at : cur.happened_at,
        subject_id: patch.subject_id !== undefined ? patch.subject_id : cur.subject_id
      }
      db.prepare('UPDATE activities SET title = ?, kind = ?, happened_at = ?, subject_id = ?, description = ? WHERE id = ?').run(
        next.title, next.kind, next.happened_at, next.subject_id, next.description, id
      )
      return next
    })
  )

  ipcMain.handle(IPC.ActivitiesRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM activities WHERE id = ?').run(id) // 挂载笔记的 activity_id 置 NULL（SET NULL）
      return true
    })
  )
}
