import {
  reviewPlanningState,
  saveReviewPlanning
} from '../services/review-planning'
import { IPC } from '@shared/ipc-channels'
import { ipcMain, handleResult } from './helpers'
import {
  addReview,
  listReviews,
  getReview,
  revealReview,
  gradeReview,
  actOnReview
} from '../services/reviews'
export function registerReviewsIpc(): void {
  ipcMain.handle(IPC.ReviewPlanningGet, (_e, id) =>
    handleResult(() => reviewPlanningState(id))
  )
  ipcMain.handle(IPC.ReviewPlanningSave, (_e, input) =>
    handleResult(() => saveReviewPlanning(input))
  )
  ipcMain.handle(IPC.ReviewsAdd, (_e, input) =>
    handleResult(() => addReview(input))
  )
  ipcMain.handle(IPC.ReviewsList, (_e, input) =>
    handleResult(() => listReviews(input))
  )
  ipcMain.handle(IPC.ReviewsGet, (_e, id) => handleResult(() => getReview(id)))
  ipcMain.handle(IPC.ReviewsReveal, (_e, input) =>
    handleResult(() => revealReview(input))
  )
  ipcMain.handle(IPC.ReviewsGrade, (_e, input) =>
    handleResult(() => gradeReview(input))
  )
  ipcMain.handle(IPC.ReviewsAction, (_e, input) =>
    handleResult(() => actOnReview(input))
  )
}
