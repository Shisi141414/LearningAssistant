import { parentPort, workerData } from 'node:worker_threads'
import { parseCalendarIcs } from '../services/calendar-ics'
try {
  parentPort?.postMessage({ ok: true, data: parseCalendarIcs(workerData.text, workerData.range) })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
