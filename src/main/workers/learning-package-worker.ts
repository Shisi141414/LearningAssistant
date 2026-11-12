import { parentPort, workerData } from 'node:worker_threads'
import type { LearningPackage } from '@shared/learning-package'
import { readLearningPackage, writeLearningPackage } from '../services/learning-package-codec'

type Input = { action: 'read'; file: string; directory: string } | { action: 'write'; manifest: LearningPackage; files: [string, string][]; output: string }
const input = workerData as Input
const task = input.action === 'read' ? readLearningPackage(input.file, input.directory) : writeLearningPackage(input.manifest, new Map(input.files), input.output)
void task.then(result => parentPort?.postMessage({ type: 'done', result })).catch(error => parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
