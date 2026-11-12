import Ajv2020 from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import materialSchema from '../../../shared/learning-package.schema.json' with { type: 'json' }
import noteSchema from '../../../shared/note-package.schema.json' with { type: 'json' }
import type { NotePackage } from '@shared/note-package'
import { validateLearningState } from '@shared/learning-document'
import { packageLocator, validatePackageConcepts } from './learning-package-validation'
import type { ArchiveContract } from './learning-package-codec'

const validate = new Ajv2020({ strict: true }).addSchema(materialSchema, 'material').compile<NotePackage>(noteSchema)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function unique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`${label}编号重复`) }
export function validateNotePackage(value: unknown): asserts value is NotePackage {
  if (value && typeof value === 'object' && 'format' in value && value.format === 'learning-assistant/document') throw new Error('这是教材文档包，请到材料库导入学习文档包')
  if (!validate(value)) throw new Error(`笔记文档包字段无效：${validate.errors?.[0]?.instancePath || '/'} ${validate.errors?.[0]?.message || ''}`)
  const doc = value
  if (!doc.document.title.trim() || doc.exported_at < doc.document.created_at) throw new Error('笔记标题或导出时间无效')
  unique(doc.sources.map(source => source.id), '来源'); unique(doc.concepts.map(concept => concept.id), '概念')
  const ids = new Set(doc.sources.map(source => source.id))
  if (Object.keys(doc.origins).length !== ids.size || Object.keys(doc.origins).some(id => !ids.has(id))) throw new Error('笔记来源快照缺失或多余')
  unique(Object.values(doc.origins).map(origin => origin.segment_id), '原始段落')
  if (doc.sources.reduce((n, source) => n + source.raw_text.length, 0) > 2_000_000 || Object.values(doc.origins).reduce((n, origin) => n + origin.raw_text.length, 0) > 2_000_000) throw new Error('笔记正文或原始口述总量超限')
  for (const [ordinal, source] of doc.sources.entries()) {
    const origin = doc.origins[source.id], locator = JSON.parse(source.locator_json)
    if (source.ordinal !== ordinal || !locator || Array.isArray(locator) || Object.keys(locator).sort().join(',') !== 'field,kind,note_id,recorded_at,segment_id,segment_revision' || locator.kind !== 'note' || locator.field !== 'organized_text' || locator.note_id !== doc.document.note_id || locator.segment_id !== origin.segment_id || locator.segment_revision !== origin.segment_revision || locator.recorded_at !== origin.recorded_at) throw new Error('笔记来源位置与口述快照不一致')
    if (origin.material_ref) {
      packageLocator(origin.material_ref.locator_json, origin.material_ref.format === 'doc' ? 'docx' : origin.material_ref.format === 'ppt' ? 'pptx' : origin.material_ref.format)
      if (/[/\\:\0]/.test(origin.material_ref.file_name)) throw new Error('教材来源文件名不得包含磁盘路径')
    }
  }
  validateLearningState(doc.state, doc.sources)
  if (doc.state.entries.some(entry => entry.figures?.length)) throw new Error('笔记尚未支持打包配图附件')
  unique(doc.annotations.map(annotation => annotation.id), '标注')
  for (const item of doc.annotations) if (!ids.has(item.source_id) || item.matches_revision !== (item.segment_revision === doc.origins[item.source_id].segment_revision)) throw new Error('标注引用或修订匹配状态无效')
  validatePackageConcepts(doc.concepts)
  const concepts = new Set(doc.concepts.map(concept => concept.id)), sources = new Map(doc.sources.map(source => [source.id, source]))
  unique(doc.evidence.map(item => `${item.concept_id}:${item.source_id}:${item.field}:${item.quote_sha256}`), '证据')
  for (const item of doc.evidence) {
    if (!ids.has(item.source_id) || !concepts.has(item.concept_id) || !item.quote.trim() || sha(item.quote) !== item.quote_sha256) throw new Error('知识证据引用或原文散列无效')
    const selected = item.field === 'raw_text' ? doc.origins[item.source_id].raw_text : sources.get(item.source_id)!.raw_text
    if (item.matches_revision !== (sha(selected) === item.quote_sha256)) throw new Error('知识证据与修订匹配状态不一致')
  }
}
export const noteArchiveContract: ArchiveContract<NotePackage> = { validate: validateNotePackage, files: () => [] }
