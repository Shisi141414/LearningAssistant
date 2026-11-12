import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import { zipSync, strToU8 } from 'fflate'
import { ZipFile } from 'yazl'
import { readLearningPackage, writeLearningPackage } from '../src/main/services/learning-package-codec.ts'
import { validateLearningPackage } from '../src/main/services/learning-package-validation.ts'
import { learningPackageFiles } from '../shared/learning-package.ts'
import { entryText } from '../shared/learning-document.ts'
import { relatedPackageConcepts } from '../shared/learning-package-concepts.ts'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'learning-package-test-'))
let serial = 0
async function directory() { return mkdtemp(join(root, 'stage-')) }
function fixture() {
  const png = createCanvas(120, 80).toBuffer('image/png'), original = Buffer.from('%PDF-1.4\n原件保留，不等同于提取后的中文\n%%EOF')
  const sources = [
    { id: 's1', ordinal: 0, raw_text: '第一章', heading: '', locator_json: '{"kind":"pdf","page":1}', extraction: 'native' },
    { id: 's2', ordinal: 1, raw_text: '牛顿第二定律 F=ma😀。', heading: '', locator_json: '{"kind":"pdf","page":2}', extraction: 'ocr' },
    { id: 's3', ordinal: 2, raw_text: '由动量定理可得结论。', heading: '', locator_json: '{"kind":"pdf","page":3}', extraction: 'native' }
  ]
  const state = { entries: [
    { id: 'section', type: 'section', title: '第一章', sources: [{ source_id: 's1' }], analysis: { method: 'manual', review_status: 'confirmed' } },
    { id: 'theorem', parent_id: 'section', type: 'theorem', title: '运动定律', sources: [{ source_id: 's2' }], analysis: { method: 'manual', review_status: 'confirmed' }, formulas: [{ range: [7, 11], latex: 'F=m\\frac{\\mathrm{d}v}{\\mathrm{d}t}', display: true }], figures: [{ asset_id: 'image1', caption: '物体受力示意图' }] },
    { id: 'proof', parent_id: 'section', type: 'proof', title: '推导', sources: [{ source_id: 's3' }], analysis: { method: 'ai', model: '本地模拟模型', review_status: 'confirmed' } }
  ], relations: [{ from: 'proof', to: 'theorem', type: 'proves', review_status: 'confirmed' }] }
  const manifest = {
    format: 'learning-assistant/document', schema_version: '0.2',
    document: { id: 'document1', version_id: 'version1', revision_id: 'revision5', title: '力学整理讲义', kind: 'handout', created_at: 12345, subject_name: '理论力学' },
    original: { format: 'pdf', file_name: '原始讲义.pdf', derivation: 'ocr', path: 'source/original.pdf', sha256: sha(original), byte_length: original.length }, conversion: null,
    sources, state,
    assets: [{ id: 'image1', mime_type: 'image/png', sha256: sha(png), width: 120, height: 80, locator_json: JSON.stringify({ kind: 'pdf', page: 2, source: 'pdf-crop:v1', bbox: [10, 20, 130, 100], pageSize: [600, 800], crop: { rect: [0.1, 0.2, 0.2, 0.1], rotation: 0, engine: 'pdfjs 6.5.438 / pdf-crop-v1' } }), alt_text: '受力图', path: 'assets/image1.png', byte_length: png.length }], asset_extraction: null,
    ocr_pages: [{ page: 2, raw_text: '牛 顿 第 二 定 律 F=ma😀。', corrected_text: null, confidence: 81, width: 1600, height: 2000, lines_json: '[]', model_json: '{"engine":"tesseract.js"}' }],
    concepts: [{ id: 'newton', name: '牛顿第二定律', aliases: ['牛顿运动第二定律'], summary: '力和动量变化率的关系' }],
    evidence: [{ concept_id: 'newton', entry_id: 'theorem', role: 'definition', memo: '教材原文', quote_sha256: sha(sources[1].raw_text) }]
  }
  return { manifest, binaries: new Map([['source/original.pdf', original], ['assets/image1.png', png]]) }
}
test('portable concept selection preserves aliases, ambiguity and evidence without unrelated dictionary entries', () => {
  const { manifest } = fixture(), original = structuredClone(manifest)
  manifest.concepts.push(
    { id: 'momentum', name: '动量原理', aliases: ['动量定理'], summary: '' },
    { id: 'ambiguous', name: '动量定理', aliases: [], summary: '另一个同名条目，不能悄悄消歧' },
    { id: 'evidenceOnly', name: '不出现在正文中的证据概念', aliases: [], summary: '' },
    { id: 'unrelated', name: '无关概念不得携带', aliases: [], summary: '' }
  )
  manifest.evidence.push({ ...manifest.evidence[0], concept_id: 'evidenceOnly' })
  const before = structuredClone(manifest), selected = relatedPackageConcepts(manifest)
  assert.deepEqual(selected.concepts.map(row => row.id), ['newton', 'momentum', 'ambiguous', 'evidenceOnly'])
  assert.deepEqual(manifest, before); assert.deepEqual(selected.state, original.state); validateLearningPackage(selected)
})
async function filesFor(f) {
  const base = await directory(), files = new Map()
  for (const [name, bytes] of f.binaries) { const file = join(base, `source-${files.size}.bin`); await writeFile(file, bytes); files.set(name, file) }
  return files
}
async function rawZip(entries) {
  const zip = new ZipFile(), chunks = [], result = new Promise((resolve, reject) => { zip.outputStream.on('data', data => chunks.push(data)); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); zip.once('error', reject) })
  for (const [name, bytes, options] of entries) zip.addBuffer(Buffer.from(bytes), name, options)
  zip.end(); return result
}
function entries(f) { return [['document.json', JSON.stringify(f.manifest)], ...f.binaries] }
async function rejectArchive(bytes, pattern) {
  const file = join(root, `${++serial}.ladoc`), stage = await directory()
  await writeFile(file, bytes); await assert.rejects(readLearningPackage(file, stage), pattern)
  assert.deepEqual(await readdir(stage), [], '失败清理仅属于本次的输出文件')
}

test('0.2 契约保留章节、来源范围、公式、配图、OCR 原文、别名与证据且不改输入', () => {
  const { manifest } = fixture(), before = JSON.stringify(manifest)
  validateLearningPackage(manifest); assert.equal(JSON.stringify(manifest), before)
  assert.equal(entryText(manifest.state.entries[1], new Map(manifest.sources.map(s => [s.id, s]))), manifest.sources[1].raw_text)
})
test('Schema 拒绝未知版本、额外字段、类型错误、路径和格式伪造', () => {
  const bad = [m => m.schema_version = '0.1', m => m.api_key = 'secret', m => m.state.entries[0].content = '替换正文', m => m.original.path = '../private.pdf', m => m.assets[0].width = '120', m => m.state.entries[1].formulas[0].range = [7, '11'], m => m.document.title = '\0', m => m.original.format = 'doc']
  for (const change of bad) { const { manifest } = fixture(); change(manifest); assert.throws(() => validateLearningPackage(manifest)) }
})
test('语义层拒绝遗漏、重复 ID、错序/循环章节、坏公式范围、图片及证明引用错误', () => {
  const bad = [m => m.sources[1].id = 's1', m => m.sources[1].ordinal = 7, m => m.state.entries.pop(), m => m.state.entries[1].sources[0].text_range = [1, 14], m => m.state.entries[1].parent_id = 'proof', m => m.state.entries[1].formulas[0].range = [12, 13], m => m.state.entries[1].figures[0].asset_id = 'missing', m => m.state.relations[0].to = 'section', m => m.assets[0].locator_json = '{"kind":"pdf","page":2,"source":"image:1"}', m => m.assets[0].width = 16_000_000]
  for (const change of bad) { const { manifest } = fixture(); change(manifest); assert.throws(() => validateLearningPackage(manifest)) }
})
test('OCR、概念与证据必须指向对应原文；不接受错误散列或重复别名', () => {
  const bad = [m => m.ocr_pages[0].raw_text = '别的教材', m => m.sources[1].extraction = 'native', m => m.ocr_pages[0].model_json = '[]', m => m.ocr_pages[0].page = 4, m => m.concepts[0].aliases.push('牛顿第二定律'), m => m.evidence[0].quote_sha256 = '0'.repeat(64), m => m.evidence[0].concept_id = 'foreign', m => m.evidence.push(m.evidence[0])]
  for (const change of bad) { const { manifest } = fixture(); change(manifest); assert.throws(() => validateLearningPackage(manifest)) }
})
test('真实 ZIP 编码解码后 JSON 与每个附件字节一致，磁盘文件名独立于包路径', async () => {
  const f = fixture(), files = await filesFor(f), output = join(root, '固定修订.ladoc'), stage = await directory()
  const digest = await writeLearningPackage(f.manifest, files, output), decoded = await readLearningPackage(output, stage)
  assert.deepEqual(decoded.manifest, f.manifest); assert.equal(decoded.sha256, digest.sha256); assert.equal(digest.sha256, sha(await readFile(output)))
  assert.equal(digest.byte_length, (await readFile(output)).length)
  for (const item of decoded.files) { assert.deepEqual(await readFile(item.file), f.binaries.get(item.path)); assert.ok(item.file.startsWith(stage)); assert.match(item.file, /file-\d+\.bin$/) }
  assert.equal(decoded.files.length, learningPackageFiles(f.manifest).length)
})
test('JPEG 配图可往返；旧 DOC/PPT 必须连同对应转换产物保留', async () => {
  for (const [format, converted] of [['doc', 'docx'], ['ppt', 'pptx']]) {
    const f = fixture(), jpeg = createCanvas(120, 80).toBuffer('image/jpeg'), original = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), conversion = zipSync({ '[Content_Types].xml': strToU8('<Types/>') })
    f.manifest.original = { format, file_name: `原件.${format}`, derivation: 'native', path: `source/original.${format}`, sha256: sha(original), byte_length: original.length }
    f.manifest.conversion = { format: converted, engine: 'LibreOffice fixture', created_at: 12, path: `source/converted.${converted}`, sha256: sha(conversion), byte_length: conversion.length }
    f.manifest.ocr_pages = []; f.manifest.sources.forEach((source, i) => { source.extraction = 'native'; source.locator_json = JSON.stringify({ kind: converted, source: `source:${i + 1}`, ...(format === 'ppt' ? { slide: i + 1 } : {}) }) })
    Object.assign(f.manifest.assets[0], { mime_type: 'image/jpeg', path: 'assets/image1.jpg', sha256: sha(jpeg), byte_length: jpeg.length, locator_json: JSON.stringify({ kind: converted, source: 'image:1.2', ...(format === 'ppt' ? { slide: 1 } : {}) }) })
    f.manifest.asset_extraction = { engine: 'officeparser fixture', warnings: ['只包含支持的图片'], created_at: 12 }
    f.binaries = new Map([[f.manifest.original.path, original], [f.manifest.conversion.path, conversion], ['assets/image1.jpg', jpeg]])
    const file = join(root, `${format}.ladoc`)
    await writeLearningPackage(f.manifest, await filesFor(f), file)
    assert.deepEqual((await readLearningPackage(file, await directory())).manifest, f.manifest)
    f.manifest.conversion = null; assert.throws(() => validateLearningPackage(f.manifest), /转换链/)
  }
})
test('已有导出文件和非空暂存目录保持原样，缺失文件及坏源散列不产生半份包', { timeout: 10_000 }, async () => {
  const f = fixture(), files = await filesFor(f), output = join(root, '不可覆盖.ladoc')
  await writeFile(output, '保留原文件'); await assert.rejects(writeLearningPackage(f.manifest, files, output), /EEXIST/); assert.equal(await readFile(output, 'utf8'), '保留原文件')
  const bad = join(root, '坏输出.ladoc'); f.manifest.original.sha256 = '0'.repeat(64)
  await assert.rejects(writeLearningPackage(f.manifest, files, bad), /散列|字节/); await assert.rejects(readFile(bad), /ENOENT/)
  const stage = await directory(); await writeFile(join(stage, '保留.txt'), '已有内容'); await assert.rejects(readLearningPackage(output, stage), /必须为空/); assert.equal(await readFile(join(stage, '保留.txt'), 'utf8'), '已有内容')
})
test('不接受损坏/假冒图片，即便清单散列已跟随伪造字节更新', async () => {
  const f = fixture(), png = f.binaries.get('assets/image1.png').subarray(0, 35)
  f.binaries.set('assets/image1.png', png); Object.assign(f.manifest.assets[0], { byte_length: png.length, sha256: sha(png) })
  await rejectArchive(await rawZip(entries(f)))
  const second = fixture(); second.manifest.assets[0].width = 121
  await rejectArchive(await rawZip(entries(second)), /尺寸/)
})
test('拒绝穿越、目录、符号链接、重复名称、未声明及缺失附件', async () => {
  const f = fixture()
  for (const name of ['../outside', '/absolute', 'source/../original.pdf', 'assets\\image1.png', 'assets/', 'README.txt']) await rejectArchive(zipSync({ ...Object.fromEntries(entries(f).map(([name, bytes]) => [name, typeof bytes === 'string' ? strToU8(bytes) : bytes])), [name]: strToU8('不可写出') }))
  await rejectArchive(await rawZip([...entries(f), ['source/original.pdf', f.binaries.get('source/original.pdf')]]), /重复/)
  await rejectArchive(zipSync(Object.fromEntries(entries(f).map(([name, bytes]) => [name, [typeof bytes === 'string' ? strToU8(bytes) : bytes, { attrs: name === 'source/original.pdf' ? 0o120777 << 16 : 0 }]]))), /链接/)
  await rejectArchive(await rawZip([...entries(f), ['assets/orphan.png', f.binaries.get('assets/image1.png')]]), /未声明|缺少/)
  await rejectArchive(await rawZip(entries(f).slice(0, 2)), /缺少/)
  await rejectArchive(await rawZip([...entries(f), ...Array.from({length: 102}, (_, i) => [`assets/extra-${i}.png`, Buffer.from('x')])]), /数量/)
})
test('ZIP 目录和本地名称、CRC、加密位以及 ZIP64 尺寸伪造均被拒绝', async () => {
  const f = fixture(), bytes = await rawZip(entries(f)), local = bytes.indexOf(Buffer.from('source/original.pdf')), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const mismatch = Buffer.from(bytes); mismatch[local] = 'S'.charCodeAt(0); await rejectArchive(mismatch, /名称/)
  const encrypted = Buffer.from(bytes); encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8); await rejectArchive(encrypted, /加密/)
  const huge = Buffer.from(bytes); huge.writeUInt32LE(0xffffffff, central + 24); await rejectArchive(huge)
  const corrupted = Buffer.from(bytes), sourceBytes = corrupted.indexOf(f.binaries.get('source/original.pdf')); assert.ok(sourceBytes > 0); corrupted[sourceBytes] ^= 1; await rejectArchive(corrupted, /散列|CRC/)
})
test('实际解压字节超过伪造的声明数量时立即中止并清理', async () => {
  const f = fixture(), original = Buffer.alloc(100_000, 65); f.binaries.set('source/original.pdf', original)
  Object.assign(f.manifest.original, { byte_length: 1, sha256: sha(Buffer.from('A')) })
  const bytes = Buffer.from(zipSync(Object.fromEntries(entries(f).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value]))))
  let at = 0
  while ((at = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at)) >= 0) { const length = bytes.readUInt16LE(at + 28), name = bytes.subarray(at + 46, at + 46 + length).toString(); if (name === 'source/original.pdf') bytes.writeUInt32LE(1, at + 24); at += 4 }
  await rejectArchive(bytes)
})
test('取消读写操作清理本批产物，未触及其它文件', async () => {
  const f = fixture(), files = await filesFor(f), output = join(root, '取消.ladoc'), cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(writeLearningPackage(f.manifest, files, output, cancelled.signal), /abort/i); await assert.rejects(readFile(output), /ENOENT/)
  const good = join(root, '取消来源.ladoc'); await writeLearningPackage(f.manifest, files, good)
  const stage = await directory(), controller = new AbortController(), watcher = watch(stage, (_event, name) => { if (name?.toString() === 'file-1.bin') controller.abort() })
  try { await assert.rejects(readLearningPackage(good, stage, controller.signal), /abort|取消/i) } finally { watcher.close() }
  assert.deepEqual(await readdir(stage), []); assert.equal(sha(await readFile(good)), (await readLearningPackage(good, await directory())).sha256)
  const exportController = new AbortController(), activeOutput = join(root, '中途取消.ladoc'), exportWatcher = watch(root, (_event, name) => { if (name?.toString() === '中途取消.ladoc') exportController.abort() })
  try { await assert.rejects(writeLearningPackage(f.manifest, files, activeOutput, exportController.signal), /abort|取消/i) } finally { exportWatcher.close() }
  await assert.rejects(readFile(activeOutput), /ENOENT/)
})
