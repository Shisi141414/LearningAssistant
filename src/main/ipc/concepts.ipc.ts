import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { listConcepts, saveConcept, conceptReferences } from '../services/concepts'

export function registerConceptsIpc(): void {
  ipcMain.handle(IPC.ConceptsList, () => handleResult(() => listConcepts()))
  ipcMain.handle(IPC.ConceptsSave, (_e, input) => handleResult(() => saveConcept(input)))
  ipcMain.handle(IPC.ConceptsReferences, (_e, input) => handleResult(() => conceptReferences(input)))
}
