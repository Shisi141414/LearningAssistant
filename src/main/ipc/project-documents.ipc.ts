import { IPC } from '@shared/ipc-channels'
import { handleResult, ipcMain } from './helpers'
import {
  listProjectDocuments,
  getProjectDocument,
  saveProjectDocument,
  changeProjectDocument,
  restoreProjectDocumentRevision,
  trashProjectDocument,
  importProjectDocument
} from '../services/project-documents'

export function registerProjectDocumentsIpc(): void {
  ipcMain.handle(IPC.ProjectDocumentsList, (_e, input) =>
    handleResult(() => listProjectDocuments(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsGet, (_e, input) =>
    handleResult(() => getProjectDocument(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsSave, (_e, input) =>
    handleResult(() => saveProjectDocument(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsChange, (_e, input) =>
    handleResult(() => changeProjectDocument(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsRevisionRestore, (_e, input) =>
    handleResult(() => restoreProjectDocumentRevision(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsTrash, (_e, input) =>
    handleResult(() => trashProjectDocument(input))
  )
  ipcMain.handle(IPC.ProjectDocumentsRestore, (_e, input) =>
    handleResult(() => trashProjectDocument(input, true))
  )
  ipcMain.handle(IPC.ProjectDocumentsImport, (_e, input) =>
    handleResult(() => importProjectDocument(input))
  )
}
