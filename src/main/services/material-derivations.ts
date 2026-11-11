import { nanoid } from 'nanoid'
import type { MaterialBlock, MaterialVersion, OcrCorrectionInput, OcrInput, OcrPage, ParsedBlock } from '@shared/types'
import { ocrBlocks, readableOcr } from '@shared/material-ocr'
import { getDb } from './db'

export function derivedParent(id: string): MaterialVersion {
  const row = getDb().prepare('SELECT v.* FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ? AND m.archived = 0').get(id) as MaterialVersion | undefined
  if (!row || row.status !== 'ready' || row.format !== 'pdf') throw new Error('请选择可阅读的 PDF 版本')
  return row
}
export function validateOcrRange(input: OcrInput): void {
  derivedParent(input.version_id)
  if (!Number.isSafeInteger(input.from_page) || !Number.isSafeInteger(input.to_page) || input.from_page < 1 || input.to_page < input.from_page || input.to_page - input.from_page >= 20) throw new Error('每次请选择连续的 1–20 页')
  const count = getDb().prepare("SELECT COUNT(DISTINCT json_extract(locator_json, '$.page')) AS n FROM material_blocks WHERE version_id = ? AND json_extract(locator_json, '$.page') BETWEEN ? AND ?").get(input.version_id, input.from_page, input.to_page) as { n: number }
  if (count.n !== input.to_page - input.from_page + 1) throw new Error('所选页码超出材料范围')
}
/** 派生版本引用同一托管原件，父版本内容永远不更新。调用者在事务内完成创建/发布。 */
export function insertDerived(parent: MaterialVersion, derivation: 'ocr' | 'correction', processing: object, status: 'queued' | 'ready'): string {
  const id = nanoid()
  getDb().prepare(`INSERT INTO material_versions (id, material_id, file_name, file_path, format, fingerprint, status, progress, created_at, parent_version_id, derivation, processing_json)
    SELECT ?, material_id, file_name, file_path, format, fingerprint, ?, ?, ?, id, ?, ? FROM material_versions WHERE id = ?`).run(id, status, status === 'ready' ? 100 : 0, Date.now(), derivation, JSON.stringify(processing), parent.id)
  return id
}
export function materialOcrPage(input: { version_id: string; page: number }): OcrPage | null {
  derivedParent(input.version_id)
  return getDb().prepare('SELECT page, raw_text, corrected_text, confidence, width, height, lines_json, model_json FROM material_ocr_pages WHERE version_id = ? AND page = ?').get(input.version_id, input.page) as OcrPage | undefined ?? null
}
export function mergeDerivedBlocks(parentId: string, from: number, to: number, replacements: ParsedBlock[]): ParsedBlock[] {
  const parent = getDb().prepare('SELECT * FROM material_blocks WHERE version_id = ? ORDER BY ordinal').all(parentId) as MaterialBlock[]
  const remaining: ParsedBlock[] = parent.map(block => ({ heading: block.heading, text: block.text, locator: JSON.parse(block.locator_json) })).filter(block => !((block.locator.page ?? 0) >= from && (block.locator.page ?? 0) <= to))
  const blocks = [...remaining, ...replacements].sort((a, b) => (a.locator.page ?? 0) - (b.locator.page ?? 0))
  if (blocks.length > 50_000 || blocks.reduce((n, block) => n + block.text.length, 0) > 16_000_000) throw new Error('派生文字超过材料容量限制，请拆分材料')
  return blocks
}
function inheritPages(id: string, parent: string): void {
  getDb().prepare(`INSERT INTO material_ocr_pages SELECT ?, page, raw_text, corrected_text, confidence, width, height, lines_json, model_json FROM material_ocr_pages WHERE version_id = ?`).run(id, parent)
}
export function writeDerivedBlocks(id: string, blocks: ParsedBlock[]): void {
  const insert = getDb().prepare('INSERT INTO material_blocks (id, version_id, ordinal, heading, text, locator_json) VALUES (?, ?, ?, ?, ?, ?)')
  blocks.forEach((block, ordinal) => insert.run(nanoid(), id, ordinal, block.heading, block.text, JSON.stringify(block.locator)))
}
function promote(id: string, parent: MaterialVersion): void {
  // 任务运行期间若导入了其他版本，不能把新选择倒退为旧任务的分支。
  getDb().prepare('UPDATE materials SET current_version_id = ? WHERE id = ? AND current_version_id = ? AND archived = 0').run(id, parent.material_id, parent.id)
}
export function completeOcrVersion(id: string, input: OcrInput, pages: OcrPage[], warnings: string[]): string[] {
  const parent = derivedParent(input.version_id)
  if (pages.length !== input.to_page - input.from_page + 1 || pages.some((page, i) => page.page !== input.from_page + i || page.raw_text.length > 100_000 || !Number.isFinite(page.confidence) || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) || page.width < 1 || page.height < 1 || page.width > 8192 || page.height > 8192 || page.width * page.height > 6_010_000 || page.lines_json.length > 2_000_000)) throw new Error('识别结果不完整或超出限制')
  const replacements = pages.flatMap(page => ocrBlocks(readableOcr(page.raw_text), page.page))
  writeDerivedBlocks(id, mergeDerivedBlocks(parent.id, input.from_page, input.to_page, replacements))
  inheritPages(id, parent.id)
  const put = getDb().prepare('INSERT OR REPLACE INTO material_ocr_pages (version_id, page, raw_text, corrected_text, confidence, width, height, lines_json, model_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (const page of pages) put.run(id, page.page, page.raw_text, null, page.confidence, page.width, page.height, page.lines_json, page.model_json)
  const oldWarnings = JSON.parse(parent.warnings_json) as string[]
  const selected = new Set(pages.map(page => page.page))
  const inherited = oldWarnings.filter(warning => { const match = /^第 (\d+) 页(?:需要 OCR| OCR)/.exec(warning); return !match || !selected.has(Number(match[1])) })
  promote(id, parent)
  return [...new Set([...inherited, ...warnings])].slice(0, 3000)
}
export function correctOcrPage(input: OcrCorrectionInput): string {
  const parent = derivedParent(input.version_id)
  if (!Number.isSafeInteger(input.page) || input.page < 1 || !input.text.trim() || input.text.length > 100_000) throw new Error('请输入不超过十万字符的校正文字')
  if (!materialOcrPage(input)) throw new Error('请先识别这一页，再进行校正')
  return getDb().transaction(() => {
    const id = insertDerived(parent, 'correction', { page: input.page }, 'ready')
    const replacement = ocrBlocks(input.text, input.page).map(block => ({ ...block, locator: { ...block.locator, source: 'manual-correction' } }))
    writeDerivedBlocks(id, mergeDerivedBlocks(parent.id, input.page, input.page, replacement))
    inheritPages(id, parent.id)
    getDb().prepare('UPDATE material_ocr_pages SET corrected_text = ? WHERE version_id = ? AND page = ?').run(input.text, id, input.page)
    const warnings = (JSON.parse(parent.warnings_json) as string[]).filter(warning => !warning.startsWith(`第 ${input.page} 页 OCR`))
    getDb().prepare('UPDATE material_versions SET warnings_json = ? WHERE id = ?').run(JSON.stringify(warnings), id)
    promote(id, parent)
    return id
  })()
}
