import { readFile } from 'node:fs/promises'
import { OfficeParser } from 'officeparser'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { MaterialFormat, ParsedBlock } from '@shared/types'
import { chunkText } from '@shared/textChunk'

/** 格式解码、结构分块复用开源库；此层只保留项目需要的来源定位。 */
export async function parseMaterial(file: string, format: MaterialFormat, progress: (percent: number) => void = () => undefined, captureSources = false): Promise<{ blocks: ParsedBlock[]; warnings: string[]; units: ParsedBlock[] }> {
  const bytes = new Uint8Array(await readFile(file))
  if (bytes.length > 50 * 1024 * 1024) throw new Error('单个材料不能超过 50 MiB，请拆分后导入')
  const blocks: ParsedBlock[] = [], warnings: string[] = []
  const units: ParsedBlock[] = []
  if (format === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const pdfRoot = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'))
    // PDF.js 先验证 URL 形式的末尾斜杠，再交给 Node 文件读取；Windows 路径也须使用 /。
    const assetDir = (name: string): string => join(pdfRoot, name).replaceAll('\\', '/') + '/'
    const loading = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: true, cMapUrl: assetDir('cmaps'), cMapPacked: true, standardFontDataUrl: assetDir('standard_fonts'), wasmUrl: assetDir('wasm') })
    const doc = await loading.promise
    try {
      if (doc.numPages > 3000) throw new Error('PDF 超过 3000 页，请拆分导入')
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber)
        const extracted = await page.getTextContent()
        const value = extracted.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
        if (captureSources) units.push({ text: value, heading: `第 ${pageNumber} 页`, locator: { kind: 'pdf', page: pageNumber } })
        if (!value) warnings.push(`第 ${pageNumber} 页需要 OCR，当前仅保留原页定位`)
        for (const part of chunkText(value || '本页暂无可提取文字，请查看原页。', { maxChars: 900, overlap: 60 })) blocks.push({ text: part.text, heading: `第 ${pageNumber} 页`, locator: { kind: 'pdf', page: pageNumber, bbox: page.view, pageSize: [page.view[2] - page.view[0], page.view[3] - page.view[1]] } })
        if (blocks.length > 50_000) throw new Error('文档条目过多，请拆分导入')
        progress(Math.round(pageNumber / doc.numPages * 95))
        page.cleanup()
      }
    } finally { await loading.destroy() }
  } else {
    progress(10)
    const ast = await OfficeParser.parseOffice(file, {
      ocr: false, extractAttachments: false, allowRemoteAssets: false,
      ignoreNotes: true, ignoreComments: true, ignoreHeadersAndFooters: true, ignoreSlideMasters: true,
      decompressionLimits: { maxUncompressedBytes: 100 * 1024 * 1024, maxZipEntries: 10_000, maxXmlElements: 500_000, maxTableCells: 100_000 }
    })
    if (ast.type !== format) throw new Error('文件内容与扩展名不符，请检查文件格式')
    progress(70)
    const chunks = await ast.to('chunks', { chunksConfig: { strategy: 'document-structure', splitBy: format === 'pptx' ? 'slide' : 'paragraph', maxChunkSize: 900, tableSplitStrategy: 'row' } })
    if (chunks.value.length > 50_000) throw new Error('文档条目过多，请拆分导入')
    chunks.value.forEach((chunk, index) => {
      if (chunk.text.trim()) blocks.push({ text: chunk.text, heading: chunk.metadata.closestHeading ?? '', locator: { kind: format, slide: chunk.metadata.slideNumber, source: `chunk:${index + 1}` } })
    })
    if (captureSources) {
      // 来源表格整体展开；检索用 row 模式会重复表头，不能作为规范正文。
      const sourceChunks = await ast.to('chunks', { chunksConfig: { strategy: 'document-structure', splitBy: format === 'pptx' ? 'slide' : 'paragraph', maxChunkSize: 100_000, tableSplitStrategy: 'flatten' } })
      sourceChunks.value.forEach((chunk, index) => { if (chunk.text.trim()) units.push({ text: chunk.text, heading: chunk.metadata.closestHeading ?? '', locator: { kind: format, slide: chunk.metadata.slideNumber, source: `source:${index + 1}` } }) })
    }
    warnings.push(...[...ast.warnings, ...chunks.messages].map(issue => issue.message))
    warnings.push(format === 'docx' ? 'Word 按结构条目定位，不等同于原文页码。' : 'PPT 按幻灯片定位；不提取演讲者备注。')
    warnings.push('文字与表格已提取；图像、公式及排版请对照原件。未启用 OCR，也不会下载识别模型。')
  }
  if (!blocks.length) throw new Error('没有提取到可用文字；请检查文件，或先转换/OCR 后重试')
  if (blocks.reduce((size, block) => size + block.text.length, 0) > 16_000_000) throw new Error('提取文字超过 1600 万字符，请拆分导入')
  return { blocks, warnings: [...new Set(warnings)].slice(0, 3000), units }
}
