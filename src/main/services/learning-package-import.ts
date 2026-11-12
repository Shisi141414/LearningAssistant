import { Worker } from 'node:worker_threads'
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nanoid } from 'nanoid'
import type { ParsedBlock } from '@shared/types'
import type { LearningPackageImportInput, LearningPackageImportResult, LearningPackagePreview } from '@shared/learning-package'
import type { DecodedLearningPackage } from './learning-package-codec'
import { beginWork } from './work'
import { installLearningPackage } from './learning-package-import-store'

type Job = { ticket: string; phase: 'reading' | 'preview' | 'confirming'; cancelled: boolean; release: () => void; directory?: string; worker?: Worker; timer?: ReturnType<typeof setTimeout>; decoded?: DecodedLearningPackage & { blocks: ParsedBlock[] } }
let active: Job | undefined, stopping = false
function check(job: Job): void { if (stopping || job.cancelled || active !== job) throw new Error('导入已取消或预览过期，请重新选择文档包') }
async function dispose(job: Job): Promise<void> {
  clearTimeout(job.timer); await job.worker?.terminate().catch(() => undefined)
  if (job.directory) {
    const files = await readdir(job.directory).catch(() => [] as string[])
    for (const file of files) if (/^file-\d+\.bin$/.test(file)) await unlink(join(job.directory, file)).catch(() => undefined)
    await rmdir(job.directory).catch(() => undefined)
  }
  if (active === job) active = undefined
  job.release()
}
function runWorker<T>(job: Job, input: object): Promise<T> {
  check(job)
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'learning-package-worker.js'), { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 512 } }); job.worker = worker
    let settled = false
    const finish = (error?: Error, result?: T): void => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); if (error) reject(error); else resolve(result!) }
    const timer = setTimeout(() => finish(new Error('文档包检查超过两分钟，请拆分材料后重试')), 120_000)
    worker.on('message', message => { if (message.type === 'done') finish(undefined, message.result); else if (message.type === 'error') finish(new Error(message.error)) })
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => finish(new Error(job.cancelled ? '文档包导入已取消' : `文档包检查线程退出（${code}）`)))
  })
}
/** 只由系统文件选择框调用；返回摘要与一次性票据，原路径/附件路径不进入渲染进程。 */
export async function previewLearningPackage(file: string): Promise<LearningPackagePreview> {
  if (stopping) throw new Error('应用正在退出')
  if (active) throw new Error('请先完成或取消当前文档包预览')
  const job: Job = { ticket: nanoid(), phase: 'reading', cancelled: false, release: beginWork('学习文档包导入') }; active = job
  try {
    job.directory = await mkdtemp(join(tmpdir(), 'learning-package-preview-')); check(job)
    const decoded = await runWorker<NonNullable<Job['decoded']>>(job, { action: 'read', file, directory: job.directory, withBlocks: true }); check(job); job.decoded = decoded
    job.phase = 'preview'
    job.timer = setTimeout(() => { job.cancelled = true; void dispose(job) }, 10 * 60_000)
    const { manifest, sha256 } = decoded
    return { ticket: job.ticket, title: manifest.document.title, file_name: manifest.original.file_name, format: manifest.original.format, kind: manifest.document.kind, subject_name: manifest.document.subject_name,
      sources: manifest.sources.length, entries: manifest.state.entries.length, assets: manifest.assets.length, concepts: manifest.concepts.length, evidence: manifest.evidence.length, sha256 }
  } catch (error) { await dispose(job); throw error }
}
export async function confirmLearningPackage(input: LearningPackageImportInput): Promise<LearningPackageImportResult> {
  const job = active
  if (!job || job.ticket !== input.ticket || job.phase !== 'preview' || !job.decoded) throw new Error('文档包预览不存在或已过期，请重新选择')
  check(job); clearTimeout(job.timer); job.phase = 'confirming'
  try {
    return await installLearningPackage(job.decoded, job.decoded.blocks, input.subject_id, input.include_concepts,
      (manifest, files) => runWorker(job, { action: 'verify', manifest, files }), () => stopping || job.cancelled)
  } finally { await dispose(job) }
}
export async function cancelLearningPackageImport(): Promise<boolean> {
  const job = active
  if (!job) return false
  job.cancelled = true
  await job.worker?.terminate().catch(() => undefined)
  if (job.phase === 'preview') await dispose(job)
  return true
}
export function stopLearningPackageImports(): void { stopping = true; void cancelLearningPackageImport() }
