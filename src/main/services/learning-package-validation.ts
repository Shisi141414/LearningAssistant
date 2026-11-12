import Ajv2020 from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import schema from '../../../shared/learning-package.schema.json' with { type: 'json' }
import type { MaterialLocator } from '@shared/types'
import type { LearningPackage } from '@shared/learning-package'
import { learningPackageFiles, learningPackageLimits as limits } from '@shared/learning-package'
import { validateLearningState, entryText } from '@shared/learning-document'
import { validLearningPdfFigureLocator } from '@shared/learning-crops'
import { conceptKey } from '@shared/concept-matcher'
import { readableOcr } from '@shared/material-ocr'

const validate = new Ajv2020({ strict: true, allErrors: false }).compile<LearningPackage>(schema)
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
function unique(ids: string[], label: string): void { if (new Set(ids).size !== ids.length) throw new Error(`${label}编号重复`) }
export function packageLocator(json: string, kind: MaterialLocator['kind']): MaterialLocator {
  const locator = JSON.parse(json) as MaterialLocator
  if (!locator || typeof locator !== 'object' || Array.isArray(locator) || locator.kind !== kind || Object.keys(locator).some(key => !['kind', 'page', 'slide', 'paragraph', 'source', 'bbox', 'pageSize', 'crop'].includes(key))) throw new Error('包内来源位置无效')
  for (const field of ['page', 'slide', 'paragraph'] as const) if (locator[field] !== undefined && (!Number.isSafeInteger(locator[field]) || locator[field]! < 1 || locator[field]! > 100_000)) throw new Error('包内页码或段落无效')
  if (kind === 'pdf' && locator.page === undefined || locator.source !== undefined && (typeof locator.source !== 'string' || locator.source.length > 1000 || locator.source.includes('\0'))) throw new Error('包内来源位置缺失')
  for (const [field, length] of [['bbox', 4], ['pageSize', 2]] as const) if (locator[field] !== undefined && (!Array.isArray(locator[field]) || locator[field]!.length !== length || !locator[field]!.every(Number.isFinite))) throw new Error('包内页面坐标无效')
  if (locator.crop !== undefined && (!validLearningPdfFigureLocator(locator) || Object.keys(locator.crop).some(key => !['rect', 'rotation', 'engine'].includes(key)))) throw new Error('包内 PDF 选区无效')
  return locator
}
/** Schema 通过后仍需验证覆盖、引用与来源一致性；不修改输入，也不修补坏数据。 */
export function validateLearningPackage(value: unknown): asserts value is LearningPackage {
  if (value && typeof value === 'object' && 'format' in value && value.format === 'learning-assistant/note') throw new Error('这是笔记文档包，请到笔记页导入笔记文档包')
  if (!validate(value)) throw new Error(`学习文档包格式不支持或字段无效：${validate.errors?.[0]?.instancePath || '/'} ${validate.errors?.[0]?.message || ''}`)
  const doc = value
  if (!doc.document.title.trim() || /[/\\:\0]/.test(doc.original.file_name)) throw new Error('包内标题或原件文件名无效')
  if (doc.original.path !== `source/original.${doc.original.format}`) throw new Error('原件格式与路径不符')
  const legacy = doc.original.format === 'doc' || doc.original.format === 'ppt'
  const kind = doc.original.format === 'doc' ? 'docx' : doc.original.format === 'ppt' ? 'pptx' : doc.original.format
  if (legacy ? !doc.conversion || doc.conversion.format !== kind || doc.conversion.path !== `source/converted.${kind}` : doc.conversion !== null) throw new Error('旧格式转换链缺失或与原件不符')
  if (doc.original.format !== 'pdf' && (doc.ocr_pages.length || doc.original.derivation !== 'native')) throw new Error('只有 PDF 可携带 OCR 派生来源')
  const files = learningPackageFiles(doc)
  unique(files.map(file => file.path.toLowerCase()), '文件路径')
  if (files.reduce((sum, file) => sum + file.byte_length, 0) > limits.unpackedBytes || doc.assets.reduce((sum, asset) => sum + asset.byte_length, 0) > limits.assetsBytes) throw new Error('包内文件或配图总容量超限')
  unique(doc.sources.map(source => source.id), '来源'); unique(doc.assets.map(asset => asset.id), '附件'); unique(doc.concepts.map(concept => concept.id), '概念')
  if (doc.sources.some((source, i) => source.ordinal !== i) || doc.sources.reduce((n, source) => n + source.raw_text.length, 0) > 2_000_000) throw new Error('来源序号不连续或文字总量超限')
  const sourceLocators = new Map(doc.sources.map(source => [source.id, packageLocator(source.locator_json, kind)]))
  validateLearningState(doc.state, doc.sources)
  const assetIds = new Set(doc.assets.map(asset => asset.id))
  for (const entry of doc.state.entries) if (entry.figures?.some(figure => !assetIds.has(figure.asset_id))) throw new Error('条目配图不在文档包中')
  for (const asset of doc.assets) {
    if (asset.path !== `assets/${asset.id}.${asset.mime_type === 'image/png' ? 'png' : 'jpg'}` || asset.width * asset.height > 16_000_000) throw new Error('附件路径、格式或像素数量无效')
    const location = packageLocator(asset.locator_json, kind)
    if (kind === 'pdf' ? !validLearningPdfFigureLocator(location) : !/^image:\d+(\.\d+)*$/.test(location.source ?? '')) throw new Error('图片缺少可追溯的来源位置')
  }
  if (kind === 'pdf' && doc.asset_extraction || kind !== 'pdf' && doc.assets.length && !doc.asset_extraction) throw new Error('图片提取记录与来源格式不符')
  unique(doc.ocr_pages.map(page => String(page.page)), 'OCR 页')
  const ocr = new Map(doc.ocr_pages.map(page => [page.page, page]))
  for (const page of doc.ocr_pages) {
    const model = JSON.parse(page.model_json)
    if (!Array.isArray(JSON.parse(page.lines_json)) || !model || typeof model !== 'object' || Array.isArray(model) || ![...sourceLocators.values()].some(locator => locator.page === page.page)) throw new Error('OCR 元数据或页码无效')
  }
  for (const source of doc.sources) {
    const page = ocr.get(sourceLocators.get(source.id)!.page ?? 0)
    if ((page || source.extraction !== 'native') && (!page || source.raw_text !== (page.corrected_text ?? readableOcr(page.raw_text)) || source.extraction !== (page.corrected_text === null ? 'ocr' : 'manual'))) throw new Error('OCR 原文、校正与规范来源不一致')
  }
  validatePackageConcepts(doc.concepts)
  const concepts = new Set(doc.concepts.map(concept => concept.id)), entries = new Map(doc.state.entries.map(entry => [entry.id, entry])), sources = new Map(doc.sources.map(source => [source.id, source]))
  unique(doc.evidence.map(evidence => `${evidence.concept_id}:${evidence.entry_id}`), '知识证据')
  for (const evidence of doc.evidence) {
    const entry = entries.get(evidence.entry_id)
    if (!entry || !concepts.has(evidence.concept_id)) throw new Error('知识证据引用不存在')
    const text = entryText(entry, sources)
    if (!text.trim() || text.length > 40_000 || sha(text) !== evidence.quote_sha256 || evidence.memo.includes('\0')) throw new Error('知识证据原文散列不符')
  }
}

/** 两类文档共用概念词典限制，避免交换包引入歧义别名或无限词典。 */
export function validatePackageConcepts(concepts: LearningPackage['concepts']): void {
  let dictionarySize = 0
  for (const concept of concepts) {
    const names = [concept.name, ...concept.aliases]
    if (names.some(name => !name.trim() || name !== name.trim() || name.includes('\0')) || concept.summary.includes('\0')) throw new Error('概念名称或别名无效')
    unique(names.map(conceptKey), '同一概念名称与别名'); dictionarySize += names.reduce((n, name) => n + name.length, 0)
  }
  if (dictionarySize > 100_000) throw new Error('概念词典超出十万字符')
}
