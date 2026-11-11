/**
 * ipc/subjects.ipc.ts —— 学科 CRUD
 */
import { IPC } from '@shared/ipc-channels'
import type { Subject, SubjectInput, ID } from '@shared/types'
import { getDb } from '../services/db'
import { ipcMain, handleResult } from './helpers'
import { nanoid } from 'nanoid'

interface SubjectRow {
  id: string
  name: string
  color: string | null
  description: string | null
  created_at: number
}

function rowToSubject(r: SubjectRow): Subject {
  return { id: r.id, name: r.name, color: r.color ?? '#64748b', description: r.description ?? '', created_at: r.created_at }
}

export function registerSubjectsIpc(): void {
  ipcMain.handle(IPC.SubjectsList, () =>
    handleResult(() => {
      const rows = getDb().prepare('SELECT * FROM subjects ORDER BY created_at').all() as SubjectRow[]
      return rows.map(rowToSubject)
    })
  )

  ipcMain.handle(IPC.SubjectsCreate, (_e, input: SubjectInput) =>
    handleResult(() => {
      const db = getDb()
      const subject: Subject = {
        id: nanoid(),
        name: input.name,
        color: input.color ?? '#64748b',
        description: input.description ?? '',
        created_at: Date.now()
      }
      db.prepare('INSERT INTO subjects (id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)').run(
        subject.id, subject.name, subject.color, subject.description, subject.created_at
      )
      return subject
    })
  )

  ipcMain.handle(IPC.SubjectsUpdate, (_e, { id, ...patch }: { id: ID } & Partial<SubjectInput>) =>
    handleResult(() => {
      const db = getDb()
      const cur = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) as SubjectRow | undefined
      if (!cur) throw new Error('学科不存在')
      const next = { ...rowToSubject(cur), ...patch }
      db.prepare('UPDATE subjects SET name = ?, color = ?, description = ? WHERE id = ?').run(
        next.name, next.color, next.description, id
      )
      return next
    })
  )

  ipcMain.handle(IPC.SubjectsRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM subjects WHERE id = ?').run(id)
      return true
    })
  )
}
