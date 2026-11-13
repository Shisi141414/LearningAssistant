import type { PlannerResult, ScheduleBlock } from './auto-schedule'
export interface ContinuousSettings {
  revision: string | null
  enabled: boolean
  horizon_days: number
}
export interface ScheduleHistory {
  id: string
  created_at: number
  origin: 'manual' | 'automatic'
  reason: string
  undone_at: number | null
  added: ScheduleBlock[]
  removed: ScheduleBlock[]
  added_total: number
  removed_total: number
  unplaced: PlannerResult['unplaced']
  warnings: string[]
}
export interface ContinuousState {
  settings: ContinuousSettings
  state: 'paused' | 'waiting' | 'running' | 'idle' | 'error'
  checked_at: number | null
  error: string
  outcome: {
    from?: number
    to?: number
    unplaced?: PlannerResult['unplaced']
    warnings?: string[]
  }
  history: ScheduleHistory[]
}
