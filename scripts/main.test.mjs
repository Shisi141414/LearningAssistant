import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { handlers, events, event, invoke, electronMock } from './test-support.mjs'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { getDb, closeDb, dbFilePath } from '../src/main/services/db.ts'
import { migrateStorage, resetStorage } from '../src/main/services/storage.ts'
import { beginWork } from '../src/main/services/work.ts'
import { encryptSecret } from '../src/main/services/secrets.ts'
import { organizeSegment, retryPending } from '../src/main/services/organizer.ts'
import { asrService } from '../src/main/services/asr.ts'
import { stopClassroom } from '../src/main/ipc/classroom.ipc.ts'
import { configSet } from '../src/main/services/config.ts'

registerAllIpc()
after(() => { stopClassroom(); closeDb() })
const ok = (result) => { assert.equal(result.ok, true, result.error); return result.data }
const note = async () => ok(await invoke('notes:create', { title: '回归课堂', source: 'class' }))
async function provider() {
  const p = ok(await invoke('providers:save', { name: 'test', base_url: 'https://example.invalid', api_format: 'anthropic', api_key: 'dummy' }))
  ok(await invoke('models:save', { provider_id: p.id, model_id: 'test' }))
  return p
}

test('非法来源和非法参数不会产生写入', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n
  assert.equal((await handlers.get('notes:create')({ ...event, senderFrame: { url: 'https://evil.invalid' } }, { title: 'bad' })).ok, false)
  assert.equal((await invoke('notes:create', { title: 'bad', source: 'invalid' })).ok, false)
  assert.equal((await invoke('notes:addSegment', { note_id: 'missing', seg_type: 'invalid' })).ok, false)
  assert.equal((await invoke('config:set', 'arbitrary.key', 'value')).ok, false)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n, before)
})

test('系统加密不可用时拒绝持久化密钥', () => {
  const previous = electronMock.safeStorage.isEncryptionAvailable
  electronMock.safeStorage.isEncryptionAvailable = () => false
  try { assert.throws(() => encryptSecret('dummy'), /未保存/); assert.equal(encryptSecret(''), null) }
  finally { electronMock.safeStorage.isEncryptionAvailable = previous }
})

test('取消模型流后数据库保留已生成文本', async () => {
  await provider()
  const session = ok(await invoke('chat:createSession', {}))
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"保留这段"}}\n\n'))
      options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
    }
  }))
  try {
    const pending = invoke('chat:send', { session_id: session.id, content: '测试取消' })
    while (!events.some(e => e.channel === 'llm:chunk' && e.data.delta === '保留这段')) await new Promise(resolve => setTimeout(resolve, 5))
    const message = events.find(e => e.channel === 'llm:chunk' && e.data.delta === '保留这段').data.message_id
    ok(await invoke('chat:abort', message))
    ok(await pending)
    assert.equal(getDb().prepare('SELECT content FROM chat_messages WHERE id = ?').get(message).content, '保留这段')
  } finally { globalThis.fetch = original }
})

test('整理期间人工编辑不会被覆盖，失败队列持久化且可重试', async () => {
  const n = await note()
  const segment = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '原文' }))
  const original = globalThis.fetch
  let respond
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  try {
    const first = organizeSegment(segment.id)
    assert.equal(organizeSegment(segment.id), first)
    ok(await invoke('notes:updateSegment', { id: segment.id, organized_text: '人工修改' }))
    respond(new Response('data: ' + JSON.stringify({type:'content_block_delta', delta:{text:JSON.stringify({seg_type:'note',organized_text:'AI'})}}) + '\n\n'))
    await assert.rejects(first, /段落已被编辑/)
    const saved = getDb().prepare('SELECT * FROM note_segments WHERE id = ?').get(segment.id)
    assert.equal(saved.organized_text, '人工修改')
    assert.equal(saved.organize_status, 'conflict')
    const other = ok(await invoke('notes:addSegment', { note_id: n.id, raw_text: '待补整理' }))
    globalThis.fetch = async () => { throw new Error('offline') }
    await assert.rejects(organizeSegment(other.id), /offline/)
    closeDb()
    assert.equal(getDb().prepare('SELECT organize_status FROM note_segments WHERE id = ?').get(other.id).organize_status, 'failed')
    const payload = JSON.stringify({ type: 'content_block_delta', delta: { text: JSON.stringify({ seg_type: 'note', organized_text: '已补整理' }) } })
    globalThis.fetch = async () => new Response('data: ' + payload + '\n\n')
    assert.equal(await retryPending(n.id, true), 1)
    assert.equal(getDb().prepare('SELECT organized_text FROM note_segments WHERE id = ?').get(other.id).organized_text, '已补整理')
  } finally { globalThis.fetch = original }
})

test('ASR flush 保存未断句的尾句且重复 stop 不重复保存', () => {
  const finals = []
  asrService.recognizer = { isReady: () => false, getResult: () => ({ text: '尾句' }), createStream: () => null }
  asrService.stream = { acceptWaveform() {}, inputFinished() {} }
  asrService.events = { onPartial() {}, onFinal: text => finals.push(text) }
  asrService.stop(); asrService.stop()
  assert.deepEqual(finals, ['尾句'])
})

test('迁移不覆盖已有库，成功迁移保留旧库与材料，活动任务阻止迁移', () => {
  configSet('classroom.autoOrganize', '0')
  const conflict = mkdtempSync(join(tmpdir(), 'learning-conflict-'))
  const marker = join(conflict, 'learning-assistant.db')
  writeFileSync(marker, 'existing')
  const source = dbFilePath()
  assert.throws(() => migrateStorage(conflict), /未覆盖/)
  assert.equal(readFileSync(marker, 'utf8'), 'existing')
  assert.equal(dbFilePath(), source)
  const rollbackTarget = mkdtempSync(join(tmpdir(), 'learning-rollback-'))
  const rename = fs.renameSync
  fs.renameSync = (from, to) => { if (to.endsWith('app-config.json')) throw new Error('injected config failure'); return rename(from, to) }
  syncBuiltinESMExports()
  try {
    assert.throws(() => migrateStorage(rollbackTarget), /injected config failure/)
    assert.equal(dbFilePath(), source)
    assert.ok(getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n > 0)
    assert.equal(fs.existsSync(join(rollbackTarget, 'learning-assistant.db')), false)
  } finally { fs.renameSync = rename; syncBuiltinESMExports() }
  const target = mkdtempSync(join(tmpdir(), 'learning-target-'))
  const release = beginWork('测试任务')
  try { assert.throws(() => migrateStorage(target), /测试任务/) } finally { release() }
  const materialDir = join(source, '..', 'materials'); mkdirSync(materialDir)
  writeFileSync(join(materialDir, 'sample.txt'), 'fixture')
  migrateStorage(target)
  assert.equal(readFileSync(join(target, 'materials', 'sample.txt'), 'utf8'), 'fixture')
  assert.ok(getDb().prepare('SELECT COUNT(*) AS n FROM notes').get().n > 0)
  assert.throws(() => resetStorage(), /未覆盖/)
  assert.equal(dbFilePath(), join(target, 'learning-assistant.db'))
})
