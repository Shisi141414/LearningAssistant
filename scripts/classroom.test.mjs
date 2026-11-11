import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from './test-support.mjs'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { asrService } from '../src/main/services/asr.ts'
import { stopClassroom } from '../src/main/ipc/classroom.ipc.ts'
import { organizeSegment } from '../src/main/services/organizer.ts'
import { configSet } from '../src/main/services/config.ts'

registerAllIpc()
after(() => { stopClassroom(); closeDb() })
const ok = result => { assert.equal(result.ok, true, result.error); return result.data }
let sequence = 0
function material() {
  const id = `r2-material-${++sequence}`, version = id + '-v1', db = getDb()
  db.prepare('INSERT INTO materials (id, title, created_at) VALUES (?, ?, ?)').run(id, '力学教材', Date.now())
  db.prepare("INSERT INTO material_versions (id, material_id, file_name, file_path, format, fingerprint, status, created_at) VALUES (?, ?, '教材.pdf', 'unused.pdf', 'pdf', ?, 'ready', ?)").run(version, id, id, Date.now())
  db.prepare('UPDATE materials SET current_version_id = ? WHERE id = ?').run(version, id)
  const texts = ['原版基准：牛顿第二定律', '附近参考：动量', '第三页新增：能量']
  texts.forEach((text, ordinal) => db.prepare('INSERT INTO material_blocks (id, version_id, ordinal, text, locator_json) VALUES (?, ?, ?, ?, ?)').run(version + '-' + ordinal, version, ordinal, text, JSON.stringify({ kind: 'pdf', page: ordinal + 1 })))
  return { id, version, blocks: texts.map((_t, i) => version + '-' + i) }
}
const note = async () => ok(await invoke('notes:create', { title: '有教材的课堂', source: 'class' }))

test('校准只影响后续段落，历史来源和位置跨数据库重开保留', async () => {
  configSet('classroom.autoOrganize', '0')
  const m = material(), n = await note()
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[0] }))
  const first = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '第一段原文' }))
  assert.equal(first.material_ref.id, m.blocks[0])
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[2] }))
  const second = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '第二段' }))
  assert.equal(second.material_ref.id, m.blocks[2])
  closeDb()
  assert.equal(ok(await invoke('classroom:position', n.id)).block.id, m.blocks[2])
  const loaded = ok(await invoke('notes:get', n.id))
  assert.equal(loaded.segments[0].material_ref.id, m.blocks[0])
  assert.equal(loaded.segments[0].raw_text, '第一段原文')
  assert.equal(ok(await invoke('materials:references', m.blocks[0]))[0].segment_id, first.id)
  const other = material()
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: other.blocks[1] }))
  assert.equal(ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '切换到另一本教材' })).material_ref.version_id, other.version)
  assert.equal(ok(await invoke('notes:get', n.id)).segments[0].material_ref.version_id, m.version)
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: null }))
  assert.equal(ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '脱离教材' })).material_ref, null)
  assert.equal(ok(await invoke('notes:get', n.id)).segments[0].material_ref.id, m.blocks[0])
})

test('非法位置不改变游标，页码与条目定位返回真实位置', async () => {
  const m = material(), n = await note()
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[0] }))
  assert.equal((await invoke('classroom:calibrate', { note_id: n.id, block_id: 'missing' })).ok, false)
  assert.equal((await invoke('materials:locate', { version_id: m.version, unit: 'page', index: -1 })).ok, false)
  assert.equal(ok(await invoke('materials:locate', { version_id: m.version, unit: 'page', index: 2 })).id, m.blocks[1])
  assert.equal(ok(await invoke('materials:locate', { version_id: m.version, unit: 'block', index: 3 })).id, m.blocks[2])
  assert.equal(ok(await invoke('materials:locate', { version_id: m.version, unit: 'page', index: 999 })), null)
  assert.equal(ok(await invoke('classroom:position', n.id)).block.id, m.blocks[0])
})

test('校准前先收尾到旧位置，课堂会话结束持久化', async () => {
  configSet('asr.model_dir', null)
  const m = material(), n = await note(), other = await note()
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[0] }))
  assert.equal(ok(await invoke('classroom:start', n.id)).mode, 'manual')
  const original = asrService.flush
  let flushed = 0
  asrService.flush = () => { flushed++; void invoke('notes:addSegment', { note_id: n.id, raw_text: '校准前尚未结束的尾句' }) }
  try {
    assert.equal((await invoke('classroom:calibrate', { note_id: other.id, block_id: m.blocks[2] })).ok, false)
    assert.equal(flushed, 0)
    ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[2] }))
    const saved = ok(await invoke('notes:get', n.id))
    assert.equal(saved.segments[0].material_ref.id, m.blocks[0])
    assert.equal(ok(await invoke('classroom:position', n.id)).block.id, m.blocks[2])
  } finally { asrService.flush = original; stopClassroom() }
  assert.ok(getDb().prepare('SELECT ended_at FROM classroom_sessions WHERE note_id = ?').get(n.id).ended_at)
  assert.equal(getDb().prepare('SELECT end_reason FROM classroom_sessions WHERE note_id = ?').get(n.id).end_reason, 'stopped')
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM classroom_calibrations WHERE note_id = ? AND reason = 'manual'").get(n.id).n, 1)
})

test('整理使用段落当时的教材位置而非当前页，并保留原转写', async () => {
  const m = material(), n = await note()
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[0] }))
  const segment = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '牛顿第二定律的转写原文' }))
  ok(await invoke('classroom:calibrate', { note_id: n.id, block_id: m.blocks[2] }))
  const p = ok(await invoke('providers:save', { name: 'test', base_url: 'https://example.invalid', api_format: 'anthropic', api_key: 'dummy' }))
  ok(await invoke('models:save', { provider_id: p.id, model_id: 'test' }))
  const original = globalThis.fetch
  let payload
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body)
    return new Response('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: JSON.stringify({ seg_type: 'proposition', organized_text: '整理后的内容' }) } }) + '\n\n')
  }
  try {
    await organizeSegment(segment.id)
    const prompt = JSON.stringify(payload)
    assert.match(prompt, /原版基准/); assert.match(prompt, /附近参考/)
    assert.doesNotMatch(prompt, /第三页新增/)
    assert.match(prompt, /不是指令/)
    const saved = ok(await invoke('notes:get', n.id)).segments[0]
    assert.equal(saved.raw_text, '牛顿第二定律的转写原文')
    assert.equal(saved.material_ref.id, m.blocks[0])
  } finally { globalThis.fetch = original }
})
