import { IPC } from '@shared/ipc-channels'
import { dialog } from 'electron'
import { exportLearningPackage, cancelLearningPackageExport } from '../services/learning-package-export'
import { ipcMain, handleResult } from './helpers'
import { changeLearningDocument, getLearningDocument, prepareLearningDocument } from '../services/learning-documents'
import { prepareLearningAssets, cancelLearningAssets, cropLearningPdfAsset } from '../services/learning-assets'
import { applyLearningSuggestion, cancelLearningSuggestion, dismissLearningSuggestion, learningSuggestionDetail, listLearningSuggestions, startLearningSuggestion } from '../services/learning-suggestions'

export function registerLearningIpc(): void {
  ipcMain.handle(IPC.LearningPackageExportCancel, (_e, id) => handleResult(() => cancelLearningPackageExport(id)))
  ipcMain.handle(IPC.LearningPackageExport, (_e, input) => handleResult(async () => {
    const document = getLearningDocument(input)
    if (!document) throw new Error('请先建立学习文档')
    const selected = await dialog.showSaveDialog({ title: '导出所选学习修订（含原件与附件）', defaultPath: `学习文档-${document.revision_id}.ladoc`, filters: [{ name: '学习文档包', extensions: ['ladoc'] }] })
    if (selected.canceled || !selected.filePath) return null
    return exportLearningPackage(input, selected.filePath)
  }))
  ipcMain.handle(IPC.LearningAssetsPrepare, (_e, id) => handleResult(() => prepareLearningAssets(id)))
  ipcMain.handle(IPC.LearningAssetsCancel, (_e, id) => handleResult(() => cancelLearningAssets(id)))
  ipcMain.handle(IPC.LearningAssetsCrop, (_e, input) => handleResult(() => cropLearningPdfAsset(input)))
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
