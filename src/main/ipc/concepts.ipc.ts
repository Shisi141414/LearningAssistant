import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { listConcepts, saveConcept, conceptReferences } from '../services/concepts'
import { knowledgeGraph, saveConceptRelation, removeConceptRelation, saveConceptPositions, conceptUsage } from '../services/knowledge-graph'

export function registerConceptsIpc(): void {
  ipcMain.handle(IPC.ConceptsGraph, () => handleResult(() => knowledgeGraph()))
  ipcMain.handle(IPC.ConceptsRelationSave, (_e, input) => handleResult(() => saveConceptRelation(input)))
  ipcMain.handle(IPC.ConceptsRelationRemove, (_e, input) => handleResult(() => removeConceptRelation(input)))
  ipcMain.handle(IPC.ConceptsPositions, (_e, input) => handleResult(() => saveConceptPositions(input)))
  ipcMain.handle(IPC.ConceptsUsage, (_e, input) => handleResult(() => conceptUsage(input)))
  ipcMain.handle(IPC.ConceptsList, () => handleResult(() => listConcepts()))
  ipcMain.handle(IPC.ConceptsSave, (_e, input) => handleResult(() => saveConcept(input)))
  ipcMain.handle(IPC.ConceptsReferences, (_e, input) => handleResult(() => conceptReferences(input)))
}
