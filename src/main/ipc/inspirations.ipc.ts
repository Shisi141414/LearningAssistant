/**
 * ipc/inspirations.ipc.ts —— 灵感库
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { Inspiration, InspirationInput, ID } from '@shared/types'
import { getDb } from '../services/db'
import { handleResult } from './helpers'
import { nanoid } from 'nanoid'

interface Row {
  id: string
  subject_id: string | null
  content: string
  context_text: string
  created_at: number
}

const rowToInspiration = (r: Row): Inspiration => ({ ...r })

export function registerInspirationsIpc(): void {
  ipcMain.handle(IPC.InspirationsList, () =>
    handleResult(() => {
      const rows = getDb().prepare('SELECT * FROM inspirations ORDER BY created_at DESC').all() as Row[]
      return rows.map(rowToInspiration)
    })
  )

  ipcMain.handle(IPC.InspirationsAdd, (_e, input: InspirationInput) =>
    handleResult(() => {
      const ins: Inspiration = {
        id: nanoid(),
        subject_id: input.subject_id ?? null,
        content: input.content,
        context_text: input.context_text ?? '',
        created_at: Date.now()
      }
      getDb().prepare('INSERT INTO inspirations (id, subject_id, content, context_text, created_at) VALUES (?, ?, ?, ?, ?)').run(
        ins.id, ins.subject_id, ins.content, ins.context_text, ins.created_at
      )
      return ins
    })
  )

  ipcMain.handle(IPC.InspirationsRemove, (_e, id: ID) =>
    handleResult(() => {
      getDb().prepare('DELETE FROM inspirations WHERE id = ?').run(id)
      return true
    })
  )
}
