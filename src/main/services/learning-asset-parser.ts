import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { OfficeParser, type OfficeParserAST, type OfficeContentNode } from 'officeparser'
import { imageSize } from 'image-size'
import { loadImage } from '@napi-rs/canvas'
import type { MaterialLocator } from '@shared/types'

export interface ParsedLearningAsset { bytes: Uint8Array; mime_type: 'image/png' | 'image/jpeg'; sha256: string; width: number; height: number; locator_json: string; alt_text: string }
export interface ParsedLearningAssets { assets: ParsedLearningAsset[]; warnings: string[] }
/** 按 AST 出现位置保留图片；没有来源节点的孤立附件不猜归属。仅工作线程调用。 */
export async function collectLearningAssets(ast: Pick<OfficeParserAST, 'content' | 'attachments' | 'warnings'>, format: 'docx' | 'pptx'): Promise<ParsedLearningAssets> {
  const assets: ParsedLearningAsset[] = [], warnings = ast.warnings.map(issue => issue.message).slice(0, 200)
  const attachments = new Map(ast.attachments.map(item => [item.name, item]))
  const stack = ast.content.map((node, index) => ({ node, path: String(index + 1), slide: undefined as number | undefined })).reverse()
  let total = 0, visited = 0
  while (stack.length) {
    const { node, path, slide } = stack.pop()!
    if (++visited > 500_000 || path.length > 1000) throw new Error('图片结构超过限制，请拆分材料')
    const metadata = node.metadata as { slideNumber?: number; attachmentName?: string; altText?: string } | undefined
    const currentSlide = node.type === 'slide' ? metadata?.slideNumber ?? Number(path.split('.')[0]) : slide
    if (node.type === 'image') {
      const label = currentSlide ? `幻灯片 ${currentSlide} / 图片 ${path}` : `结构图片 ${path}`
      const attachment = attachments.get(metadata?.attachmentName ?? '')
      if (!attachment || !['image/png', 'image/jpeg'].includes(attachment.mimeType)) { warnings.push(`${label} 未支持或没有内嵌 PNG/JPEG，请对照原件。`); continue }
      if (attachment.data.length > 11_184_812) { warnings.push(`${label} 超过 8 MiB，未提取。`); continue }
      const bytes = Buffer.from(attachment.data, 'base64')
      try {
        const dimensions = imageSize(bytes)
        const mime = dimensions.type === 'png' ? 'image/png' : dimensions.type === 'jpg' ? 'image/jpeg' : null
        if (!mime || mime !== attachment.mimeType || bytes.length > 8 * 1024 * 1024 || !dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 16_000_000) throw new Error('图片格式、尺寸或容量不支持')
        const decoded = await loadImage(bytes)
        if (decoded.width * decoded.height > 16_000_000 || !decoded.width || !decoded.height) throw new Error('图片尺寸不支持')
        if (assets.length >= 100 || total + bytes.length > 50 * 1024 * 1024) throw new RangeError('本篇图片超过 100 张或 50 MiB，请拆分材料')
        const locator: MaterialLocator = { kind: format, source: `image:${path}`, ...(currentSlide ? { slide: currentSlide } : {}) }
        assets.push({ bytes, mime_type: mime, sha256: createHash('sha256').update(bytes).digest('hex'), width: decoded.width, height: decoded.height, locator_json: JSON.stringify(locator), alt_text: (metadata?.altText ?? attachment.altText ?? '').slice(0, 1000) })
        total += bytes.length
      } catch (error) {
        if (error instanceof RangeError) throw error
        warnings.push(`${label} 损坏、格式不符或尺寸过大，未提取；请对照原件。`)
      }
    }
    const children = node.children ?? []
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index] as OfficeContentNode, path: `${path}.${index + 1}`, slide: currentSlide })
  }
  return { assets, warnings: [...new Set(warnings)].slice(0, 300) }
}
export async function parseLearningAssets(file: string, format: 'docx' | 'pptx', fingerprint: string): Promise<ParsedLearningAssets> {
  if ((await stat(file)).size > 50 * 1024 * 1024) throw new Error('材料超过 50 MiB，请拆分后导入')
  const bytes = await readFile(file)
  if (bytes.length > 50 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== fingerprint) throw new Error('原件或转换产物发生变化，不能把配图加入旧文档；请作为新版本导入')
  const ast = await OfficeParser.parseOffice(bytes, { ocr: false, extractAttachments: true, allowRemoteAssets: false, ignoreNotes: true, ignoreComments: true, ignoreHeadersAndFooters: true, ignoreSlideMasters: true, decompressionLimits: { maxUncompressedBytes: 100 * 1024 * 1024, maxZipEntries: 10_000, maxXmlElements: 500_000, maxTableCells: 100_000 } })
  if (ast.type !== format) throw new Error('图片来源格式与材料版本不符')
  return collectLearningAssets(ast, format)
}
