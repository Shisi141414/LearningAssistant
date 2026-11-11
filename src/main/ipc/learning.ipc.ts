import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { changeLearningDocument, getLearningDocument, prepareLearningDocument } from '../services/learning-documents'
import { applyLearningSuggestion, cancelLearningSuggestion, dismissLearningSuggestion, learningSuggestionDetail, listLearningSuggestions, startLearningSuggestion } from '../services/learning-suggestions'

export function registerLearningIpc(): void {
  ipcMain.handle(IPC.LearningSuggestStart, (_e, input) => handleResult(() => startLearningSuggestion(input)))
  ipcMain.handle(IPC.LearningSuggestList, (_e, id) => handleResult(() => listLearningSuggestions(id)))
  ipcMain.handle(IPC.LearningSuggestGet, (_e, id) => handleResult(() => learningSuggestionDetail(id)))
  ipcMain.handle(IPC.LearningSuggestCancel, (_e, id) => handleResult(() => cancelLearningSuggestion(id)))
  ipcMain.handle(IPC.LearningSuggestDismiss, (_e, id) => handleResult(() => dismissLearningSuggestion(id)))
  ipcMain.handle(IPC.LearningSuggestApply, (_e, id) => handleResult(() => applyLearningSuggestion(id)))
  ipcMain.handle(IPC.LearningGet, (_e, input) => handleResult(() => getLearningDocument(input)))
  ipcMain.handle(IPC.LearningPrepare, (_e, id) => handleResult(() => prepareLearningDocument(id)))
  ipcMain.handle(IPC.LearningChange, (_e, input) => handleResult(() => changeLearningDocument(input)))
}
