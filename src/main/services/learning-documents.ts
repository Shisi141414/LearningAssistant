import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { LearningChange, LearningDocument, LearningSource, LearningState, MaterialVersion, OcrPage, ParsedBlock } from '@shared/types'
import { changeLearningState, initialLearningState, validateLearningState } from '@shared/learning-document'
import { readableOcr } from '@shared/material-ocr'
import { getDb } from './db'
import { materialPath } from './materials'
import { materialParseInput } from './office-conversions'
import { beginWork } from './work'
import { learningAssets, learningAssetExtraction } from './learning-assets'

type DocumentRow = { id: string; version_id: string; current_revision_id: string; created_at: number }
let stopping = false
const preparing = new Map<string, { promise: Promise<LearningDocument>; stop: () => void }>()
function editableVersion(id: string): MaterialVersion {
  const row = getDb().prepare('SELECT v.* FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ? AND m.archived = 0').get(id) as MaterialVersion | undefined
  if (!row || row.status !== 'ready') throw new Error('请选择未归档且可阅读的材料版本')
  return row
}
export function getLearningDocument(input: { version_id: string; revision_id?: string }): LearningDocument | null {
  const db = getDb(), document = db.prepare('SELECT * FROM learning_documents WHERE version_id = ?').get(input.version_id) as DocumentRow | undefined
  if (!document) return null
  const revision = db.prepare('SELECT id, snapshot_json FROM learning_revisions WHERE document_id = ? AND id = ?').get(document.id, input.revision_id ?? document.current_revision_id) as { id: string; snapshot_json: string } | undefined
  if (!revision) throw new Error('学习文档修订不存在')
  return { ...document, revision_id: revision.id, sources: db.prepare('SELECT id, ordinal, raw_text, heading, locator_json, extraction FROM learning_sources WHERE document_id = ? ORDER BY ordinal').all(document.id) as LearningSource[], state: JSON.parse(revision.snapshot_json), history: db.prepare('SELECT id, created_at FROM learning_revisions WHERE document_id = ? ORDER BY created_at DESC, rowid DESC').all(document.id) as { id: string; created_at: number }[], assets: learningAssets(document.id), asset_extraction: learningAssetExtraction(document.id) }
}
/** 原子建立规范来源；不从有重叠的检索块拼接正文，也不改旧块 ID。 */
export function prepareLearningDocument(versionId: string): Promise<LearningDocument> {
  if (stopping) return Promise.reject(new Error('应用正在退出'))
  const existing = getLearningDocument({ version_id: versionId })
  if (existing) return Promise.resolve(existing)
  const pending = preparing.get(versionId)
  if (pending) return pending.promise
  const version = editableVersion(versionId), release = beginWork('学习文档来源准备')
  let worker: Worker
  try { worker = new Worker(join(__dirname, 'material-worker.js'), { workerData: { ...materialParseInput(versionId, materialPath(versionId), version.format), captureSources: true }, resourceLimits: { maxOldGenerationSizeMb: 512 } }) }
  catch (error) { release(); return Promise.reject(error) }
  let settled = false, stop: () => void = () => undefined
  const promise = new Promise<LearningDocument>((resolve, reject) => {
    const finish = (error?: Error, units?: ParsedBlock[]): void => {
      if (settled) return
      settled = true; clearTimeout(timer)
      try {
        if (error) throw error
        if (stopping) throw new Error('来源准备已停止，可在下次打开后重试')
        editableVersion(versionId)
        const ocrPages = getDb().prepare('SELECT * FROM material_ocr_pages WHERE version_id = ?').all(versionId) as OcrPage[]
        const byPage = new Map(ocrPages.map(page => [page.page, page]))
        const sources: LearningSource[] = (units ?? []).map((unit, ordinal) => {
          const ocr = version.format === 'pdf' ? byPage.get(unit.locator.page ?? 0) : undefined
          return { id: nanoid(), ordinal, raw_text: ocr ? ocr.corrected_text ?? readableOcr(ocr.raw_text) : unit.text, heading: unit.heading, locator_json: JSON.stringify(unit.locator), extraction: ocr ? ocr.corrected_text === null ? 'ocr' : 'manual' : 'native' }
        })
        if (!sources.length || sources.length > 1000 || sources.reduce((n, s) => n + s.raw_text.length, 0) > 2_000_000) throw new Error('首批学习文档支持最多 1000 个来源单元、200 万字符；请先拆分长材料')
        const state = initialLearningState(sources, nanoid)
        validateLearningState(state, sources)
        getDb().transaction(() => {
          const id = nanoid(), revision = nanoid(), now = Date.now()
          getDb().prepare('INSERT INTO learning_documents (id, version_id, created_at) VALUES (?, ?, ?)').run(id, versionId, now)
          const insert = getDb().prepare('INSERT INTO learning_sources (id, document_id, ordinal, raw_text, heading, locator_json, extraction) VALUES (?, ?, ?, ?, ?, ?, ?)')
          sources.forEach(s => insert.run(s.id, id, s.ordinal, s.raw_text, s.heading, s.locator_json, s.extraction))
          getDb().prepare('INSERT INTO learning_revisions (id, document_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)').run(revision, id, JSON.stringify(state), now)
          getDb().prepare('UPDATE learning_documents SET current_revision_id = ? WHERE id = ?').run(revision, id)
        })()
        resolve(getLearningDocument({ version_id: versionId })!)
      } catch (failure) { reject(failure) }
      finally { preparing.delete(versionId); void worker.terminate(); release() }
    }
    const timer = setTimeout(() => finish(new Error('来源准备超过两分钟，请拆分材料后重试')), 120_000)
    stop = () => finish(new Error('来源准备已停止，可在下次打开后重试'))
    worker.on('message', message => { if (message.type === 'done') finish(undefined, message.units); if (message.type === 'error') finish(new Error(message.error)) })
    worker.on('error', error => finish(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', code => { if (!settled) finish(new Error(`来源准备线程退出（${code}）`)) })
  })
  preparing.set(versionId, { promise, stop })
  return promise
}
export function publishLearningRevision(document: LearningDocument, state: LearningState): LearningDocument {
  editableVersion(document.version_id)
  return getDb().transaction(() => {
    const row = getDb().prepare('SELECT current_revision_id FROM learning_documents WHERE id = ? AND version_id = ?').get(document.id, document.version_id) as { current_revision_id: string } | undefined
    if (row?.current_revision_id !== document.current_revision_id) throw new Error('学习文档已有更新，请刷新当前修订后再修改')
    validateLearningState(state, document.sources)
    const assets = new Set(learningAssets(document.id).map(asset => asset.id))
    if (state.entries.some(entry => entry.figures?.some(figure => !assets.has(figure.asset_id)))) throw new Error('配图不属于当前学习文档，请刷新并重新选择')
    const revision = nanoid()
    getDb().prepare('INSERT INTO learning_revisions (id, document_id, parent_revision_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)').run(revision, document.id, document.current_revision_id, JSON.stringify(state), Date.now())
    getDb().prepare('UPDATE learning_documents SET current_revision_id = ? WHERE id = ? AND current_revision_id = ?').run(revision, document.id, document.current_revision_id)
    return getLearningDocument({ version_id: document.version_id })!
  })()
}
export function changeLearningDocument(change: LearningChange): LearningDocument {
  const document = getLearningDocument({ version_id: change.version_id })
  if (!document) throw new Error('请先建立学习文档')
  if (document.current_revision_id !== change.expected_revision_id) throw new Error('学习文档已有更新，请刷新当前修订后再修改')
  return publishLearningRevision(document, changeLearningState(document.state, document.sources, change, nanoid))
}
export function stopLearningPreparation(): void { stopping = true; for (const pending of [...preparing.values()]) pending.stop() }
