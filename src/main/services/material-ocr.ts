import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { createWorker, OEM, PSM } from 'tesseract.js'
import type { OcrInput, OcrPage, ParsedBlock } from '@shared/types'
import { ocrBlocks, readableOcr } from '@shared/material-ocr'

export type OcrResult = { blocks: ParsedBlock[]; warnings: string[]; pages: OcrPage[] }

/** ppocr 本地模型路径（由主进程在校验后传入，worker 不做路径决策、不联网） */
export interface PpocrModelPaths {
  detection: string
  recognition: string
  charactersDictionary: string
  /** 记录到 model_json 的预设与版本信息 */
  preset: string
  engineVersion: string
}

interface OcrLineRecord {
  text: string
  confidence: number
  bbox: { x1: number; y1: number; x2: number; y2: number; x3: number; y3: number; x4: number; y4: number }
}

/**
 * 识别扫描 PDF：按 input.engine 路由——
 *  ppocr（默认）：PP-OCRv6/v5（按语言选预设），中文与多语种质量显著优于 tesseract
 *  pix2text：文字+公式一体（Python sidecar，公式输出 LaTeX；需本机 pip install pix2text）
 *  tesseract：chi_sim+eng 备选引擎（沿用原管线）
 * PDF→canvas 渲染为各引擎共用，仅识别调用不同。
 */
export async function recognizeMaterial(
  file: string,
  input: OcrInput,
  modelDirectory: string,
  modelJson: string,
  progress: (value: number) => void,
  ppocr?: PpocrModelPaths,
  p2tBaseUrl?: string
): Promise<OcrResult> {
  const require = createRequire(__filename)
  const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  const assets = (name: string): string => join(pdfRoot, name).replaceAll('\\', '/') + '/'
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const bytes = await readFile(file)
  if (bytes.length > 50 * 1024 * 1024) throw new Error('材料超过 50 MiB')
  const loading = getDocument({ data: new Uint8Array(bytes), cMapUrl: assets('cmaps'), cMapPacked: true, standardFontDataUrl: assets('standard_fonts'), wasmUrl: assets('wasm') })

  const usePpocr = input.engine !== 'tesseract' && input.engine !== 'pix2text' && !!ppocr
  const useP2t = input.engine === 'pix2text' && !!p2tBaseUrl
  let tessWorker: Awaited<ReturnType<typeof createWorker>> | undefined
  let paddle: import('ppu-paddle-ocr').PaddleOcrService | undefined
  try {
    const document = await loading.promise
    if (input.from_page < 1 || input.to_page > document.numPages || input.to_page < input.from_page || input.to_page - input.from_page >= 20) throw new Error('请选择文档内连续的 1–20 页')

    if (usePpocr && ppocr) {
      const { PaddleOcrService } = await import('ppu-paddle-ocr')
      paddle = new PaddleOcrService({
        model: { detection: ppocr.detection, recognition: ppocr.recognition, charactersDictionary: ppocr.charactersDictionary }
      })
      await paddle.initialize()
    } else if (useP2t) {
      // 模型懒加载在 sidecar 首请求；此处不预热（避免空跑 30s+）
    } else {
      tessWorker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
        langPath: modelDirectory, gzip: false, cacheMethod: 'none',
        workerPath: join(__dirname, 'ocr-engine-worker.js'),
        corePath: dirname(require.resolve('tesseract.js-core/package.json'))
      })
      await tessWorker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
    }

    const pages: OcrPage[] = [], blocks: ParsedBlock[] = [], warnings = ['OCR 文字可能有误；公式、表格、图像及阅读顺序需对照原页核对。识别分数不是正确率。']
    for (let number = input.from_page; number <= input.to_page; number++) {
      const page = await document.getPage(number)
      const base = page.getViewport({ scale: 1 })
      if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('PDF 页面尺寸无效')
      const scale = Math.min(3, 8192 / base.width, 8192 / base.height, Math.sqrt(6_000_000 / (base.width * base.height)))
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport }).promise
      const png = canvas.toBuffer('image/png')

      let text = ''
      let confidence = 0
      let lines: OcrLineRecord[] = []
      if (paddle) {
        const result = await paddle.recognize(png.buffer as ArrayBuffer)
        text = result.text
        confidence = result.confidence * 100
        // ppu 行分组：每行若干词项（各带矩形 box）；合并为行记录，包围盒转 tesseract 四点格式
        lines = result.lines.map((words) => {
          const texts = words.map((w) => w.text)
          const minX = Math.min(...words.map((w) => w.box.x))
          const minY = Math.min(...words.map((w) => w.box.y))
          const maxX = Math.max(...words.map((w) => w.box.x + w.box.width))
          const maxY = Math.max(...words.map((w) => w.box.y + w.box.height))
          return {
            text: texts.join(''),
            confidence: (words.reduce((sum, w) => sum + w.confidence, 0) / words.length) * 100,
            bbox: { x1: minX, y1: minY, x2: maxX, y2: minY, x3: maxX, y3: maxY, x4: minX, y4: maxY }
          }
        })
      } else if (useP2t && p2tBaseUrl) {
        const pageResult = await recognizeByPix2Text(p2tBaseUrl, png)
        text = pageResult.text
        confidence = pageResult.confidence
        lines = pageResult.lines
      } else if (tessWorker) {
        const { data } = await tessWorker.recognize(png, {}, { text: true, blocks: true })
        text = data.text
        confidence = data.confidence
        lines = (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => ({ text: line.text, confidence: line.confidence, bbox: line.bbox as unknown as OcrLineRecord['bbox'] }))))
      }

      if (text.length > 100_000) throw new Error('单页识别超过十万字符，请拆分材料')
      pages.push({ page: number, raw_text: text, corrected_text: null, confidence, width: canvas.width, height: canvas.height, lines_json: JSON.stringify(lines), model_json: modelJson })
      blocks.push(...ocrBlocks(readableOcr(text), number))
      if (!text.trim()) warnings.push(`第 ${number} 页 OCR 未识别出文字，需人工校正`)
      else if (confidence < 70) warnings.push(`第 ${number} 页 OCR 识别分数偏低，需核对`)
      page.cleanup()
      progress(Math.round((number - input.from_page + 1) / (input.to_page - input.from_page + 1) * 95))
    }
    return { pages, blocks, warnings }
  } finally {
    await tessWorker?.terminate()
    await paddle?.destroy()
    await loading.destroy()
  }
}

/* ---------------- Pix2Text sidecar 调用与行组装 ---------------- */

interface P2tBlock {
  type: string
  text: string
  position: [number, number, number, number] | null
}

/**
 * 调 sidecar 识别整页：块（text/embedded/isolated 公式）→ 按 y 中心聚类成行。
 * isolated 公式独立成行（$$...$$）；embedded 与同行文字拼接（$...$）。
 * 首请求含模型下载（约 200 MiB）与加载，超时给足（300s）；后续页 ~数秒。
 */
async function recognizeByPix2Text(baseUrl: string, png: Buffer): Promise<{ text: string; confidence: number; lines: OcrLineRecord[] }> {
  const response = await fetch(`${baseUrl}/recognize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image_b64: png.toString('base64') }),
    signal: AbortSignal.timeout(300_000)
  })
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; blocks?: P2tBlock[]; error?: string } | null
  if (!response.ok || !payload?.ok || !payload.blocks) {
    throw new Error(`Pix2Text 识别失败：${payload?.error ?? `HTTP ${response.status}`}`)
  }
  const blocks = payload.blocks.filter((b) => b.text.trim() || b.type.includes('formula'))
  if (blocks.length === 0) return { text: '', confidence: 0, lines: [] }

  // y 中心聚类：块按 y 排序，中心差超过"行高阈值"断行
  const withMeta = blocks.map((b) => {
    const [x1, y1, x2, y2] = b.position ?? [0, 0, 0, 0]
    return { ...b, x1, y1, x2, y2, yMid: (y1 + y2) / 2, height: Math.max(1, y2 - y1) }
  })
  const heights = withMeta.map((b) => b.height).sort((a, b) => a - b)
  const medianH = heights[Math.floor(heights.length / 2)] || 10
  const rowGap = medianH * 0.6

  const rows: typeof withMeta[] = []
  for (const block of [...withMeta].sort((a, b) => a.yMid - b.yMid)) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(block.yMid - last[last.length - 1].yMid) < rowGap) last.push(block)
    else rows.push([block])
  }

  const lines: OcrLineRecord[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x1 - b.x1)
    // 全行为独立公式 → 独立 $$ 行；否则拼接（text 直拼、embedded → $..$）
    if (row.length === 1 && (row[0].type === 'isolated' || row[0].type.includes('isolated'))) {
      const b = row[0]
      lines.push({ text: `$$${b.text.trim()}$$`, confidence: 90, bbox: toBbox(b) })
      continue
    }
    let text = ''
    for (const b of row) {
      if (b.type === 'isolated' || b.type.includes('isolated')) text += ` $$${b.text.trim()}$$ `
      else if (b.type.includes('formula') || b.type === 'embedded') text += `$${b.text.trim()}$`
      else text += (text && !text.endsWith(' ') ? ' ' : '') + b.text.trim()
    }
    const x1 = Math.min(...row.map((b) => b.x1)), y1 = Math.min(...row.map((b) => b.y1))
    const x2 = Math.max(...row.map((b) => b.x2)), y2 = Math.max(...row.map((b) => b.y2))
    lines.push({ text: text.trim(), confidence: 88, bbox: { x1, y1, x2, y2: y1, x3: x2, y3: y2, x4: x1, y4: y2 } })
  }
  return { text: lines.map((l) => l.text).join('\n'), confidence: 88, lines }
}

function toBbox(b: { x1: number; y1: number; x2: number; y2: number }): OcrLineRecord['bbox'] {
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y1, x3: b.x2, y3: b.y2, x4: b.x1, y4: b.y2 }
}
