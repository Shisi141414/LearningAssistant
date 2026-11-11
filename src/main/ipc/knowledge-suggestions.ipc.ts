import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { startKnowledgeSuggestion, listKnowledgeSuggestions, knowledgeSuggestionDetail, cancelKnowledgeSuggestion, dismissKnowledgeSuggestion, adoptKnowledgeSuggestion } from '../services/knowledge-suggestions'

export function registerKnowledgeSuggestionsIpc(): void {
  ipcMain.handle(IPC.KnowledgeSuggestStart, (_event, input) => handleResult(() => startKnowledgeSuggestion(input)))
  ipcMain.handle(IPC.KnowledgeSuggestList, (_event, source) => handleResult(() => listKnowledgeSuggestions(source)))
  ipcMain.handle(IPC.KnowledgeSuggestGet, (_event, id) => handleResult(() => knowledgeSuggestionDetail(id)))
  ipcMain.handle(IPC.KnowledgeSuggestCancel, (_event, id) => handleResult(() => cancelKnowledgeSuggestion(id)))
  ipcMain.handle(IPC.KnowledgeSuggestDismiss, (_event, id) => handleResult(() => dismissKnowledgeSuggestion(id)))
  ipcMain.handle(IPC.KnowledgeSuggestAdopt, (_event, input) => handleResult(() => adoptKnowledgeSuggestion(input)))
}
