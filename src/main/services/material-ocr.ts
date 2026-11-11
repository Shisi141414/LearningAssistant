import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { createWorker, OEM, PSM } from 'tesseract.js'
import type { OcrInput, OcrPage, ParsedBlock } from '@shared/types'
import { ocrBlocks, readableOcr } from '@shared/material-ocr'

export type OcrResult = { blocks: ParsedBlock[]; warnings: string[]; pages: OcrPage[] }

export async function recognizeMaterial(file: string, input: OcrInput, modelDirectory: string, modelJson: string, progress: (value: number) => void): Promise<OcrResult> {
  const require = createRequire(__filename)
  const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  const assets = (name: string): string => join(pdfRoot, name).replaceAll('\\', '/') + '/'
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await readFile(file)
  if (bytes.length > 50 * 1024 * 1024) throw new Error('材料超过 50 MiB')
  const loading = getDocument({ data: new Uint8Array(bytes), cMapUrl: assets('cmaps'), cMapPacked: true, standardFontDataUrl: assets('standard_fonts'), wasmUrl: assets('wasm') })
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined
  try {
    const document = await loading.promise
    if (input.from_page < 1 || input.to_page > document.numPages || input.to_page < input.from_page || input.to_page - input.from_page >= 20) throw new Error('请选择文档内连续的 1–20 页')
    worker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      langPath: modelDirectory, gzip: false, cacheMethod: 'none',
      workerPath: join(__dirname, 'ocr-engine-worker.js'),
      corePath: dirname(require.resolve('tesseract.js-core/package.json'))
    })
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
    const pages: OcrPage[] = [], blocks: ParsedBlock[] = [], warnings = ['OCR 文字可能有误；公式、表格、图像及阅读顺序需对照原页核对。识别分数不是正确率。']
    for (let number = input.from_page; number <= input.to_page; number++) {
      const page = await document.getPage(number)
      const base = page.getViewport({ scale: 1 })
      if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('PDF 页面尺寸无效')
      const scale = Math.min(3, 8192 / base.width, 8192 / base.height, Math.sqrt(6_000_000 / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise
      const { data } = await worker.recognize(canvas.toBuffer('image/png'), {}, { text: true, blocks: true })
      if (data.text.length > 100_000) throw new Error('单页识别超过十万字符，请拆分材料')
      const lines = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.map(line => ({ text: line.text, confidence: line.confidence, bbox: line.bbox }))))
      pages.push({ page: number, raw_text: data.text, corrected_text: null, confidence: data.confidence, width: canvas.width, height: canvas.height, lines_json: JSON.stringify(lines), model_json: modelJson })
      blocks.push(...ocrBlocks(readableOcr(data.text), number))
      if (!data.text.trim()) warnings.push(`第 ${number} 页 OCR 未识别出文字，需人工校正`)
      else if (data.confidence < 70) warnings.push(`第 ${number} 页 OCR 识别分数偏低，需核对`)
      page.cleanup()
      progress(Math.round((number - input.from_page + 1) / (input.to_page - input.from_page + 1) * 95))
    }
    return { pages, blocks, warnings }
  } finally { await worker?.terminate(); await loading.destroy() }
}
