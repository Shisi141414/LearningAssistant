import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { addEvidence, createConceptWithEvidence, listEvidence, removeEvidence } from '../services/evidence'

export function registerEvidenceIpc(): void {
  ipcMain.handle(IPC.EvidenceAdd, (_event, input) => handleResult(() => addEvidence(input)))
  ipcMain.handle(IPC.EvidenceCreateConcept, (_event, input) => handleResult(() => createConceptWithEvidence(input)))
  ipcMain.handle(IPC.EvidenceList, (_event, input) => handleResult(() => listEvidence(input)))
  ipcMain.handle(IPC.EvidenceRemove, (_event, id) => handleResult(() => removeEvidence(id)))
}
