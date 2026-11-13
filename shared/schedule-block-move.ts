import type { CalendarConflicts, CalendarImportOptions } from './calendar'
import type { PlanningState } from './auto-schedule'

export interface BlockMoveInput {
  id: string
  expected_revision: string
  start_at: number
  end_at: number
  confirmation?: CalendarImportOptions
}
export interface BlockMoveReport {
  conflicts: CalendarConflicts
  warnings: string[]
}
export type BlockMoveResult =
  | { state: PlanningState; report?: never }
  | { state: null; report: BlockMoveReport }
