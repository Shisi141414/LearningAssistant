import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readdir, truncate, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { dataRoot, invoke } from './test-support.mjs'
import { validLearningCropRect, learningCropRect } from '../shared/learning-crops.ts'
import { renderLearningPdfCrop } from '../src/main/services/learning-pdf-crops.ts'
import { storeLearningAssets } from '../src/main/services/learning-assets.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { getDb, closeDb, dbFilePath } from '../src/main/services/db.ts'
import { initialLearningState } from '../shared/learning-document.ts'

// 实际产物为 CommonJS；单测直接载入 TS 时提供相同的模块定位基准。
globalThis.__filename = fileURLToPath(import.meta.url)
registerAllIpc(); after(closeDb)
let sequence = 0
const id = () => `crop-${++sequence}`
const ok = r => { assert.equal(r.ok, true, r.error); return r.data }
function pdf(rotation = 0) {
  const content = '1 0 0 rg 10 70 100 50 re f 0 1 0 rg 110 70 100 50 re f 0 0 1 rg 10 20 100 50 re f 1 1 0 rg 110 20 100 50 re f'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `<< /Type /Page /Parent 2 0 R /MediaBox [10 20 210 120] /CropBox [10 20 210 120] /Rotate ${rotation} /Resources << >> /Contents 4 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let data = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(data)
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
  return Buffer.from(data)
}
async function render(rotation = 0, rect = [0, 0, 0.5, 0.5]) {
  const bytes = pdf(rotation), file = join(dataRoot, `${id()}.pdf`)
  await writeFile(file, bytes)
  return renderLearningPdfCrop(file, createHash('sha256').update(bytes).digest('hex'), { page: 1, rect })
}
function fixture() {
  const db = getDb(), material = id(), version = id(), document = id(), revision = id(), source = { id: id(), ordinal: 0, raw_text: '图示与原始来源不变。', heading: '', locator_json: '{"kind":"pdf","page":1}', extraction: 'native' }
  const state = initialLearningState([source], id)
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?,?,0)').run(material, 'PDF 选区教材')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.pdf','unused.pdf','pdf','hash','ready',0)").run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document, version)
  db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,0,?,?,?,?)').run(source.id, document, source.raw_text, '', source.locator_json, 'native')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
  return { material, version, document, revision, source }
}

test('PDF 选区归一化、反向拖动和严格 IPC 拒绝越界/非有限数/附加路径', async () => {
  assert.deepEqual(learningCropRect([0.8, 0.7], [-0.2, 1.2]), [0, 0.7, 0.8, 0.30000000000000004])
  assert.equal(validLearningCropRect([0, 0, 1, 1]), true)
  for (const rect of [[0, 0, 0, 1], [-1, 0, 1, 1], [0.8, 0, 0.3, 1], [0, NaN, 1, 1], [0, 0, Infinity, 1], [0, 0, 1], null]) {
    assert.equal(validLearningCropRect(rect), false)
    assert.equal((await invoke('learning:assetsCrop', { version_id: 'x', page: 1, rect })).ok, false)
  }
  for (const extra of [{ page: 0 }, { page: 1.2 }, { page: 100001 }, { file: 'private.pdf' }, { bytes: 'image' }]) assert.equal((await invoke('learning:assetsCrop', { version_id: 'x', page: 1, rect: [0, 0, 1, 1], ...extra })).ok, false)
})
test('真实 PDF 选区像素对应原页，支持四种旋转及非零页面原点', async () => {
  for (const [rotation, rgb] of [[0, [255, 0, 0]], [90, [0, 0, 255]], [180, [255, 255, 0]], [270, [0, 255, 0]]]) {
    const result = await render(rotation), asset = result.assets[0], image = await loadImage(asset.bytes), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    assert.deepEqual([...ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3), rgb)
    const locator = JSON.parse(asset.locator_json)
    assert.equal(locator.crop.rotation, rotation); assert.equal(locator.page, 1)
    assert.match(locator.crop.engine, /^pdfjs .*pdf-crop-v1$/)
    assert.deepEqual(locator.crop.rect, [0, 0, 0.5, 0.5]); assert.equal(locator.bbox.length, 4)
    assert.equal(asset.width * asset.height, 20_000); assert.equal(asset.sha256, createHash('sha256').update(asset.bytes).digest('hex'))
  }
})
test('PDF 原件变动、无效页码、过小选区和损坏原件不发布图片', async () => {
  const bytes = pdf(), file = join(dataRoot, `${id()}.pdf`), hash = createHash('sha256').update(bytes).digest('hex')
  await writeFile(file, bytes)
  await assert.rejects(renderLearningPdfCrop(file, '0'.repeat(64), { page: 1, rect: [0, 0, 1, 1] }), /原件发生变化/)
  await assert.rejects(renderLearningPdfCrop(file, hash, { page: 2, rect: [0, 0, 1, 1] }), /共 1 页/)
  await assert.rejects(renderLearningPdfCrop(file, hash, { page: 1, rect: [0, 0, 0.001, 0.001] }), /选区过小/)
  await writeFile(file, 'broken'); await assert.rejects(renderLearningPdfCrop(file, createHash('sha256').update('broken').digest('hex'), { page: 1, rect: [0, 0, 1, 1] }))
})
test('PDF 多次保存与重复复用不改来源/修订/证据；人工关联及历史保留', async () => {
  const f = fixture(), first = await render(), second = await render(0, [0.5, 0.5, 0.5, 0.5])
  const concept = ok(await invoke('concepts:save', { name: id(), summary: '', aliases: [], subject_id: null }))
  const source = { kind: 'learning', material_id: f.material, version_id: f.version, revision_id: f.revision, entry_id: ok(await invoke('learning:get', { version_id: f.version })).state.entries[0].id }
  const evidence = ok(await invoke('evidence:add', { concept_id: concept.id, source, role: 'source', memo: '' })).evidence
  await storeLearningAssets(f.version, first, undefined, 'pdf'); await storeLearningAssets(f.version, first, undefined, 'pdf'); await storeLearningAssets(f.version, second, undefined, 'pdf')
  const document = ok(await invoke('learning:get', { version_id: f.version }))
  assert.equal(document.assets.length, 2); assert.equal(document.asset_extraction, null); assert.equal(document.revision_id, f.revision); assert.deepEqual(document.sources, [f.source])
  const changed = ok(await invoke('learning:change', { version_id: f.version, expected_revision_id: f.revision, entry_id: source.entry_id, action: 'figure', figure: { asset_id: document.assets[0].id, caption: 'PDF 人工配图' } }))
  assert.equal(changed.state.entries[0].figures[0].caption, 'PDF 人工配图')
  assert.equal(ok(await invoke('learning:get', { version_id: f.version, revision_id: f.revision })).state.entries[0].figures, undefined)
  assert.equal(getDb().prepare('SELECT quote_sha256 FROM knowledge_evidence WHERE id=?').get(evidence.id).quote_sha256, evidence.quote_sha256)
})
test('PDF 保存取消与数据库失败清理本批目录；不接受伪造来源或非 PDF 文档', async () => {
  const f = fixture(), result = await render(), directory = join(dirname(dbFilePath()), 'materials', 'learning-assets'), before = await readdir(directory)
  let checks = 0
  await assert.rejects(storeLearningAssets(f.version, result, () => ++checks > 1, 'pdf'), /取消/)
  assert.deepEqual(await readdir(directory), before)
  getDb().exec("CREATE TRIGGER reject_pdf BEFORE INSERT ON learning_assets BEGIN SELECT RAISE(ABORT,'模拟选区失败'); END")
  try { await assert.rejects(storeLearningAssets(f.version, result, undefined, 'pdf'), /模拟选区失败/) } finally { getDb().exec('DROP TRIGGER reject_pdf') }
  assert.deepEqual(await readdir(directory), before)
  const invalid = structuredClone(result); invalid.assets[0].locator_json = '{"kind":"pdf","source":"pdf-crop:v1","page":1}'
  await assert.rejects(storeLearningAssets(f.version, invalid, undefined, 'pdf'), /来源无效/)
  getDb().prepare("UPDATE material_versions SET format='docx' WHERE id=?").run(f.version)
  await assert.rejects(storeLearningAssets(f.version, result, undefined, 'pdf'), /只能从 PDF/)
})
test('PDF 附件的分批保存执行文档总数量和容量限制', async () => {
  const f = fixture(), result = await render()
  await storeLearningAssets(f.version, result, undefined, 'pdf')
  const row = getDb().prepare('SELECT * FROM learning_assets WHERE document_id=?').get(f.document)
  const put = getDb().prepare('INSERT INTO learning_assets(id,document_id,mime_type,sha256,file_path,width,height,locator_json,alt_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,0)')
  for (let i = 1; i < 100; i++) put.run(id(), f.document, row.mime_type, row.sha256, row.file_path, row.width, row.height, '{}', '')
  const next = await render(0, [0.5, 0, 0.5, 0.5])
  await assert.rejects(storeLearningAssets(f.version, next, undefined, 'pdf'), /100 张/)
  getDb().prepare('DELETE FROM learning_assets WHERE document_id=? AND id<>?').run(f.document, row.id)
  const stored = join(dirname(dbFilePath()), row.file_path)
  await chmod(stored, 0o644); await truncate(stored, 50 * 1024 * 1024)
  await assert.rejects(storeLearningAssets(f.version, next, undefined, 'pdf'), /50 MiB/)
})
