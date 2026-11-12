import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { invoke } from './test-support.mjs'
import { closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { notePackageSnapshot } from '../src/main/services/note-package-export.ts'
import { validateNotePackage, noteArchiveContract } from '../src/main/services/note-package-validation.ts'
import { writeDocumentArchive, readDocumentArchive, readLearningPackage } from '../src/main/services/learning-package-codec.ts'
import { relatedPackageConcepts } from '../shared/learning-package-concepts.ts'

registerAllIpc(); after(() => closeDb())
const ok = r => { assert.equal(r.ok, true, r.error); return r.data }
const dir = () => mkdtemp(join(tmpdir(), 'learning-assistant-note-package-'))
async function fixture() {
  const note = ok(await invoke('notes:create', { title: '可交换课堂笔记', source: 'manual' }))
  const segment = ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '原始口述😀：冲量。', organized_text: '动量公式：p=mv。\n证明保持原样。' }))
  let doc = ok(await invoke('notes:learningGet', { note_id: note.id }))
  doc = ok(await invoke('notes:learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[0].id, action: 'edit', type: 'theorem', title: '动量关系' }))
  doc = ok(await invoke('notes:learningChange', { note_id: note.id, expected_revision_id: doc.revision_id, entry_id: doc.state.entries[0].id, action: 'formula', formula: { range: [5, 9], latex: 'p = mv', display: true } }))
  ok(await invoke('annotations:add', { segment_id: segment.id, kind: 'keypoint', comment: '保留重点' }))
  const concept = ok(await invoke('evidence:createConcept', { concept: { subject_id: null, name: '动量', aliases: ['冲量'], summary: '来源关联' }, source: { kind: 'note', note_id: note.id, segment_id: segment.id, field: 'organized_text' }, expected_note_text: segment.organized_text, role: 'source', memo: '原始证据' })).concept
  return { note, segment, doc, concept, input: { note_id: note.id, revision_id: doc.revision_id } }
}
test('固定笔记包保留原始口述、人工结构、公式、标注和知识证据，不同步最新课堂', async () => {
  const f = await fixture(), before = structuredClone(f.doc)
  ok(await invoke('notes:updateSegment', { id: f.segment.id, organized_text: '后来人工校正的正文。' }))
  ok(await invoke('notes:addSegment', { note_id: f.note.id, raw_text: '后来课堂追加不应混入。' }))
  ok(await invoke('evidence:add', { concept_id: f.concept.id, source: { kind: 'note', note_id: f.note.id, segment_id: f.segment.id, field: 'organized_text' }, expected_note_text: '后来人工校正的正文。', role: 'source', memo: '新版本证据' }))
  const manifest = notePackageSnapshot(f.input)
  validateNotePackage(manifest)
  assert.deepEqual(manifest.state, before.state); assert.deepEqual(manifest.sources, before.sources); assert.deepEqual(manifest.origins, before.origins)
  assert.equal(manifest.annotations[0].matches_revision, false)
  assert.deepEqual(manifest.evidence.map(e => e.matches_revision).sort(), [false, true])
  assert.equal(manifest.state.entries[0].formulas[0].latex, 'p = mv')
  assert.equal(JSON.stringify(manifest).includes('后来课堂追加'), false)
  assert.equal(JSON.stringify(manifest).includes('file_path'), false)
  const selected = ok(await invoke('notes:learningGet', f.input))
  assert.equal(selected.current_revision_id, f.doc.current_revision_id, '导出旧修订不能自动同步后续来源')
  ok(await invoke('notes:removeSegment', f.segment.id))
  const deleted = notePackageSnapshot(f.input)
  assert.deepEqual(deleted.evidence, manifest.evidence, '当前段落已删除，固定修订的历史证据仍需携带')
  assert.deepEqual(deleted.origins, manifest.origins)
})
test('笔记 Schema 与语义校验拒绝伪造来源、错位快照、损坏证据、外部路径和未知附件', async () => {
  const { input } = await fixture(), original = notePackageSnapshot(input)
  for (const change of [
    p => { p.schema_version = '9' }, p => { p.secret = '禁止字段' }, p => { delete p.origins[p.sources[0].id] },
    p => { p.sources[0].ordinal = 1 }, p => { p.origins[p.sources[0].id].segment_id = 'other' },
    p => { p.sources[0].locator_json = JSON.stringify({ kind: 'note', field: 'organized_text', note_id: 'wrong' }) },
    p => { p.state.entries[0].sources[0].source_id = 'missing' }, p => { p.state.entries[0].figures = [{ asset_id: 'missing', caption: '' }] },
    p => { p.annotations[0].source_id = 'missing' }, p => { p.annotations[0].matches_revision = false },
    p => { p.evidence[0].quote = '假证据' }, p => { p.evidence[0].matches_revision = false }, p => { p.concepts[0].aliases = [p.concepts[0].name] },
    p => { p.origins[p.sources[0].id].material_ref = { id: 'b', version_id: 'v', ordinal: 0, heading: '', text: '教材', locator_json: '{"kind":"pdf","page":1}', material_id: 'm', material_title: '教材', file_name: 'D:\\private.pdf', format: 'pdf' } }
  ]) { const invalid = structuredClone(original); change(invalid); assert.throws(() => validateNotePackage(invalid)) }
  assert.deepEqual(notePackageSnapshot(input).state, original.state)
})
test('仅保留提及或证据关联的概念，原始口述别名也能携带；不污染教材契约', async () => {
  const { input } = await fixture(), original = notePackageSnapshot(input)
  original.concepts.push({ id: 'extra', name: '未提及概念', summary: '', aliases: [] })
  const selected = relatedPackageConcepts(original, Object.values(original.origins).map(o => o.raw_text))
  assert.equal(selected.concepts.some(c => c.id === 'extra'), false)
  assert.equal(original.concepts.some(c => c.id === 'extra'), true)
  selected.origins[selected.sources[0].id].material_ref = { id: 'block', version_id: 'version', ordinal: 2, heading: '动量', text: '教材位置的历史摘录', locator_json: '{"kind":"pptx","slide":3}', material_id: 'material', material_title: '旧课堂课件', file_name: '课堂.ppt', format: 'ppt' }
  validateNotePackage(selected)
  const root = await dir(), file = join(root, '笔记.ladoc')
  await writeDocumentArchive(selected, new Map(), file, noteArchiveContract)
  const decoded = await readDocumentArchive(file, await dir(), noteArchiveContract)
  assert.deepEqual(decoded.manifest, selected); assert.deepEqual(decoded.files, [])
  await assert.rejects(readLearningPackage(file, await dir()), /笔记文档包.*笔记页/)
})
test('笔记复用 ZIP 校验，拒绝路径穿越/多余附件/损坏 CRC，失败不破坏已有文件', async () => {
  const { input } = await fixture(), manifest = notePackageSnapshot(input), root = await dir(), file = join(root, '包.ladoc')
  for (const extra of ['../secret', 'source/original.pdf']) {
    await writeFile(file, zipSync({ 'document.json': strToU8(JSON.stringify(manifest)), [extra]: strToU8('额外内容') }))
    const stage = await dir(); await assert.rejects(readDocumentArchive(file, stage, noteArchiveContract)); assert.deepEqual(await readdir(stage), [])
  }
  const bytes = zipSync({ 'document.json': strToU8(JSON.stringify(manifest)) }, { level: 0 }); bytes[80] ^= 1
  await writeFile(file, bytes); await assert.rejects(readDocumentArchive(file, await dir(), noteArchiveContract))
  await writeFile(file, '已有目标保留'); await assert.rejects(writeDocumentArchive(manifest, new Map(), file, noteArchiveContract), /EEXIST/)
  assert.equal(await readFile(file, 'utf8'), '已有目标保留')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(writeDocumentArchive(manifest, new Map(), join(root, '取消.ladoc'), noteArchiveContract, controller.signal), /abort/i)
})
test('笔记包 IPC 只接受固定修订，不接受外部文件路径和空笔记', async () => {
  const { input } = await fixture()
  for (const bad of [{ note_id: input.note_id }, { ...input, output: 'D:\\private.ladoc' }, { ...input, revision_id: 'wrong' }]) assert.equal((await invoke('notes:packageExport', bad)).ok, false)
  const empty = ok(await invoke('notes:create', { title: '空笔记', source: 'manual' })), doc = ok(await invoke('notes:learningGet', { note_id: empty.id }))
  assert.equal((await invoke('notes:packageExport', { note_id: empty.id, revision_id: doc.revision_id })).ok, false)
})
