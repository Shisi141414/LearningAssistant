import { parentPort, workerData } from 'node:worker_threads'
import { parseMaterial } from '../services/material-parser'
import type { MaterialFormat, OcrInput } from '@shared/types'
import { recognizeMaterial } from '../services/material-ocr'

const { file, format, ocr, modelDirectory, modelJson, ppocr, p2tBaseUrl, captureSources, expectedFingerprint } = workerData as {
  file: string; format: MaterialFormat; ocr?: OcrInput; modelDirectory?: string; modelJson?: string
  ppocr?: import('../services/material-ocr').PpocrModelPaths; p2tBaseUrl?: string
  captureSources?: boolean; expectedFingerprint?: string
}
const progress = (value: number): void => { parentPort?.postMessage({ type: 'progress', progress: value }) }
const job = ocr
  ? recognizeMaterial(file, ocr, modelDirectory ?? '', modelJson ?? '', progress, ppocr, p2tBaseUrl)
  : parseMaterial(file, format, progress, captureSources, expectedFingerprint)
job
  .then(result => parentPort?.postMessage({ type: 'done', ...result }))
  .catch(error => { console.error('材料处理失败', error); parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }) })
