import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createCanvas } from '@napi-rs/canvas'
import { createHash } from 'node:crypto'
import { readdir, chmod, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { invoke } from './test-support.mjs'
import { getDb, closeDb, dbFilePath } from '../src/main/services/db.ts'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { initialLearningState, changeLearningState, validateLearningState } from '../shared/learning-document.ts'
import { learningFragments } from '../shared/learning-suggestions.ts'
import { collectLearningAssets } from '../src/main/services/learning-asset-parser.ts'
import { storeLearningAssets, learningAssetResponse } from '../src/main/services/learning-assets.ts'

registerAllIpc()
after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
const id = () => `asset-test-${++sequence}`
const bytes = createCanvas(120, 80).toBuffer('image/png')
const attachment = { name: 'test.png', type: 'image', mimeType: 'image/png', data: bytes.toString('base64'), extension: 'png' }
const image = () => ({ type: 'image', text: '', metadata: { attachmentName: 'test.png', altText: '受力示意图' } })
const ast = content => ({ content, attachments: [attachment], warnings: [] })
const parsedAsset = () => ({ bytes, mime_type: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), width: 120, height: 80, locator_json: '{"kind":"docx","source":"image:1"}', alt_text: '受力示意图' })
function fixture(db = getDb()) {
  const material = id(), version = id(), document = id(), revision = id(), source = { id: id(), ordinal: 0, raw_text: '受力分析😀：物体的平衡条件。', heading: '', locator_json: '{"kind":"docx","source":"source:1"}', extraction: 'native' }
  const state = initialLearningState([source], id)
  db.prepare('INSERT INTO materials(id,title,created_at) VALUES (?,?,0)').run(material, '配图讲义')
  db.prepare("INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'x.docx','unused.docx','docx','hash','ready',0)").run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(version, material)
  db.prepare('INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)').run(document, version)
  db.prepare('INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,0,?,?,?,?)').run(source.id, document, source.raw_text, '', source.locator_json, 'native')
  db.prepare('INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)').run(revision, document, JSON.stringify(state))
  db.prepare('UPDATE learning_documents SET current_revision_id=? WHERE id=?').run(revision, document)
  return { material, version, document, revision, source, state }
}

test('迁移 14 从旧结构升级且失败可回滚，来源、修订和知识证据保留', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS.filter(m => m.version <= 13)) db.exec(migration.sql)
  db.pragma('user_version = 13')
  const f = fixture(db)
  db.prepare("INSERT INTO knowledge_points(id,name,created_at) VALUES ('old-concept','受力分析',0)").run()
  db.prepare("INSERT INTO knowledge_evidence(id,concept_id,version_id,revision_id,source_json,source_lookup,source_key,role,memo,quote,quote_sha256,source_title,location,entry_title,created_at) VALUES ('old-evidence','old-concept',?,?,'{}','old','old','source','','固定原文','hash','旧教材','原位','',0)").run(f.version, f.revision)
  const sql = MIGRATIONS.find(m => m.version === 14).sql
  assert.throws(() => db.transaction(() => { db.exec(sql); throw Error('模拟失败') })(), /模拟失败/)
  assert.equal(db.pragma('user_version', { simple: true }), 13)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='learning_assets'").get().n, 0)
  db.transaction(() => { db.exec(sql); db.pragma('user_version = 14') })()
  assert.equal(db.prepare('SELECT current_revision_id FROM learning_documents WHERE id=?').get(f.document).current_revision_id, f.revision)
  assert.equal(db.prepare("SELECT quote FROM knowledge_evidence WHERE id='old-evidence'").get().quote, '固定原文')
  assert.equal(db.prepare('SELECT raw_text FROM learning_sources WHERE id=?').get(f.source.id).raw_text, f.source.raw_text)
  assert.deepEqual(db.pragma('foreign_key_check'), []); db.close()
})

test('AST 按真实出现位置保留重复配图与幻灯片号，Word 不伪造页码', async () => {
  const word = await collectLearningAssets(ast([{ type: 'paragraph', children: [image(), image()] }]), 'docx')
  assert.equal(word.assets.length, 2); assert.equal(word.assets[0].sha256, word.assets[1].sha256)
  assert.notEqual(word.assets[0].locator_json, word.assets[1].locator_json)
  assert.equal(JSON.parse(word.assets[0].locator_json).page, undefined)
  assert.equal(word.assets[0].width, 120); assert.equal(word.assets[0].alt_text, '受力示意图')
  const ppt = await collectLearningAssets(ast([{ type: 'slide', metadata: { slideNumber: 3 }, children: [image()] }]), 'pptx')
  assert.equal(JSON.parse(ppt.assets[0].locator_json).slide, 3)
})

test('不读取外链、孤立附件、矢量图或损坏/超大图片，数量超限整体失败', async () => {
  const invalid = ast([image(), { type: 'image', metadata: { attachmentName: 'remote', url: 'https://example.invalid/x.png' } }])
  invalid.attachments[0] = { ...attachment, mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }
  const unsupported = await collectLearningAssets(invalid, 'docx')
  assert.equal(unsupported.assets.length, 0); assert.equal(unsupported.warnings.length, 2)
  assert.equal((await collectLearningAssets(ast([]), 'docx')).assets.length, 0)
  for (const data of ['not-a-png', (() => { const copy = Buffer.from(bytes); copy.writeUInt32BE(100000, 16); return copy.toString('base64') })()]) {
    const damaged = ast([image()]); damaged.attachments[0] = { ...attachment, data }
    const result = await collectLearningAssets(damaged, 'docx'); assert.equal(result.assets.length, 0); assert.match(result.warnings[0], /损坏/)
  }
  await assert.rejects(collectLearningAssets(ast(Array.from({ length: 101 }, image)), 'docx'), /100 张/)
})

test('取消和数据库登记失败清理本批文件，不发布半份附件，也不改旧修订', async () => {
  const f = fixture(), directory = join(dirname(dbFilePath()), 'materials', 'learning-assets')
  const before = await readdir(directory).catch(() => [])
  let checks = 0
  await assert.rejects(storeLearningAssets(f.version, { assets: [parsedAsset(), parsedAsset()], warnings: [] }, () => ++checks === 2), /取消/)
  assert.deepEqual(await readdir(directory), before)
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM learning_assets WHERE document_id=?').get(f.document).n, 0)
  getDb().exec("CREATE TRIGGER reject_asset_run BEFORE INSERT ON learning_asset_extractions BEGIN SELECT RAISE(ABORT,'模拟登记失败'); END")
  try { await assert.rejects(storeLearningAssets(f.version, { assets: [parsedAsset()], warnings: [] }), /模拟登记失败/) } finally { getDb().exec('DROP TRIGGER reject_asset_run') }
  assert.deepEqual(await readdir(directory), before)
  assert.equal(ok(await invoke('learning:get', { version_id: f.version })).revision_id, f.revision)
})

test('已保存附件不覆盖，配图只属于本篇；旧修订和原文证据可在重开后读取', async () => {
  const f = fixture(), other = fixture()
  await storeLearningAssets(f.version, { assets: [parsedAsset()], warnings: ['保留提示'] })
  await storeLearningAssets(other.version, { assets: [parsedAsset()], warnings: [] })
  const loaded = ok(await invoke('learning:get', { version_id: f.version })), asset = loaded.assets[0], foreign = ok(await invoke('learning:get', { version_id: other.version })).assets[0]
  assert.equal(loaded.revision_id, f.revision); assert.deepEqual(loaded.asset_extraction.warnings, ['保留提示']); assert.equal(JSON.stringify(loaded).includes('file_path'), false)
  await assert.rejects(storeLearningAssets(f.version, { assets: [], warnings: [] }), /不能覆盖/)
  const concept = ok(await invoke('concepts:save', { name: id(), summary: '', aliases: [], subject_id: null }))
  const evidence = ok(await invoke('evidence:add', { concept_id: concept.id, source: { kind: 'learning', material_id: f.material, version_id: f.version, revision_id: f.revision, entry_id: f.state.entries[0].id }, role: 'source', memo: '' })).evidence
  const input = { version_id: f.version, expected_revision_id: f.revision, entry_id: f.state.entries[0].id, action: 'figure', figure: { asset_id: asset.id, caption: '静力平衡示意' } }
  for (const invalid of [{ ...input, figure: { ...input.figure, asset_id: foreign.id } }, { ...input, figure: { ...input.figure, path: '../private' } }, { ...input, raw_text: '篡改' }]) assert.equal((await invoke('learning:change', invalid)).ok, false)
  const saved = ok(await invoke('learning:change', input))
  assert.equal((await invoke('learning:change', input)).ok, false)
  closeDb()
  const resumed = ok(await invoke('learning:get', { version_id: f.version }))
  assert.equal(resumed.revision_id, saved.revision_id); assert.deepEqual(resumed.state.entries[0].figures, [input.figure])
  assert.equal(resumed.sources[0].raw_text, f.source.raw_text)
  assert.equal(ok(await invoke('learning:get', { version_id: f.version, revision_id: f.revision })).state.entries[0].figures, undefined)
  assert.equal(ok(await invoke('evidence:list', { concept_id: concept.id })).items[0].quote_sha256, evidence.quote_sha256)
  assert.equal((await learningAssetResponse(asset.id)).status, 200)
})

test('图片协议验证 ID、托管范围、散列及类型，损坏附件拒绝读取', async () => {
  const f = fixture(); await storeLearningAssets(f.version, { assets: [parsedAsset()], warnings: [] })
  const row = getDb().prepare('SELECT * FROM learning_assets WHERE document_id=?').get(f.document)
  const response = await learningAssetResponse(row.id)
  assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal((await learningAssetResponse('../private')).status, 404)
  const file = join(dirname(dbFilePath()), row.file_path)
  await chmod(file, 0o644); await writeFile(file, '损坏')
  assert.equal((await learningAssetResponse(row.id)).status, 404)
  getDb().prepare('UPDATE learning_assets SET file_path=? WHERE id=?').run('../private.png', row.id)
  assert.equal((await learningAssetResponse(row.id)).status, 404)
})

test('配图更新与移除可追溯，拆分/合并/AI 不会吞掉人工配图', () => {
  const f = fixture(), entry = f.state.entries[0], figure = { asset_id: id(), caption: '图注' }, base = { version_id: f.version, expected_revision_id: f.revision, entry_id: entry.id }
  const saved = changeLearningState(f.state, [f.source], { ...base, action: 'figure', figure }, id)
  const edited = changeLearningState(saved, [f.source], { ...base, action: 'figure', figure: { ...figure, caption: '修订图注' } }, id)
  assert.equal(edited.entries[0].figures.length, 1); assert.equal(edited.entries[0].figures[0].caption, '修订图注')
  assert.equal(entry.figures, undefined); assert.deepEqual(edited.entries[0].sources, entry.sources)
  assert.throws(() => changeLearningState(edited, [f.source], { ...base, action: 'split', position: 4 }, id), /配图引用/)
  const secondSource = { ...f.source, id: id(), ordinal: 1, raw_text: '第二段文字' }, twoSources = [f.source, secondSource], twoEntries = initialLearningState(twoSources, id)
  const beforeMerge = changeLearningState(twoEntries, twoSources, { ...base, entry_id: twoEntries.entries[0].id, action: 'figure', figure }, id)
  assert.throws(() => changeLearningState(beforeMerge, twoSources, { ...base, action: 'merge', entry_id: twoEntries.entries[1].id }, id), /配图引用/)
  edited.entries[0].analysis = { method: 'extracted', review_status: 'unreviewed' }
  assert.throws(() => learningFragments({ state: edited, sources: [f.source] }, [entry.id]), /配图引用/)
  const bad = structuredClone(edited); bad.entries[0].figures.push(figure)
  assert.throws(() => validateLearningState(bad, [f.source]), /重复/)
  const removed = changeLearningState(edited, [f.source], { ...base, action: 'figure-remove', asset_id: figure.asset_id }, id)
  assert.equal(removed.entries[0].figures, undefined)
  assert.equal(changeLearningState(removed, [f.source], { ...base, action: 'split', position: 4 }, id).entries.length, 2)
})
