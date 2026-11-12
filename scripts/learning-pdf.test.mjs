import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { invoke, electronMock } from './test-support.mjs'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { getDb, closeDb, dbFilePath } from '../src/main/services/db.ts'
import { learningPdfSnapshot } from '../src/main/services/learning-pdf.ts'
import { externalExportTarget } from '../src/main/services/export-target.ts'

registerAllIpc(); after(closeDb)
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
const input = source => ({ source, landscape: false, include_original_text: true })
test('PDF 固定笔记修订、原文与标题，不因导出同步新来源', async () => {
  const note = ok(await invoke('notes:create', { title: '旧标题', source: 'class' }))
  const segment = ok(await invoke('notes:addSegment', { note_id: note.id, seg_type: 'proof', raw_text: '教师原始转写', organized_text: '旧证明 $F=ma$' }))
  const first = ok(await invoke('notes:learningGet', { note_id: note.id }))
  ok(await invoke('notes:updateSegment', { id: segment.id, organized_text: '新证明' }))
  const count = () => getDb().prepare('SELECT count(*) AS n FROM note_learning_revisions').get().n
  const before = count(), pdf = learningPdfSnapshot(input({ kind: 'note', note_id: note.id, revision_id: first.revision_id }))
  assert.equal(pdf.title, '旧标题'); assert.equal(pdf.sources[0].raw_text, '旧证明 $F=ma$')
  assert.equal(pdf.origins[pdf.sources[0].id].raw_text, '教师原始转写'); assert.equal(count(), before)
  assert.equal(pdf.revision_number, 1); assert.equal(JSON.stringify(pdf).includes('file_path'), false)
  const next = ok(await invoke('notes:learningGet', { note_id: note.id }))
  assert.notEqual(next.revision_id, first.revision_id)
  assert.equal(learningPdfSnapshot(input({ kind: 'note', note_id: note.id, revision_id: first.revision_id })).revision_number, 1)
  assert.throws(() => learningPdfSnapshot(input({ kind: 'note', note_id: note.id, revision_id: 'missing' })), /不属于此笔记/)
})
test('PDF 拒绝混合所有者、路径、缺失方向等非法载荷；取消仅无参数', async () => {
  const source = { kind: 'note', note_id: 'n', revision_id: 'r' }
  for (const bad of [{ source }, { ...input(source), output: 'private.pdf' }, input({ ...source, version_id: 'v' }), input({ kind: 'material', version_id: 'v' }), { ...input(source), landscape: 'false' }]) assert.equal((await invoke('learning:pdfExport', bad)).ok, false)
  assert.deepEqual(await invoke('learning:pdfCancel'), { ok: true, data: false })
  assert.equal((await invoke('learning:pdfCancel', 'other-owner')).ok, false)
})
test('空笔记不输出伪空文档，保存框取消不启动排版', async () => {
  const note = ok(await invoke('notes:create', { title: '空笔记', source: 'manual' }))
  let doc = ok(await invoke('notes:learningGet', { note_id: note.id }))
  assert.equal((await invoke('learning:pdfExport', input({ kind: 'note', note_id: note.id, revision_id: doc.revision_id }))).ok, false)
  ok(await invoke('notes:addSegment', { note_id: note.id, raw_text: '内容' }))
  doc = ok(await invoke('notes:learningGet', { note_id: note.id }))
  electronMock.dialog.showSaveDialog = async () => ({ canceled: true })
  assert.deepEqual(await invoke('learning:pdfExport', input({ kind: 'note', note_id: note.id, revision_id: doc.revision_id })), { ok: true, data: null })
})
test('共用导出目标校验阻止覆盖托管数据，不改变外部已有文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learning-pdf-target-')), target = join(root, '历史.pdf')
  await writeFile(target, '原文件')
  assert.equal((await externalExportTarget(target, '.pdf')).target, target)
  assert.equal(await readFile(target, 'utf8'), '原文件')
  await assert.rejects(externalExportTarget(dbFilePath().replace(/[^\\/]+$/, '覆盖.pdf'), '.pdf'), /数据目录/)
  await assert.rejects(externalExportTarget(join(root, 'x.txt'), '.pdf'), /扩展名/)
})
