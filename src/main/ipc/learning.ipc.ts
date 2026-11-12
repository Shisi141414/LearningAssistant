import { IPC } from '@shared/ipc-channels'
import { dialog } from 'electron'
import { exportLearningPackage, cancelLearningPackageExport } from '../services/learning-package-export'
import { exportLearningPdf, cancelLearningPdf, learningPdfSnapshot } from '../services/learning-pdf'
import { previewLearningPackage, confirmLearningPackage, cancelLearningPackageImport } from '../services/learning-package-import'
import { ipcMain, handleResult } from './helpers'
import { changeLearningDocument, getLearningDocument, prepareLearningDocument } from '../services/learning-documents'
import { prepareLearningAssets, cancelLearningAssets, cropLearningPdfAsset } from '../services/learning-assets'
import { applyLearningSuggestion, cancelLearningSuggestion, dismissLearningSuggestion, learningSuggestionDetail, listLearningSuggestions, startLearningSuggestion } from '../services/learning-suggestions'

export function registerLearningIpc(): void {
  ipcMain.handle(IPC.LearningPdfCancel, event => handleResult(() => cancelLearningPdf(event.sender.id)))
  ipcMain.handle(IPC.LearningPdfExport, (event, input) => handleResult(async () => {
    const snapshot = learningPdfSnapshot(input)
    const name = snapshot.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '学习文档'
    const chosen = await dialog.showSaveDialog({ title: '导出所选修订为 PDF', defaultPath: `${name}-修订${snapshot.revision_number}.pdf`, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    if (event.sender.isDestroyed()) throw new Error('导出窗口已关闭')
    const owner = event.sender.id, cancel = () => cancelLearningPdf(owner)
    event.sender.once('destroyed', cancel)
    try { return await exportLearningPdf(input, chosen.filePath, owner) }
    finally { event.sender.removeListener('destroyed', cancel) }
  }))
  ipcMain.handle(IPC.LearningPackagePreview, () => handleResult(async () => {
    const chosen = await dialog.showOpenDialog({ title: '导入学习文档包并预览', properties: ['openFile'], filters: [{ name: '学习文档包', extensions: ['ladoc'] }] })
    return chosen.canceled || !chosen.filePaths[0] ? null : previewLearningPackage(chosen.filePaths[0])
  }))
  ipcMain.handle(IPC.LearningPackageImport, (_e, input) => handleResult(() => confirmLearningPackage(input)))
  ipcMain.handle(IPC.LearningPackageImportCancel, () => handleResult(cancelLearningPackageImport))
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
