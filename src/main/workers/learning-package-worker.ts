import { parentPort, workerData } from 'node:worker_threads'
import type { LearningPackage } from '@shared/learning-package'
import { readLearningPackage, writeLearningPackage, verifyLearningPackageFiles } from '../services/learning-package-codec'
import { relatedPackageConcepts } from '@shared/learning-package-concepts'
import { learningPackageBlocks } from '@shared/learning-package-remap'

type Input = { action: 'read'; file: string; directory: string; withBlocks?: boolean } | { action: 'write'; manifest: LearningPackage; files: [string, string][]; output: string; selectRelatedConcepts?: boolean } | { action: 'verify'; manifest: LearningPackage; files: [string, string][] }
const input = workerData as Input
async function run() {
  if (input.action === 'read') { const result = await readLearningPackage(input.file, input.directory); return { ...result, ...(input.withBlocks ? { blocks: learningPackageBlocks(result.manifest) } : {}) } }
  if (input.action === 'verify') return verifyLearningPackageFiles(input.manifest, new Map(input.files))
  return writeLearningPackage(input.selectRelatedConcepts ? relatedPackageConcepts(input.manifest) : input.manifest, new Map(input.files), input.output)
}
const task = run()
void task.then(result => parentPort?.postMessage({ type: 'done', result })).catch(error => parentPort?.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }))
