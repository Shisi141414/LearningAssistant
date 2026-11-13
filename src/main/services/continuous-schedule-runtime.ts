import { powerMonitor } from 'electron'
import {
  attachContinuousScheduleRuntime,
  checkContinuousSchedule,
  continuousScheduleStamp,
  needsContinuousSchedule,
  recoverContinuousSchedule,
  stopContinuousSchedule
} from './continuous-schedule'

export function startContinuousScheduleRuntime(): () => void {
  let stopped = false,
    checking = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    observed = '',
    since = 0
  recoverContinuousSchedule()
  const tick = async (): Promise<void> => {
    if (stopped || checking) return
    checking = true
    clearTimeout(timer)
    try {
      if (needsContinuousSchedule()) {
        const stamp = continuousScheduleStamp()
        if (stamp !== observed) {
          observed = stamp
          since = Date.now()
        } else if (Date.now() - since >= 1000) await checkContinuousSchedule()
      }
    } catch (error) {
      if (!stopped)
        console.warn(
          '持续排程检查失败',
          error instanceof Error ? error.message : String(error)
        )
    }
    checking = false
    if (!stopped) {
      timer = setTimeout(() => void tick(), 3000)
      timer.unref()
    }
  }
  const refresh = (): void => {
    if (!stopped) {
      observed = ''
      clearTimeout(timer)
      timer = setTimeout(() => void tick(), 0)
      timer.unref()
    }
  }
  const detach = attachContinuousScheduleRuntime(refresh)
  powerMonitor.on('resume', refresh)
  refresh()
  return () => {
    stopped = true
    clearTimeout(timer)
    detach()
    powerMonitor.removeListener('resume', refresh)
    stopContinuousSchedule()
  }
}
