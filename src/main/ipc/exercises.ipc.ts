import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { previewExerciseSet, importExerciseSet, discardExerciseSet } from '../services/exercise-sets'
import {
  getExercise,
  listExercises,
  saveExercise,
  importExercise,
  trashExercise
} from '../services/exercises'

export function registerExercisesIpc(): void {
  ipcMain.handle(IPC.ExerciseSetsPreview, (event, versionId) => handleResult(() => previewExerciseSet(event.sender.id, versionId)))
  ipcMain.handle(IPC.ExerciseSetsImport, (event, input) => handleResult(() => importExerciseSet(event.sender.id, input)))
  ipcMain.handle(IPC.ExerciseSetsDiscard, (event) => handleResult(() => discardExerciseSet(event.sender.id)))
  ipcMain.handle(IPC.ExercisesList, (_e, input) => handleResult(() => listExercises(input)))
  ipcMain.handle(IPC.ExercisesGet, (_e, input) => handleResult(() => getExercise(input)))
  ipcMain.handle(IPC.ExercisesSave, (_e, input) => handleResult(() => saveExercise(input)))
  ipcMain.handle(IPC.ExercisesImport, (_e, input) => handleResult(() => importExercise(input)))
  ipcMain.handle(IPC.ExercisesTrash, (_e, input) => handleResult(() => trashExercise(input)))
  ipcMain.handle(IPC.ExercisesRestore, (_e, input) =>
    handleResult(() => trashExercise(input, true))
  )
}
