/**
 * ipc/projects.ipc.ts —— R4 项目管理 IPC（载荷校验见 services/security.ts）
 */
import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import { listProjects, createProject, updateProject, removeProject, projectDetail, createMilestone, updateMilestone, removeMilestone, createTask, updateTask, removeTask, listManualTasks, listAllTasks } from '../services/projects'

export function registerProjectsIpc(): void {
  ipcMain.handle(IPC.ProjectsList, (_e, subjectId?: string) => handleResult(() => listProjects(subjectId ?? null)))
  ipcMain.handle(IPC.ProjectsCreate, (_e, input) => handleResult(() => createProject(input)))
  ipcMain.handle(IPC.ProjectsUpdate, (_e, input: { id: string } & Record<string, unknown>) =>
    handleResult(() => {
      const { id, ...patch } = input
      return updateProject(id, patch as Parameters<typeof updateProject>[1])
    })
  )
  ipcMain.handle(IPC.ProjectsRemove, (_e, id: string) => handleResult(() => {
    removeProject(id)
    return true
  }))
  ipcMain.handle(IPC.ProjectsDetail, (_e, id: string) => handleResult(() => projectDetail(id)))

  ipcMain.handle(IPC.MilestonesCreate, (_e, input) => handleResult(() => createMilestone(input)))
  ipcMain.handle(IPC.MilestonesUpdate, (_e, input: { id: string } & Record<string, unknown>) =>
    handleResult(() => {
      const { id, ...patch } = input
      return updateMilestone(id, patch as Parameters<typeof updateMilestone>[1])
    })
  )
  ipcMain.handle(IPC.MilestonesRemove, (_e, id: string) => handleResult(() => {
    removeMilestone(id)
    return true
  }))

  ipcMain.handle(IPC.TasksCreate, (_e, input) => handleResult(() => createTask(input)))
  ipcMain.handle(IPC.TasksUpdate, (_e, input: { id: string } & Record<string, unknown>) =>
    handleResult(() => {
      const { id, ...patch } = input
      return updateTask(id, patch as Parameters<typeof updateTask>[1])
    })
  )
  ipcMain.handle(IPC.TasksRemove, (_e, id: string) => handleResult(() => {
    removeTask(id)
    return true
  }))
  ipcMain.handle(IPC.TasksListManual, () => handleResult(() => listManualTasks()))
  ipcMain.handle(IPC.TasksListAll, () => handleResult(() => listAllTasks()))
}
