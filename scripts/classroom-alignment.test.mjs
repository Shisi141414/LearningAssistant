import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import {
  ClassroomMatcher,
  alignmentWords
} from '../shared/classroom-alignment.ts'
import { addSegment } from '../src/main/services/segments.ts'
import {
  calibrateClassroom,
  classroomPosition,
  segmentMaterialRef,
  attachMaterialRefs,
  materialNoteRefs,
  segmentMaterialContext
} from '../src/main/services/classroom-materials.ts'
import {
  startClassroomAlignment,
  stopClassroomAlignment,
  classroomAlignmentState,
  saveClassroomAlignment,
  waitForClassroomAlignment,
  cancelStaleAlignment,
  recoverClassroomAlignment
} from '../src/main/services/classroom-alignment.ts'
import { assertIdle } from '../src/main/services/work.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { organizeSegment } from '../src/main/services/organizer.ts'

const contents = [
  '动量定理描述合外力冲量等于质点动量的变化，速度与质量相乘得到动量。',
  '刚体绕固定轴转动时，角速度和转动惯量共同决定角动量，外力矩改变转动状态。',
  '理想气体状态方程联系压强体积温度，气体常数反映单位物质的量的热力学性质。',
  '矩阵特征值通过特征多项式计算，对角化要求存在完备线性无关的特征向量。',
  '傅里叶级数使用三角函数展开周期信号，正交性可以求得各项系数。',
  '泊松括号描述哈密顿系统的正则结构，守恒量与对称性之间存在联系。',
  '复变函数围道积分遵循留数定理，孤立奇点的留数决定积分结果。',
  '流体连续性方程反映质量守恒，流速和截面积互相制约。',
  '熵增原理限制孤立系统演化方向，不可逆过程产生正的熵增。',
  '弯曲梁的截面应力由弯矩决定，中性轴的位置与截面几何相关。'
]
const blocks = contents.map((text, ordinal) => ({
  id: 'b' + ordinal,
  text,
  ordinal,
  locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 })
}))

await test('v30→31 故障回滚、旧笔记/教材/手动来源保留，移除故障后升级', () => {
  let old = new Database(join(dataRoot, 'learning-assistant.db'))
  old.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 30)) old.exec(m.sql)
  old.pragma('user_version=30')
  old.exec(`INSERT INTO notes(id,title,source,created_at,updated_at) VALUES('n','力学课堂','class',1,1);
    INSERT INTO materials(id,title,kind,created_at) VALUES('m','力学教材','textbook',1);
    INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('v','m','test.pdf','pdf','unused.pdf','hash','ready',1);
    UPDATE materials SET current_version_id='v' WHERE id='m';
    INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES('b0','v',0,'原始教材','{}');
    INSERT INTO note_segments(id,note_id,sort_order,raw_text,organized_text,created_at,updated_at) VALUES('old','n',0,'原始教师讲授','人工整理',1,1);
    INSERT INTO segment_material_refs(segment_id,block_id) VALUES('old','b0');
    CREATE TABLE classroom_alignment_jobs(id TEXT);`)
  old.close()
  assert.throws(() => getDb(), /already exists/)
  old = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(old.pragma('user_version', { simple: true }), 30)
  assert.equal(
    old
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='classroom_alignment_settings'"
      )
      .get(),
    undefined
  )
  assert.equal(
    old.prepare('SELECT organized_text FROM note_segments').get()
      .organized_text,
    '人工整理'
  )
  old.exec('DROP TABLE classroom_alignment_jobs')
  old.close()
  const db = getDb()
  assert.equal(db.pragma('user_version', { simple: true }), 31)
  assert.equal(segmentMaterialRef('old').id, 'b0')
  db.prepare('UPDATE material_blocks SET text=? WHERE id=?').run(
    contents[0],
    'b0'
  )
  for (const b of blocks.slice(1))
    db.prepare(
      'INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES(?,?,?,?,?)'
    ).run(b.id, 'v', b.ordinal, b.text, b.locator_json)
  db.exec(
    "INSERT INTO classroom_sessions(id,note_id,started_at) VALUES('session','n',1)"
  )
})
registerAllIpc()
let db = getDb()
const state = () => classroomAlignmentState('n')
const job = (id) =>
  db
    .prepare('SELECT * FROM classroom_alignment_jobs WHERE segment_id=?')
    .get(id)
const enable = () =>
  saveClassroomAlignment({
    note_id: 'n',
    revision: state().revision,
    enabled: true
  })
const add = async (text) => {
  const s = addSegment({ note_id: 'n', raw_text: text })
  await waitForClassroomAlignment(s.id)
  return s
}

await test('直接复用 MiniSearch：中文/英文、OCR 空格、低信息、离题和重复段落拒绝', () => {
  const matcher = new ClassroomMatcher(blocks)
  const found = matcher.match(
    '刚体绕固定轴转动时角速度和转动惯量共同决定角动量',
    0
  )
  assert.equal(found.strong, true)
  assert.equal(found.candidates[0].id, 'b1')
  assert.equal(
    matcher.match(
      '刚 体 绕 固 定 轴 转 动 时 角 速 度 和 转 动 惯 量 共 同 决 定 角 动 量',
      0
    ).candidates[0].id,
    'b1'
  )
  assert.equal(matcher.match('我们这个然后下面', 0).strong, false)
  assert.equal(
    matcher.match('今天讨论食堂菜单鸡腿米饭水果套餐', 0).strong,
    false
  )
  assert.equal(matcher.match('热力学', 0).strong, false)
  const duplicate = new ClassroomMatcher([
    ...blocks,
    { ...blocks[1], id: 'duplicate', ordinal: 20 }
  ])
  assert.equal(duplicate.match(contents[1], 1).strong, false)
  const english = new ClassroomMatcher([
    {
      id: 'en',
      ordinal: 0,
      text: 'Hamiltonian dynamics canonical transformation Poisson bracket conservation',
      locator_json: '{}'
    }
  ])
  assert.equal(
    english.match('canonical transformation Poisson bracket conservation', 0)
      .strong,
    true
  )
  assert.ok(alignmentWords('压强 体积 温度').length >= 3)
})

await test('默认关闭；启用后真实 worker 自动推进、原始锚点与内部来源历史不改写', async () => {
  startClassroomAlignment('n', 'session')
  calibrateClassroom('n', 'b0', 'session')
  const off = await add(contents[1])
  assert.equal(job(off.id), undefined)
  enable()
  const first = await add(contents[0])
  assert.equal(job(first.id).status, 'applied')
  const s = await add(contents[1])
  assert.equal(job(s.id).status, 'applied')
  assert.equal(classroomPosition('n').block.id, 'b1')
  assert.equal(segmentMaterialRef(s.id).id, 'b1')
  assert.equal(
    db
      .prepare('SELECT block_id FROM segment_material_refs WHERE segment_id=?')
      .get(s.id).block_id,
    'b0'
  )
  assert.equal(segmentMaterialRef(first.id).id, 'b0')
  assert.equal(segmentMaterialRef('old').id, 'b0')
  assert.equal(attachMaterialRefs('n', [s])[0].material_ref.id, 'b1')
  assert.ok(materialNoteRefs('b1').some((r) => r.segment_id === s.id))
  assert.ok(!materialNoteRefs('b0').some((r) => r.segment_id === s.id))
  assert.match(segmentMaterialContext(s.id), /讲授位置/)
  const snapshots = db
    .prepare(
      'SELECT snapshot_json FROM note_learning_blocks WHERE segment_id=? ORDER BY rowid'
    )
    .all(s.id)
  assert.equal(snapshots.length, 2)
  assert.ok(snapshots[0].snapshot_json.includes('b0'))
  assert.ok(snapshots[1].snapshot_json.includes('b1'))
})

await test('跳页/回讲需要连续明确证据；短句不翻页；人工校准下一段优先', async () => {
  const far = await add(contents[8])
  assert.equal(job(far.id).status, 'review')
  assert.equal(classroomPosition('n').block.id, 'b1')
  const confirm = await add(contents[8])
  assert.equal(job(confirm.id).status, 'applied')
  assert.equal(classroomPosition('n').block.id, 'b8')
  const back = await add(contents[1])
  assert.equal(job(back.id).status, 'review')
  await add(contents[1])
  assert.equal(classroomPosition('n').block.id, 'b1')
  await add('我们下面继续看这个')
  assert.equal(classroomPosition('n').block.id, 'b1')
  calibrateClassroom('n', 'b2', 'session')
  cancelStaleAlignment('n')
  const held = await add(contents[1])
  assert.equal(job(held.id).status, 'review')
  assert.equal(classroomPosition('n').block.id, 'b2')
  await add(contents[1])
  assert.equal(classroomPosition('n').block.id, 'b1')
})

await test('计算期间手动校准、编辑、删除、停用和归档的旧结果均不能发布', async () => {
  const s = addSegment({ note_id: 'n', raw_text: contents[2] })
  await Promise.resolve()
  calibrateClassroom('n', 'b4', 'session')
  cancelStaleAlignment('n')
  await waitForClassroomAlignment(s.id)
  assert.equal(job(s.id).status, 'cancelled')
  assert.equal(classroomPosition('n').block.id, 'b4')
  const edited = addSegment({ note_id: 'n', raw_text: contents[5] })
  await Promise.resolve()
  db.prepare(
    'UPDATE note_segments SET raw_text=?,revision=revision+1 WHERE id=?'
  ).run('用户刚刚修改原文', edited.id)
  await waitForClassroomAlignment(edited.id)
  assert.equal(job(edited.id).status, 'cancelled')
  const deleted = addSegment({ note_id: 'n', raw_text: contents[5] })
  await Promise.resolve()
  db.prepare('DELETE FROM note_segments WHERE id=?').run(deleted.id)
  await waitForClassroomAlignment(deleted.id)
  assert.equal(job(deleted.id), undefined)
  const archived = addSegment({ note_id: 'n', raw_text: contents[5] })
  await Promise.resolve()
  db.exec("UPDATE materials SET archived=1 WHERE id='m'")
  await waitForClassroomAlignment(archived.id)
  assert.equal(job(archived.id).status, 'cancelled')
  db.exec("UPDATE materials SET archived=0 WHERE id='m'")
  const disabled = addSegment({ note_id: 'n', raw_text: contents[5] })
  await Promise.resolve()
  saveClassroomAlignment({
    note_id: 'n',
    revision: state().revision,
    enabled: false
  })
  await waitForClassroomAlignment(disabled.id)
  assert.equal(job(disabled.id).status, 'cancelled')
  assert.equal(classroomPosition('n').block.id, 'b4')
})

await test('排队失败不能丢转写；发布故障整批回滚，历史和当前位置保留', async () => {
  enable()
  db.exec(
    "CREATE TRIGGER alignment_queue_fault BEFORE INSERT ON classroom_alignment_jobs BEGIN SELECT RAISE(ABORT,'queue fault'); END"
  )
  const raw = addSegment({ note_id: 'n', raw_text: '必须保留的教师原文' })
  assert.equal(
    db.prepare('SELECT raw_text FROM note_segments WHERE id=?').get(raw.id)
      .raw_text,
    '必须保留的教师原文'
  )
  assert.match(state().error, /已保存/)
  db.exec('DROP TRIGGER alignment_queue_fault')
  await add(contents[4]) // consume manual hold at current position
  // Inject publication failure only after initial raw capture succeeds.
  const s = addSegment({ note_id: 'n', raw_text: contents[5] })
  db.exec(
    "CREATE TRIGGER alignment_publish_fault BEFORE INSERT ON note_learning_blocks BEGIN SELECT RAISE(ABORT,'publish fault'); END"
  )
  await waitForClassroomAlignment(s.id)
  assert.equal(job(s.id).status, 'failed')
  assert.equal(classroomPosition('n').block.id, 'b4')
  assert.equal(segmentMaterialRef(s.id).id, 'b4')
  assert.equal(
    db
      .prepare(
        'SELECT count(*) AS n FROM note_learning_blocks WHERE segment_id=?'
      )
      .get(s.id).n,
    1
  )
  db.exec('DROP TRIGGER alignment_publish_fault')
})

await test('材料切换阻止旧版本回写；积压和大教材保留原文并转为校准', async () => {
  db.exec(
    "INSERT INTO materials(id,title,kind,created_at) VALUES('m2','第二份教材','handout',1); INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('v2','m2','second.docx','docx','unused','hash2','ready',1)"
  )
  db.prepare(
    'INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES(?,?,?,?,?)'
  ).run('other', 'v2', 0, contents[3], '{}')
  const previous = addSegment({ note_id: 'n', raw_text: contents[5] })
  await Promise.resolve()
  calibrateClassroom('n', 'other', 'session')
  cancelStaleAlignment('n')
  await waitForClassroomAlignment(previous.id)
  assert.equal(job(previous.id).status, 'cancelled')
  const second = await add(contents[3])
  assert.equal(job(second.id).status, 'applied')
  assert.equal(segmentMaterialRef(second.id).version_id, 'v2')
  const batch = Array.from({ length: 11 }, () =>
    addSegment({ note_id: 'n', raw_text: contents[3] })
  )
  assert.ok(batch.filter((s) => job(s.id).status === 'review').length >= 3)
  await Promise.all(batch.map((s) => waitForClassroomAlignment(s.id)))
  assert.equal(
    db
      .prepare(
        'SELECT count(*) AS n FROM note_segments WHERE id IN (' +
          batch.map(() => '?').join(',') +
          ')'
      )
      .get(...batch.map((s) => s.id)).n,
    11
  )
  calibrateClassroom('n', 'b4', 'session')
  cancelStaleAlignment('n')
  // Exceed the index bound without losing raw recording or blocking the main thread.
  const insert = db.prepare(
    'INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES(?,?,?,?,?)'
  )
  db.transaction(() => {
    for (let i = 10; i <= 5000; i++)
      insert.run('extra' + i, 'v', i, '用于验证上限的来源正文', '{}')
  })()
  const large = await add(contents[4])
  assert.equal(job(large.id).status, 'failed')
  assert.match(job(large.id).reason, /范围/)
  assert.equal(segmentMaterialRef(large.id).id, 'b4')
  db.exec("DELETE FROM material_blocks WHERE ordinal>=10 AND version_id='v'")
})

await test('整理等待教材期间人工改写优先，不以新修订作为旧请求的发布基准', async () => {
  const s = addSegment({ note_id: 'n', raw_text: contents[5] })
  const organizing = organizeSegment(s.id)
  const rejected = assert.rejects(organizing, /段落已被编辑/)
  db.prepare(
    'UPDATE note_segments SET organized_text=?,revision=revision+1 WHERE id=?'
  ).run('用户手动修订必须保留', s.id)
  await rejected
  const saved = db
    .prepare(
      'SELECT organized_text,organize_status FROM note_segments WHERE id=?'
    )
    .get(s.id)
  assert.equal(saved.organized_text, '用户手动修订必须保留')
  assert.equal(saved.organize_status, 'conflict')
})

await test('启停修订及 IPC 严格校验；结束/退出取消等待，不启动延迟整理', async () => {
  const revision = state().revision
  assert.throws(
    () =>
      saveClassroomAlignment({
        note_id: 'n',
        revision: 'stale',
        enabled: false
      }),
    /已变化/
  )
  assert.equal(
    (
      await invoke('classroom:alignmentSave', {
        note_id: 'n',
        revision,
        enabled: 'yes'
      })
    ).ok,
    false
  )
  assert.equal(
    (
      await invoke('classroom:alignmentSave', {
        note_id: 'n',
        revision,
        enabled: true,
        unknown: 1
      })
    ).ok,
    false
  )
  const s = addSegment({ note_id: 'n', raw_text: contents[5] })
  const rejected = assert.rejects(organizeSegment(s.id), /正在退出/)
  await Promise.resolve()
  const waiting = waitForClassroomAlignment(s.id)
  stopClassroomAlignment(true)
  assert.equal(await waiting, false)
  await rejected
  assert.equal(job(s.id).status, 'cancelled')
  await new Promise((r) => setTimeout(r, 100))
  assert.doesNotThrow(() => assertIdle())
})

await test('重启取消未完成匹配，保留已发布引用与历史；下一课堂可再次启用', async () => {
  const applied = db
    .prepare(
      "SELECT segment_id,applied_block_id FROM classroom_alignment_jobs WHERE status='applied' LIMIT 1"
    )
    .get()
  const unfinished = db
    .prepare(
      'SELECT id FROM classroom_alignment_jobs ORDER BY rowid DESC LIMIT 1'
    )
    .get().id
  db.prepare(
    "UPDATE classroom_alignment_jobs SET status='running' WHERE id=?"
  ).run(unfinished)
  closeDb()
  recoverClassroomAlignment()
  db = getDb()
  assert.equal(
    getDb()
      .prepare('SELECT status FROM classroom_alignment_jobs WHERE id=?')
      .get(unfinished).status,
    'cancelled'
  )
  assert.equal(
    segmentMaterialRef(applied.segment_id).id,
    applied.applied_block_id
  )
  getDb().exec(
    "INSERT INTO classroom_sessions(id,note_id,started_at) VALUES('session2','n',2)"
  )
  startClassroomAlignment('n', 'session2')
  const s = await add(contents[5])
  assert.equal(job(s.id).status, 'applied')
  stopClassroomAlignment()
})
after(async () => {
  stopClassroomAlignment()
  await new Promise((r) => setTimeout(r, 100))
  closeDb()
})
