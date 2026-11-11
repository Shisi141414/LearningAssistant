import { parentPort, workerData } from 'node:worker_threads'
import { parseMaterial } from '../services/material-parser'
import type { MaterialFormat } from '@shared/types'

const { file, format } = workerData as { file: string; format: MaterialFormat }
parseMaterial(file, format, progress => parentPort?.postMessage({ type: 'progress', progress }))
  .then(result => parentPort?.postMessage({ type: 'done', ...result }))
  .catch(error => parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
