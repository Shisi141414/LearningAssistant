import { stat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import type { LearningPdfCrop, MaterialLocator } from '@shared/types'
import { validLearningCropRect } from '@shared/learning-crops'
import type { ParsedLearningAssets } from './learning-asset-parser'

/** 在工作线程直接渲染原件选区；不接受渲染进程提供的图片或文件路径。 */
export async function renderLearningPdfCrop(file: string, fingerprint: string, input: Pick<LearningPdfCrop, 'page' | 'rect'>): Promise<ParsedLearningAssets> {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 100_000 || !validLearningCropRect(input.rect)) throw new Error('请选择有效 PDF 页码与页内选区')
  if ((await stat(file)).size > 50 * 1024 * 1024) throw new Error('材料超过 50 MiB，请拆分材料')
  const bytes = await readFile(file)
  if (bytes.length > 50 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== fingerprint) throw new Error('原件发生变化，请作为新版本导入后再选择配图')
  const require = createRequire(__filename), root = dirname(require.resolve('pdfjs-dist/package.json'))
  const assets = (name: string): string => join(root, name).replaceAll('\\', '/') + '/'
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(bytes), cMapUrl: assets('cmaps'), cMapPacked: true, standardFontDataUrl: assets('standard_fonts'), wasmUrl: assets('wasm') })
  try {
    const document = await loading.promise
    if (input.page > document.numPages) throw new Error(`原件共 ${document.numPages} 页，请选择范围内的页码`)
    const page = await document.getPage(input.page), base = page.getViewport({ scale: 1 })
    if (![base.width, base.height].every(n => Number.isFinite(n) && n > 0 && n <= 100_000)) throw new Error('PDF 页面尺寸无效或过大')
    const [x, y, w, h] = input.rect
    const scale = Math.min(2, 4095 / (base.width * w), 4095 / (base.height * h), Math.sqrt(15_900_000 / (base.width * w * base.height * h)))
    const viewport = page.getViewport({ scale }), left = Math.floor(x * viewport.width), top = Math.floor(y * viewport.height)
    const width = Math.ceil((x + w) * viewport.width) - left, height = Math.ceil((y + h) * viewport.height) - top
    if (width < 4 || height < 4 || width * height > 16_000_000) throw new Error('选区过小或过大，请重新选择')
    const canvas = createCanvas(width, height)
    await page.render({ canvas: canvas as never, canvasContext: canvas.getContext('2d') as never, viewport, transform: [1, 0, 0, 1, -left, -top], background: 'white' }).promise
    const image = canvas.toBuffer('image/png')
    if (image.length > 8 * 1024 * 1024) throw new Error('选区图片超过 8 MiB，请缩小区域')
    const first = base.convertToPdfPoint(x * base.width, y * base.height), last = base.convertToPdfPoint((x + w) * base.width, (y + h) * base.height)
    const locator: MaterialLocator = { kind: 'pdf', source: 'pdf-crop:v1', page: input.page, bbox: [Math.min(first[0], last[0]), Math.min(first[1], last[1]), Math.max(first[0], last[0]), Math.max(first[1], last[1])], pageSize: [base.width, base.height], crop: { rect: input.rect, rotation: base.rotation, engine: `pdfjs ${require('pdfjs-dist/package.json').version} / pdf-crop-v1` } }
    return { assets: [{ bytes: image, mime_type: 'image/png', sha256: createHash('sha256').update(image).digest('hex'), width, height, locator_json: JSON.stringify(locator), alt_text: `PDF 第 ${input.page} 页人工选区` }], warnings: [] }
  } finally { await loading.destroy() }
}
