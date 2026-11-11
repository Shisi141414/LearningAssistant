import { dialog, shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { MaterialInput } from '@shared/types'
import { ipcMain, handleResult } from './helpers'
import { archiveMaterial, cancelMaterial, importMaterial, listMaterials, materialBlocks, materialDetail, materialPath, retryMaterial } from '../services/materials'
import { locateMaterial, materialAnchor, materialNoteRefs } from '../services/classroom-materials'

export function registerMaterialsIpc(): void {
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
    const chosen = await dialog.showOpenDialog({ title: input.material_id ? '为材料导入新版本' : '导入学习材料', properties: ['openFile'], filters: [{ name: '学习材料（PDF / Word / PPT）', extensions: ['pdf', 'docx', 'pptx'] }] })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return importMaterial(input, chosen.filePaths[0])
  }))
}
