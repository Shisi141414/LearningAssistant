/**
 * ipc/index.ts —— IPC handler 注册总装
 */
import { registerSubjectsIpc } from './subjects.ipc'
import { registerProvidersIpc } from './providers.ipc'
import { registerNotesIpc } from './notes.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerInspirationsIpc } from './inspirations.ipc'

export function registerAllIpc(): void {
  registerSubjectsIpc()
  registerProvidersIpc()
  registerNotesIpc()
  registerChatIpc()
  registerInspirationsIpc()
}
