import type { ParsedBlock } from './types'
import { chunkText } from './textChunk'

/** 只清理汉字间的排版空格，保留英文词界；引擎原文另行保存。 */
export const readableOcr = (text: string): string => text.replace(/(?<=\p{Script=Han})[\t ]+(?=\p{Script=Han})/gu, '').trim()
export function ocrBlocks(text: string, page: number): ParsedBlock[] {
  return chunkText(text.trim() || '本页 OCR 未识别出文字，请查看原页并校正。', { maxChars: 900, overlap: 60 }).map(part => ({ text: part.text, heading: `第 ${page} 页`, locator: { kind: 'pdf', page, source: 'ocr' } }))
}
