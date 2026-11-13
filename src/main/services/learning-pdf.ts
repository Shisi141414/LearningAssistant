import { BrowserWindow } from 'electron'
import { basename, join } from 'node:path'
import { mkdtemp, open, rename, rmdir, unlink } from 'node:fs/promises'
import type { LearningPdfDocument, LearningPdfInput, LearningPdfReport, LearningPdfResult } from '@shared/learning-pdf'
import { validateLearningState } from '@shared/learning-document'
import { getDb } from './db'
import { getLearningDocument } from './learning-documents'
import { getNoteLearning } from './note-learning'
import { externalExportTarget } from './export-target'
import { beginWork } from './work'
import { nanoid } from 'nanoid'
import { learningAssetResponse } from './learning-assets'
import { getExercise } from './exercises'
import { getProjectDocument } from './project-documents'
import { projectDocumentKinds } from '@shared/project-documents'
import { exerciseStatuses } from '@shared/exercises'

let stopping = false
let active: { owner: number; cancel: () => boolean } | undefined
/** 固定选中修订；不触发 AI、OCR 或笔记来源同步，不传本机附件路径。 */
export function learningPdfSnapshot(input: LearningPdfInput): LearningPdfDocument {
  return getDb().transaction(() => {
    const db = getDb(), source = input.source
    let document: LearningPdfDocument
    if (source.kind === 'material') {
      const data = getLearningDocument(source)
      const material = db.prepare('SELECT m.title,v.file_name,s.name AS subject_name FROM material_versions v JOIN materials m ON m.id=v.material_id LEFT JOIN subjects s ON s.id=m.subject_id WHERE v.id=?').get(source.version_id) as { title: string; file_name: string; subject_name: string | null } | undefined
      if (!data || !material) throw new Error('请选择已建立的学习文档修订')
      const history = data.history.find(row => row.id === source.revision_id)!
      document = { landscape: input.landscape, include_original_text: input.include_original_text, title: material.title, subject_name: material.subject_name, source_name: material.file_name, revision_id: source.revision_id, revision_number: data.history.length - data.history.findIndex(row => row.id === source.revision_id), saved_at: history.created_at,
        sources: data.sources, state: data.state, assets: data.assets ?? [], origins: {} }
    } else if (source.kind === 'project_document') {
      const data = getProjectDocument({ id:source.document_id,revision_id:source.revision_id }),snapshot = data.snapshot
      const project = db.prepare('SELECT title FROM projects WHERE id=?').get(data.project_id) as { title:string }
      document = { landscape:input.landscape,include_original_text:input.include_original_text,title:snapshot.title,subject_name:null,
        source_name:[project.title,projectDocumentKinds[snapshot.kind],snapshot.origin ? `来源：${snapshot.origin.title}` : '项目手写文档'].join(' · '),
        revision_id:data.revision_id,revision_number:data.history.length-data.history.findIndex(item=>item.id===data.revision_id),saved_at:data.history.find(item=>item.id===data.revision_id)!.created_at,
        sources:snapshot.sources,state:snapshot.state,assets:snapshot.assets,origins:{} }
    } else if (source.kind === 'exercise') {
      const data = getExercise({ id: source.exercise_id, revision_id: source.revision_id }), snapshot = data.snapshot
      const subject = snapshot.subject_id ? db.prepare('SELECT name FROM subjects WHERE id=?').get(snapshot.subject_id) as { name: string } | undefined : undefined
      const concepts = snapshot.review_concept_ids.map(id => (db.prepare('SELECT name FROM knowledge_points WHERE id=?').get(id) as { name: string } | undefined)?.name ?? '知识点已不可用')
      document = { landscape: input.landscape, include_original_text: input.include_original_text, title: snapshot.title, subject_name: subject?.name ?? null,
        source_name: ['习题', exerciseStatuses[snapshot.status], snapshot.question_type, snapshot.no_idea ? '暂无解题思路' : '', `来源：${snapshot.source_label || '尚未填写'}`, `需复习：${concepts.join('、') || '尚未关联'}`].filter(Boolean).join(' · '),
        revision_id: data.revision_id, revision_number: data.history.length-data.history.findIndex(row => row.id === data.revision_id), saved_at: data.history.find(row => row.id === data.revision_id)!.created_at,
        sources: snapshot.document.sources, state: snapshot.document.state, assets: snapshot.origin?.assets ?? [], origins: {},
        ...(snapshot.origin ? { exercise_origin: { label: snapshot.origin.label, raw_text: snapshot.origin.raw_text } } : {}) }
    } else {
      const data = getNoteLearning(source)
      const subject = data.subject_id ? db.prepare('SELECT name FROM subjects WHERE id=?').get(data.subject_id) as { name: string } | undefined : undefined
      document = { landscape: input.landscape, include_original_text: input.include_original_text, title: data.title, subject_name: subject?.name ?? null, source_name: '课堂 / 学习笔记', revision_id: data.revision_id, revision_number: data.history.length - data.history.findIndex(row => row.id === data.revision_id), saved_at: data.created_at,
        sources: data.sources, state: data.state, assets: [], origins: data.origins }
    }
    if (!document.sources.length) throw new Error('笔记尚无内容，请先添加段落')
    validateLearningState(document.state, document.sources)
    if (document.sources.reduce((total, item) => total + item.raw_text.length, 0) + Object.values(document.origins).reduce((total, item) => total + item.raw_text.length, 0) > 20_000_000) throw new Error('文档文字超过本次导出容量，请拆分笔记后导出')
    const used = new Set(document.state.entries.flatMap(entry => entry.figures?.map(figure => figure.asset_id) ?? []))
    document.assets = document.assets.filter(asset => used.has(asset.id))
    if ([...used].some(id => !document.assets.some(asset => asset.id === id))) throw new Error('所选修订存在缺失配图，请先修复附件')
    return document
  })()
}
/** 隐藏的独立打印页无 preload；文档只经主进程注入，禁止外部导航与网络。 */
export async function exportLearningPdf(input: LearningPdfInput, output: string, owner: number): Promise<LearningPdfResult> {
  if (stopping) throw new Error('应用正在退出')
  if (active) throw new Error('已有 PDF 正在导出，请等待完成或取消')
  const release = beginWork('PDF 导出'), controller = new AbortController()
  let window: BrowserWindow | undefined, temporary: string | undefined, directory: string | undefined, committing = false
  const job = { owner, cancel: () => { if (committing || controller.signal.aborted) return false; controller.abort(); if (window && !window.isDestroyed()) window.destroy(); return true } }
  active = job
  const check = () => { if (stopping || controller.signal.aborted) throw new Error('PDF 导出已取消，已有文件保留') }
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    check()
    let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('PDF 导出已取消，已有文件保留')); controller.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { reject(new Error('PDF 排版超时，请缩小文档后重试')); job.cancel() }, 180_000)
      })])
    } finally { if (timer) clearTimeout(timer); if (abort) controller.signal.removeEventListener('abort', abort) }
  }
  try {
    const destination = await externalExportTarget(output, '.pdf'); check()
    const snapshot = learningPdfSnapshot(input)
    window = new BrowserWindow({ show: false, width: input.landscape ? 1200 : 900, height: 900, webPreferences: { partition: `learning-pdf-${nanoid()}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    const allowedAssets = new Set(snapshot.assets.map(asset => asset.id))
    window.webContents.session.protocol.handle('study-material', async request => {
      const url = new URL(request.url), id = url.pathname.slice(1)
      if (request.method !== 'GET' || url.hostname !== 'learning-assets' || url.search || !allowedAssets.has(id)) return new Response(null, { status: 403 })
      return learningAssetResponse(id)
    })
    // 独立非持久 session 不共享主窗口权限；CSP 仅允许本地字体和托管图片。
    const page = process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/print.html` : undefined
    await wait(page ? window.loadURL(page) : window.loadFile(join(__dirname, '../renderer/print.html')))
    const report = await wait(window.webContents.executeJavaScript(`window.renderLearningPdf(${JSON.stringify(snapshot)})`) as Promise<LearningPdfReport>)
    check()
    const bytes = await wait(window.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape: input.landscape, preferCSSPageSize: true, generateDocumentOutline: true, generateTaggedPDF: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="width:100%;font-size:9px;text-align:center;color:#666">LearningAssistant · <span class="pageNumber"></span> / <span class="totalPages"></span></div>', margins: { top: 0.7, bottom: 0.7, left: 0.75, right: 0.75 } }))
    check()
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('打印引擎没有生成有效 PDF')
    directory = await mkdtemp(join(destination.directory, '.learning-pdf-')); temporary = join(directory, 'document.pdf'); check()
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    check(); committing = true
    await rename(temporary, destination.target); temporary = undefined
    return { ...report, file_name: basename(destination.target), byte_length: bytes.length, revision_id: snapshot.revision_id }
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    if (temporary) await unlink(temporary).catch(() => undefined)
    if (directory) await rmdir(directory).catch(() => undefined)
    if (active === job) active = undefined
    release()
  }
}
export function cancelLearningPdf(owner: number): boolean { return active && active.owner === owner ? active.cancel() : false }
export function stopLearningPdfs(): void { stopping = true; active?.cancel() }
