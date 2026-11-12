import { dialog, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { MaterialInput } from '@shared/types'
import { ipcMain, handleResult } from './helpers'
import { archiveMaterial, cancelMaterial, importMaterial, listMaterials, materialBlocks, materialDetail, materialPath, retryMaterial, startMaterialOcr } from '../services/materials'
import { locateMaterial, materialAnchor, materialNoteRefs } from '../services/classroom-materials'
import { correctOcrPage, materialOcrPage } from '../services/material-derivations'
import { ocrModelsStatus, prepareOcrModels } from '../services/ocr-models'
import { ppocrStatus, preparePpocrModel } from '../services/ppocr-models'
import { pix2textStatus } from '../services/pix2text'
import { configureOfficeConverter, convertedMaterialFile, officeConverterStatus } from '../services/office-conversions'

export function registerMaterialsIpc(): void {
  ipcMain.handle(IPC.MaterialsConverterStatus, () => handleResult(officeConverterStatus))
  ipcMain.handle(IPC.MaterialsConverterAuto, () => handleResult(() => configureOfficeConverter(null)))
  ipcMain.handle(IPC.MaterialsConverterPick, () => handleResult(async () => {
    const selected = await dialog.showOpenDialog({ title: '选择 LibreOffice program 目录的 soffice 程序', properties: ['openFile'] })
    return selected.canceled || !selected.filePaths[0] ? officeConverterStatus() : configureOfficeConverter(selected.filePaths[0])
  }))
  ipcMain.handle(IPC.MaterialsOpenConverted, (_e, id: string) => handleResult(async () => {
    const error = await shell.openPath(convertedMaterialFile(id).file)
    if (error) throw new Error(error)
    return true
  }))
  ipcMain.handle(IPC.MaterialsOcrModels, () => handleResult(ocrModelsStatus))
  ipcMain.handle(IPC.MaterialsOcrPrepare, () => handleResult(prepareOcrModels))
  ipcMain.handle(IPC.MaterialsPpocrStatus, () => handleResult(() => ppocrStatus()))
  ipcMain.handle(IPC.MaterialsPpocrPrepare, (_e, preset: string) => handleResult(() => preparePpocrModel(preset)))
  ipcMain.handle(IPC.MaterialsPix2textStatus, () => handleResult(() => pix2textStatus()))
  ipcMain.handle(IPC.MaterialsOcrStart, (_e, input) => handleResult(() => startMaterialOcr(input)))
  ipcMain.handle(IPC.MaterialsOcrPage, (_e, input) => handleResult(() => materialOcrPage(input)))
  ipcMain.handle(IPC.MaterialsOcrCorrect, (_e, input) => handleResult(() => correctOcrPage(input)))
  ipcMain.handle(IPC.MaterialsAnchor, (_e, id: string) => handleResult(() => materialAnchor(id)))
  ipcMain.handle(IPC.MaterialsLocate, (_e, input) => handleResult(() => locateMaterial(input)))
  ipcMain.handle(IPC.MaterialsReferences, (_e, id: string) => handleResult(() => materialNoteRefs(id)))
  ipcMain.handle(IPC.MaterialsList, (_e, subjectId?: string) => handleResult(() => listMaterials(subjectId)))
  ipcMain.handle(IPC.MaterialsGet, (_e, id: string) => handleResult(() => materialDetail(id)))
  ipcMain.handle(IPC.MaterialsBlocks, (_e, input) => handleResult(() => materialBlocks(input)))
  ipcMain.handle(IPC.MaterialsCancel, (_e, id: string) => handleResult(() => cancelMaterial(id)))
  ipcMain.handle(IPC.MaterialsRetry, (_e, id: string) => handleResult(() => retryMaterial(id)))
  ipcMain.handle(IPC.MaterialsArchive, (_e, id: string) => handleResult(() => archiveMaterial(id)))
  ipcMain.handle(IPC.MaterialsOpen, (_e, id: string) => handleResult(async () => {
    const error = await shell.openPath(await materialPath(id))
    if (error) throw new Error(error)
    return true
  }))
  ipcMain.handle(IPC.MaterialsImport, (_e, input: MaterialInput) => handleResult(async () => {
    const chosen = await dialog.showOpenDialog({ title: input.material_id ? '为材料导入新版本' : '导入学习材料', properties: ['openFile'], filters: [{ name: '学习材料（PDF / Word / PPT）', extensions: ['pdf', 'docx', 'pptx', 'doc', 'ppt'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return importMaterial(input, chosen.filePaths[0])
  }))
}
