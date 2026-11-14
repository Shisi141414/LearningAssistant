import { powerMonitor } from 'electron'
import { checkMemoAuto, recoverMemoAuto } from './memo-auto'

export function startMemoAutoRuntime(): () => void {
  let stopped = false
  recoverMemoAuto()
  const tick = (): void => {
    if (stopped) return
    try {
      checkMemoAuto()
    } catch (e) {
      console.warn('备忘补处理失败', e instanceof Error ? e.message : String(e))
    }
  }
  const timer = setInterval(tick, 3000)
  timer.unref()
  powerMonitor.on('resume', tick)
  tick()
  return () => {
    stopped = true
    clearInterval(timer)
    powerMonitor.removeListener('resume', tick)
  }
}
