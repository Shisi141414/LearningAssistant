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
import { registerDiagnosticsIpc } from './diagnostics.ipc'
import { registerMaterialsIpc } from './materials.ipc'
import { registerConceptsIpc } from './concepts.ipc'
import { registerLearningIpc } from './learning.ipc'
import { registerEvidenceIpc } from './evidence.ipc'
import { registerKnowledgeSuggestionsIpc } from './knowledge-suggestions.ipc'
import { registerProjectsIpc } from './projects.ipc'

export function registerAllIpc(): void {
  registerKnowledgeSuggestionsIpc()
  registerEvidenceIpc()
  registerLearningIpc()
  registerSubjectsIpc()
  registerActivitiesIpc()
  registerProvidersIpc()
  registerNotesIpc()
  registerChatIpc()
  registerInspirationsIpc()
  registerClassroomIpc()
  registerConfigIpc()
  registerDiagnosticsIpc()
  registerMaterialsIpc()
  registerConceptsIpc()
  registerProjectsIpc()
}
