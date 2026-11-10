/**
 * ipc/index.ts —— IPC handler 注册总装
 */
import { registerSubjectsIpc } from './subjects.ipc'
import { registerActivitiesIpc } from './activities.ipc'
import { registerProvidersIpc } from './providers.ipc'
import { registerNotesIpc } from './notes.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerInspirationsIpc } from './inspirations.ipc'
import { registerClassroomIpc } from './classroom.ipc'
import { registerConfigIpc } from './config.ipc'

export function registerAllIpc(): void {
  registerSubjectsIpc()
  registerActivitiesIpc()
  registerProvidersIpc()
  registerNotesIpc()
  registerChatIpc()
  registerInspirationsIpc()
  registerClassroomIpc()
  registerConfigIpc()
}
