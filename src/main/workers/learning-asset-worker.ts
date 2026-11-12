import { parentPort, workerData } from 'node:worker_threads'
import { parseLearningAssets } from '../services/learning-asset-parser'

const { file, format, fingerprint } = workerData as { file: string; format: 'docx' | 'pptx'; fingerprint: string }
void parseLearningAssets(file, format, fingerprint).then(result => parentPort?.postMessage({ type: 'done', ...result })).catch(error => parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
