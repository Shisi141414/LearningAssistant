import { parentPort, workerData } from 'node:worker_threads'
import { parseLearningAssets } from '../services/learning-asset-parser'
import { renderLearningPdfCrop } from '../services/learning-pdf-crops'
import type { LearningPdfCrop } from '@shared/types'

const { file, format, fingerprint, crop } = workerData as { file: string; format: 'docx' | 'pptx' | 'pdf'; fingerprint: string; crop?: LearningPdfCrop }
const job = format === 'pdf' && crop ? renderLearningPdfCrop(file, fingerprint, crop) : format !== 'pdf' ? parseLearningAssets(file, format, fingerprint) : Promise.reject(new Error('请选择 PDF 配图区域'))
void job.then(result => parentPort?.postMessage({ type: 'done', ...result })).catch(error => parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
