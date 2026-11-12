import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { RenderTask, PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import rendererUrl from 'pdfjs-dist/build/pdf.renderer.min.mjs?url'
import type { LearningCropRect } from '@shared/types'
import { learningCropRect, validLearningCropRect } from '@shared/learning-crops'

GlobalWorkerOptions.workerSrc = workerUrl
GlobalWorkerOptions.rendererSrc = rendererUrl

/** 单页原件预览。每个 effect 使用独立 canvas，避免快速换页的旧任务污染新画布。 */
export function PdfPage({ versionId, pageNumber, selection }: { versionId: string; pageNumber: number; selection?: { value: LearningCropRect | null; onChange: (rect: LearningCropRect | null) => void; disabled: boolean; readOnly?: boolean } }) {
  const host = useRef<HTMLDivElement>(null)
  const start = useRef<[number, number] | null>(null)
  const [dragRect, setDragRect] = useState<LearningCropRect | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('正在读取 PDF 原页…')
  const [loaded, setLoaded] = useState<{ versionId: string; document: PDFDocumentProxy } | null>(null)
  useEffect(() => {
    let alive = true
    setLoaded(null); setStatus('正在读取 PDF 原件…')
    const loading = getDocument({ url: `study-material://file/${versionId}`, cMapUrl: 'study-material://assets/cmaps/', cMapPacked: true, standardFontDataUrl: 'study-material://assets/standard_fonts/', wasmUrl: 'study-material://assets/wasm/', useWorkerFetch: false })
    void loading.promise.then(document => { if (alive) setLoaded({ versionId, document }) }).catch(error => {
      if (alive) setStatus(`原件未能读取：${error instanceof Error ? error.message : String(error)}。可以打开原件查看。`)
    })
    return () => { alive = false; void loading.destroy().catch(() => undefined) }
  }, [versionId])
  useEffect(() => {
    if (!host.current) return
    host.current.replaceChildren()
    setReady(false)
    if (!loaded || loaded.versionId !== versionId) return
    let alive = true
    let render: RenderTask | undefined
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-label', `PDF 第 ${pageNumber} 页原件`)
    canvas.style.maxWidth = '100%'; canvas.style.height = 'auto'; canvas.style.display = 'block'
    const width = Math.max(160, host.current.closest('.pdf-page')?.clientWidth ?? 300)
    host.current.replaceChildren(canvas)
    setStatus('正在读取 PDF 原页…')
    void (async () => {
      const page = await loaded.document.getPage(pageNumber)
      if (!alive) return
      const base = page.getViewport({ scale: 1 })
      // 预览限制像素数；原件仍可通过外部应用查看完整分辨率。
      const scale = Math.min(width / base.width * Math.min(window.devicePixelRatio || 1, 2), Math.sqrt(6_000_000 / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
      render = page.render({ canvas, viewport })
      await render.promise
      if (alive) { setStatus(''); setReady(true) }
    })().catch(error => { if (alive) setStatus(`原页未能显示：${error instanceof Error ? error.message : String(error)}。可以打开原件查看。`) })
    return () => { alive = false; render?.cancel(); canvas.remove() }
  }, [loaded, versionId, pageNumber])
  const rect = dragRect ?? selection?.value
  return <div className="pdf-page"><div role="status" className="muted">{status}</div><div className="pdf-crop-surface" style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', touchAction: selection ? 'none' : undefined }}>
    <div ref={host} />
    {selection && ready && <div className="pdf-crop-overlay" aria-label="PDF 配图选区" style={{ position: 'absolute', inset: 0, cursor: selection.readOnly ? 'default' : selection.disabled ? 'wait' : 'crosshair' }}
      onPointerDown={event => { if (selection.disabled || event.button !== 0) return; const b = event.currentTarget.getBoundingClientRect(); start.current = [(event.clientX - b.left) / b.width, (event.clientY - b.top) / b.height]; event.currentTarget.setPointerCapture(event.pointerId); setDragRect(null); selection.onChange(null) }}
      onPointerMove={event => { if (!start.current || selection.disabled) return; const b = event.currentTarget.getBoundingClientRect(); setDragRect(learningCropRect(start.current, [(event.clientX - b.left) / b.width, (event.clientY - b.top) / b.height])) }}
      onPointerUp={event => { if (!start.current) return; const b = event.currentTarget.getBoundingClientRect(); const next = learningCropRect(start.current, [(event.clientX - b.left) / b.width, (event.clientY - b.top) / b.height]); start.current = null; setDragRect(null); if (!selection.disabled) selection.onChange(validLearningCropRect(next) && next[2] * b.width >= 4 && next[3] * b.height >= 4 ? next : null) }}
      onPointerCancel={() => { start.current = null; setDragRect(null) }}>
      {rect && <div className="pdf-crop-rectangle" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }} />}
    </div>}
  </div></div>
}
