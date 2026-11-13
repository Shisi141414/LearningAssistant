import { parentPort, workerData } from 'node:worker_threads'
import { planSchedule } from '@shared/auto-schedule'
try {
  parentPort!.postMessage({ ok: true, data: planSchedule(workerData) })
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
