import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { completeOcrVersion, insertDerived, derivedParent } from '../src/main/services/material-derivations.ts'
import { ocrModelsStatus, ocrModelDirectory } from '../src/main/services/ocr-models.ts'
import { readableOcr } from '../shared/material-ocr.ts'
import { assertIdle } from '../src/main/services/work.ts'

registerAllIpc()
after(() => closeDb())
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let n = 0
function fixture() {
  const db = getDb(), id = `ocr-fixture-${++n}`, version = id + '-original'
  db.prepare('INSERT INTO materials (id, title, created_at) VALUES (?, ?, ?)').run(id, '扫描教材', Date.now())
  db.prepare("INSERT INTO material_versions (id, material_id, file_name, file_path, format, fingerprint, status, warnings_json, created_at) VALUES (?, ?, 'scan.pdf', 'materials/original/source.pdf', 'pdf', 'same-fingerprint', 'ready', ?, ?)").run(version, id, JSON.stringify(['第 1 页需要 OCR，当前仅保留原页定位', '第 2 页需要 OCR，当前仅保留原页定位']), Date.now())
  db.prepare('UPDATE materials SET current_version_id = ? WHERE id = ?').run(version, id)
  for (let page = 1; page <= 3; page++) db.prepare('INSERT INTO material_blocks (id, version_id, ordinal, text, locator_json) VALUES (?, ?, ?, ?, ?)').run(version + '-' + page, version, page - 1, '原文' + page, JSON.stringify({ kind: 'pdf', page }))
  return { db, id, version }
}
const page = (p, text) => ({ page: p, raw_text: text, corrected_text: null, confidence: 81, width: 100, height: 100, lines_json: '[]', model_json: '{"engine":"fixture"}' })
function finish(parent, p, text) {
  const input = { version_id: parent, from_page: p, to_page: p }
  return getDb().transaction(() => {
    const id = insertDerived(derivedParent(parent), 'ocr', input, 'queued')
    const warnings = completeOcrVersion(id, input, [page(p, text)], [])
    getDb().prepare("UPDATE material_versions SET status = 'ready', warnings_json = ? WHERE id = ?").run(JSON.stringify(warnings), id)
    return id
  })()
}

test('v7 升级保留旧块与课堂引用，原版本默认标为 original', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  for (const migration of MIGRATIONS.filter(m => m.version <= 7)) db.exec(migration.sql)
  db.exec("INSERT INTO materials(id,title,created_at) VALUES ('m','旧材料',0); INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,created_at) VALUES ('v','m','x.pdf','source.pdf','pdf','h',0); INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES ('b','v',0,'旧条目','{}'); INSERT INTO notes(id,title,created_at,updated_at) VALUES ('n','课堂',0,0); INSERT INTO classroom_positions(note_id,block_id,updated_at) VALUES ('n','b',0)")
  db.exec(MIGRATIONS.find(m => m.version === 8).sql)
  assert.equal(db.prepare('SELECT derivation FROM material_versions').get().derivation, 'original')
  assert.equal(db.prepare('SELECT block_id FROM classroom_positions').get().block_id, 'b')
  assert.equal(db.prepare('SELECT text FROM material_blocks').get().text, '旧条目')
  db.close()
})
test('OCR 批次继承其他页和旧批次，校正生成新版本并保留原文及历史块', async () => {
  const f = fixture(), first = finish(f.version, 1, '热 力 学 first law'), second = finish(first, 2, '第二页 OCR')
  const all = ok(await invoke('materials:blocks', { version_id: second })).blocks
  assert.deepEqual(all.map(b => b.text), ['热力学 first law', '第二页 OCR', '原文3'])
  assert.equal(ok(await invoke('materials:ocrPage', { version_id: second, page: 1 })).raw_text, '热 力 学 first law')
  const corrected = ok(await invoke('materials:ocrCorrect', { version_id: second, page: 1, text: '人工核对：热力学第一定律' }))
  assert.equal(ok(await invoke('materials:ocrPage', { version_id: corrected, page: 1 })).corrected_text, '人工核对：热力学第一定律')
  assert.equal(ok(await invoke('materials:ocrPage', { version_id: second, page: 1 })).corrected_text, null)
  assert.equal(f.db.prepare('SELECT text FROM material_blocks WHERE id = ?').get(f.version + '-1').text, '原文1')
  assert.equal(f.db.prepare('SELECT file_path FROM material_versions WHERE id = ?').get(corrected).file_path, 'materials/original/source.pdf')
  closeDb()
  assert.equal(ok(await invoke('materials:ocrPage', { version_id: corrected, page: 1 })).raw_text, '热 力 学 first law')
})
test('旧分支完成不覆盖当前版本；不完整结果事务回滚', () => {
  const f = fixture(), current = finish(f.version, 1, '先完成的版本'), branch = finish(f.version, 2, '后完成的旧分支')
  assert.notEqual(current, branch)
  assert.equal(f.db.prepare('SELECT current_version_id FROM materials WHERE id = ?').get(f.id).current_version_id, current)
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM material_versions').get().n
  assert.throws(() => f.db.transaction(() => {
    const id = insertDerived(derivedParent(current), 'ocr', {}, 'queued')
    completeOcrVersion(id, { version_id: current, from_page: 1, to_page: 2 }, [page(1, '不完整')], [])
  })(), /不完整/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM material_versions').get().n, before)
})
test('OCR 参数、缺失/损坏模型、未识别页校正被拒绝，不能注入模型目录', async () => {
  const f = fixture()
  for (const payload of [
    { version_id: f.version, from_page: 0, to_page: 1 },
    { version_id: f.version, from_page: 1, to_page: 21 },
    { version_id: f.version, from_page: 2, to_page: 1 },
    { version_id: f.version, from_page: 1, to_page: 1, modelDirectory: dataRoot },
    { version_id: f.version, from_page: 3, to_page: 4 }
  ]) assert.equal((await invoke('materials:ocrStart', payload)).ok, false)
  assert.equal((await invoke('materials:ocrStart', { version_id: f.version, from_page: 1, to_page: 1 })).ok, false)
  assert.equal((await invoke('materials:ocrCorrect', { version_id: f.version, page: 1, text: '校正' })).ok, false)
  await mkdir(ocrModelDirectory(), { recursive: true })
  await writeFile(join(ocrModelDirectory(), 'eng.traineddata'), 'broken')
  assert.equal((await ocrModelsStatus()).ready, false)
  assert.equal(readableOcr('牛 顿 定 律 Newton law'), '牛顿定律 Newton law')
})
test('语言包下载去重并阻止中途迁移，摘要不符时保留原缓存', async () => {
  const previousFetch = globalThis.fetch
  let respond, calls = 0
  globalThis.fetch = async () => { calls++; return new Promise(resolve => { respond = resolve }) }
  try {
    const first = invoke('materials:ocrPrepare'), second = invoke('materials:ocrPrepare')
    while (!respond) await new Promise(resolve => setTimeout(resolve, 1))
    assert.throws(() => assertIdle(), /OCR/)
    respond(new Response('tampered-model'))
    assert.equal((await first).ok, false); assert.equal((await second).ok, false)
    assert.equal(calls, 1)
    assert.equal((await readdir(ocrModelDirectory())).some(file => file.endsWith('.part')), false)
    assert.doesNotThrow(() => assertIdle())
  } finally { globalThis.fetch = previousFetch }
})
