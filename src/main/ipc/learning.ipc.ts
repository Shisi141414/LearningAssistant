import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { changeLearningDocument, getLearningDocument, prepareLearningDocument } from '../services/learning-documents'

export function registerLearningIpc(): void {
  ipcMain.handle(IPC.LearningGet, (_e, input) => handleResult(() => getLearningDocument(input)))
  ipcMain.handle(IPC.LearningPrepare, (_e, id) => handleResult(() => prepareLearningDocument(id)))
  ipcMain.handle(IPC.LearningChange, (_e, input) => handleResult(() => changeLearningDocument(input)))
}
