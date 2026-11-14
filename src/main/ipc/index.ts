import { registerCampusIpc } from './campus.ipc'
import { registerAssignmentsIpc } from './assignments.ipc'
import { registerReviewsIpc } from './reviews.ipc'
import { registerMemosIpc } from './memos.ipc'
/**
 * ipc/index.ts —— IPC handler 注册总装
 */
import { registerTaskResourcesIpc } from './task-resources.ipc'
import { registerAutoScheduleIpc } from './auto-schedule.ipc'
import { registerRemindersIpc } from './reminders.ipc'
import { registerProjectDocumentsIpc } from './project-documents.ipc'
import { registerCalendarIpc } from './calendar.ipc'
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
import { registerExercisesIpc } from './exercises.ipc'

export function registerAllIpc(): void {
  registerCampusIpc()
  registerAssignmentsIpc()
  registerReviewsIpc()
  registerMemosIpc()
  registerAutoScheduleIpc()
  registerRemindersIpc()
  registerTaskResourcesIpc()
  registerProjectDocumentsIpc()
  registerExercisesIpc()
  registerCalendarIpc()
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
