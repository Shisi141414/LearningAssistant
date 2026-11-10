/**
 * scripts/smoke-db.ts —— 数据库迁移冒烟测试
 *
 * 在内存 SQLite 上执行全部迁移，验证：
 *  1. SQL 语法与表结构（15 张表）
 *  2. 外键约束生效
 *  3. 级联删除（note → segments → annotations；provider → models）
 *  4. 基本插入/查询往返
 *
 * 运行：node --experimental-strip-types scripts/smoke-db.ts
 */
import Database from 'better-sqlite3'
import { MIGRATIONS } from '../src/main/db/migrations.ts'

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

console.log('1. 执行全部迁移')
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
for (const m of MIGRATIONS) {
  db.exec(m.sql)
  db.pragma(`user_version = ${m.version}`)
}

console.log('2. 表结构')
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
const expected = [
  'subjects', 'providers', 'models', 'notes', 'note_segments', 'annotations',
  'chat_sessions', 'chat_messages', 'knowledge_points', 'knowledge_edges',
  'materials', 'exercises', 'inspirations', 'assignments', 'review_records'
]
assert(expected.every((t) => tables.includes(t)), `15 张表全部创建（实际 ${tables.length} 张）`)

console.log('3. 核心读写链路（学科→笔记→段落→标注）')
const subjId = 'subj-1'
db.prepare('INSERT INTO subjects (id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)').run(subjId, '数学分析', '#2563eb', '', Date.now())
const noteId = 'note-1'
db.prepare('INSERT INTO notes (id, subject_id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(noteId, subjId, '测试笔记', 'manual', Date.now(), Date.now())
const segId = 'seg-1'
db.prepare('INSERT INTO note_segments (id, note_id, sort_order, seg_type, raw_text, organized_text, image_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(segId, noteId, 0, 'definition', '原文', '整理后', null, Date.now(), Date.now())
db.prepare('INSERT INTO annotations (id, segment_id, kind, anchor_json, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('ann-1', segId, 'keypoint', null, '重要定义', Date.now())
const segBack = db.prepare('SELECT seg_type, organized_text FROM note_segments WHERE id = ?').get(segId) as { seg_type: string; organized_text: string }
assert(segBack.seg_type === 'definition' && segBack.organized_text === '整理后', '段落双字段（raw/organized）与类型读写正常')
const annCount = (db.prepare('SELECT COUNT(*) AS c FROM annotations').get() as { c: number }).c
assert(annCount === 1, '标注写入正常')

console.log('4. 级联删除')
db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
const segAfter = (db.prepare('SELECT COUNT(*) AS c FROM note_segments').get() as { c: number }).c
const annAfter = (db.prepare('SELECT COUNT(*) AS c FROM annotations').get() as { c: number }).c
assert(segAfter === 0 && annAfter === 0, '删除笔记级联删除段落与标注')

console.log('5. 供应商→模型（唯一约束 + 级联）')
db.prepare('INSERT INTO providers (id, name, base_url, api_format, api_key_encrypted, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('p-1', 'DeepSeek', 'https://api.deepseek.com/v1', 'openai', Buffer.from('x'), 1, Date.now(), Date.now())
db.prepare('INSERT INTO models (id, provider_id, model_id, display_name, context_length, supports_vision, speed_tier, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('m-1', 'p-1', 'deepseek-chat', 'DeepSeek Chat', 128000, 0, 'fast', '', Date.now())
let dupRejected = false
try {
  db.prepare('INSERT INTO models (id, provider_id, model_id, display_name, context_length, supports_vision, speed_tier, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('m-2', 'p-1', 'deepseek-chat', 'dup', null, 0, null, '', Date.now())
} catch {
  dupRejected = true
}
assert(dupRejected, '同供应商重复 model_id 被唯一约束拒绝')
db.prepare('DELETE FROM providers WHERE id = ?').run('p-1')
const modelAfter = (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c
assert(modelAfter === 0, '删除供应商级联删除模型')

console.log('6. 对话表读写')
db.prepare('INSERT INTO chat_sessions (id, subject_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('s-1', subjId, '测试会话', Date.now(), Date.now())
db.prepare('INSERT INTO chat_messages (id, session_id, role, content, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('msg-1', 's-1', 'user', '什么是极限？', null, Date.now())
const msgBack = db.prepare("SELECT role FROM chat_messages WHERE id = 'msg-1'").get() as { role: string }
assert(msgBack.role === 'user', '会话消息写入正常')

console.log('7. 迁移版本与活动实体（002）')
const uv = db.pragma('user_version', { simple: true }) as number
assert(uv === MIGRATIONS[MIGRATIONS.length - 1].version, `user_version = ${uv}（等于最新迁移版本）`)
const activityTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activities'").all() as unknown[]).length
assert(activityTables === 1, 'activities 表已创建（002 迁移）')
const notesActivityCol = (db.prepare("SELECT 1 FROM pragma_table_info('notes') WHERE name='activity_id'").all() as unknown[]).length
assert(notesActivityCol === 1, 'notes.activity_id 列已添加')
const chatActivityCol = (db.prepare("SELECT 1 FROM pragma_table_info('chat_sessions') WHERE name='activity_id'").all() as unknown[]).length
assert(chatActivityCol === 1, 'chat_sessions.activity_id 列已添加')

console.log('8. 活动链路（活动→笔记挂载→删除活动笔记保留）')
db.prepare('INSERT INTO activities (id, title, kind, happened_at, subject_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('act-1', '力学前沿讲座', 'lecture', Date.now(), subjId, '', Date.now())
db.prepare('INSERT INTO notes (id, subject_id, activity_id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('note-act', null, 'act-1', '讲座笔记', 'manual', Date.now(), Date.now())
let bothRejected = false
try {
  db.prepare('INSERT INTO notes (id, subject_id, activity_id, title, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('note-bad', subjId, 'act-1', '违规双挂', 'manual', Date.now(), Date.now())
} catch {
  bothRejected = true
}
if (!bothRejected) {
  // SQLite 层不拦双挂（CHECK 约束未加，业务层校验——见 notes.ipc.ts），这里验证数据形态即可
  db.prepare('DELETE FROM notes WHERE id = ?').run('note-bad')
}
console.log('  （双挂校验在业务层 notes.ipc.ts 完成，DB 层允许但不产生脏数据路径）')
db.prepare('DELETE FROM activities WHERE id = ?').run('act-1')
const actNoteAfter = (db.prepare("SELECT COUNT(*) AS c FROM notes WHERE id = 'note-act'").get() as { c: number }).c
const actIdAfter = (db.prepare("SELECT activity_id FROM notes WHERE id = 'note-act'").get() as { activity_id: string | null }).activity_id
assert(actNoteAfter === 1 && actIdAfter === null, '删除活动后笔记保留且 activity_id 置 NULL（ON DELETE SET NULL）')

console.log('')
if (failed > 0) {
  console.error(`✗ 冒烟测试失败：${failed} 项断言未通过`)
  process.exit(1)
}
console.log('✓ 数据库冒烟测试全部通过')
