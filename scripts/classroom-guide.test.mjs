import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { detectClassroomGuide } from '../shared/classroom-guide.ts'
import { addSegment } from '../src/main/services/segments.ts'
import {
  startClassroomGuide,
  stopClassroomGuide,
  saveClassroomGuide,
  classroomGuideState,
  classroomGuideAction,
  queueClassroomGuide
} from '../src/main/services/classroom-guide.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { stopClassroom } from '../src/main/ipc/classroom.ipc.ts'
import { asrService } from '../src/main/services/asr.ts'
import { configSet } from '../src/main/services/config.ts'

after(() => {
  stopClassroom()
  stopClassroomGuide()
  closeDb()
})
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(setImmediate)
}
const state = () => classroomGuideState('guide-note')
const enable = (enabled = true) =>
  saveClassroomGuide({
    note_id: 'guide-note',
    revision: state().revision,
    enabled,
    cooldown_seconds: 15
  })
const segment = (text = '重点：注意边界条件。') =>
  addSegment({ note_id: 'guide-note', raw_text: text })
const newest = () => state().hints[0]
const start = (id) => {
  getDb()
    .prepare(
      'INSERT INTO classroom_sessions(id,note_id,started_at) VALUES(?,?,?)'
    )
    .run(id, 'guide-note', Date.now())
  startClassroomGuide('guide-note', id)
}

test('中文规则：优先级、引号、否定、精确原文位置及有界输入', () => {
  assert.equal(detectClassroomGuide('今天我们讨论平面运动。'), null)
  for (const text of [
    '这不是重点。',
    '不必特别注意这个数字。',
    '无需务必记住。',
    '他说“这是重点，考试会考”然后继续。',
    '「容易出错」是标题。'
  ])
    assert.equal(detectClassroomGuide(text), null, text)
  for (const [text, kind] of [
    ['这里很重要。', 'focus'],
    ['不要混淆向量与标量。', 'pitfall'],
    ['证明的关键在于构造辅助函数。', 'derivation'],
    ['考试会要求解释这个条件。', 'assessment'],
    ['我们定义这个量为势能。', 'concept']
  ])
    assert.equal(detectClassroomGuide(text)?.kind, kind, text)
  const raw = '😀“重点”只是引用；推导的关键是无滑动；考试会要求推导。'
  const match = detectClassroomGuide(raw)
  assert.equal(match.kind, 'assessment')
  for (const e of match.evidence)
    assert.equal(raw.slice(e.start, e.end), e.quote)
  assert.equal(detectClassroomGuide('重点' + '甲'.repeat(4001)), null)
  const long =
    '甲'.repeat(4100) + '重点；考试会考；容易出错；下面证明；定义为；务必记住'
  const bounded = detectClassroomGuide(long)
  assert.equal(bounded.evidence.length, 4)
  assert.ok(
    bounded.evidence.every(
      (e) => e.start >= 4100 && long.slice(e.start, e.end) === e.quote
    )
  )
})

test('035→036 升级失败整批回滚，重试保留原文、人工标注和知识关联', () => {
  let db = new Database(join(dataRoot, 'learning-assistant.db'))
  db.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 35))
    db.transaction(() => db.exec(m.sql))()
  db.pragma('user_version=35')
  db.exec(`INSERT INTO notes(id,title,source,created_at,updated_at) VALUES('guide-note','导学课堂','class',1,1);
    INSERT INTO note_segments(id,note_id,sort_order,raw_text,organized_text,created_at,updated_at) VALUES('guide-old','guide-note',0,'重点：旧原文','手动整理',1,1);
    INSERT INTO annotations(id,segment_id,kind,comment,created_at) VALUES('guide-old-mark','guide-old','keypoint','人工评论',1);
    INSERT INTO materials(id,title,kind,created_at) VALUES('guide-m','旧教材','textbook',1);
    INSERT INTO material_versions(id,material_id,file_name,format,file_path,fingerprint,status,created_at) VALUES('guide-v','guide-m','old.pdf','pdf','old.pdf','old-hash','ready',1);
    INSERT INTO material_blocks(id,version_id,ordinal,text,locator_json) VALUES('guide-b','guide-v',0,'旧教材来源','{}');
    INSERT INTO segment_material_refs(segment_id,block_id) VALUES('guide-old','guide-b');
    CREATE TABLE classroom_guide_hints(id TEXT);`)
  const refs = db.prepare('SELECT count(*) n FROM learning_sources').get().n
  db.close()
  assert.throws(() => getDb(), /already exists/)
  db = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(db.pragma('user_version', { simple: true }), 35)
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='classroom_guide_settings'"
      )
      .get(),
    undefined
  )
  db.exec('DROP TABLE classroom_guide_hints')
  db.close()
  const upgraded = getDb()
  assert.equal(upgraded.pragma('user_version', { simple: true }), 36)
  assert.equal(
    upgraded
      .prepare("SELECT organized_text FROM note_segments WHERE id='guide-old'")
      .get().organized_text,
    '手动整理'
  )
  assert.equal(
    upgraded
      .prepare("SELECT comment FROM annotations WHERE id='guide-old-mark'")
      .get().comment,
    '人工评论'
  )
  assert.equal(
    upgraded.prepare('SELECT count(*) n FROM learning_sources').get().n,
    refs
  )
  assert.equal(
    upgraded
      .prepare(
        "SELECT block_id FROM segment_material_refs WHERE segment_id='guide-old'"
      )
      .get().block_id,
    'guide-b'
  )
  assert.deepEqual(upgraded.pragma('foreign_key_check'), [])
})

test('默认关闭、仅处理新语段，冷却、重复、弱线索不播报，不自动写人工标注', async () => {
  start('guide-session')
  segment('重点：默认关闭不处理。')
  await settle()
  assert.equal(state().total, 0)
  enable()
  await settle()
  assert.equal(state().total, 0)
  const first = segment('重点：能量守恒需要核对系统边界。')
  await settle()
  assert.equal(newest().notice, true)
  assert.equal(newest().segment_id, first.id)
  assert.equal(getDb().prepare('SELECT count(*) n FROM annotations').get().n, 1)
  segment('易错：符号约定必须一致。')
  await settle()
  assert.equal(newest().notice, false)
  assert.match(newest().quiet_reason, /间隔/)
  segment('重点：能量守恒需要核对系统边界！')
  await settle()
  assert.match(newest().quiet_reason, /相同语段/)
  segment('我们定义惯性系。')
  await settle()
  assert.equal(newest().kind, 'concept')
  assert.equal(newest().notice, false)
  segment('这不是重点。')
  await settle()
  assert.equal(state().total, 4)
})

test('采纳事务、修订防覆盖、复用人工标注并保留评论，忽略不删除标注', async () => {
  enable()
  const s = segment('特别注意角速度的方向。')
  await settle()
  const hint = newest()
  getDb()
    .prepare(
      'INSERT INTO annotations(id,segment_id,kind,comment,created_at) VALUES(?,?,?,?,?)'
    )
    .run('user-mark', s.id, 'keypoint', '用户自己的解释', 1)
  const adopted = classroomGuideAction({
    id: hint.id,
    revision: hint.revision,
    action: 'keypoint'
  })
  assert.equal(adopted.annotation_id, 'user-mark')
  assert.equal(
    getDb()
      .prepare("SELECT comment FROM annotations WHERE id='user-mark'")
      .get().comment,
    '用户自己的解释'
  )
  assert.throws(
    () =>
      classroomGuideAction({
        id: hint.id,
        revision: hint.revision,
        action: 'question'
      }),
    /变化/
  )
  classroomGuideAction({
    id: adopted.id,
    revision: adopted.revision,
    action: 'dismiss'
  })
  assert.ok(
    getDb().prepare("SELECT 1 FROM annotations WHERE id='user-mark'").get()
  )
  enable()
  segment('务必掌握动量方程。')
  await settle()
  const pending = newest()
  getDb().exec(
    `CREATE TRIGGER guide_fail BEFORE UPDATE OF status ON classroom_guide_hints WHEN NEW.status='adopted' BEGIN SELECT RAISE(ABORT,'guide-fault'); END;`
  )
  assert.throws(
    () =>
      classroomGuideAction({
        id: pending.id,
        revision: pending.revision,
        action: 'question'
      }),
    /guide-fault/
  )
  assert.equal(
    getDb()
      .prepare('SELECT 1 FROM annotations WHERE segment_id=?')
      .get(pending.segment_id),
    undefined
  )
  assert.equal(newest().status, 'open')
  getDb().exec('DROP TRIGGER guide_fail')
})

test('源哈希校验、整理文字不误失效、删除保留证据、关闭和停止撤销待办', async () => {
  enable()
  const s = segment('考试会涉及微分方程。')
  await settle()
  let h = newest()
  getDb()
    .prepare(
      'UPDATE note_segments SET organized_text=?,revision=revision+1 WHERE id=?'
    )
    .run('仅修改整理文本', s.id)
  assert.equal(newest().stale, false)
  getDb()
    .prepare(
      'UPDATE note_segments SET raw_text=?,revision=revision+1 WHERE id=?'
    )
    .run('已经修正的原文', s.id)
  h = newest()
  assert.equal(h.stale, true)
  assert.match(h.excerpt, /考试会/)
  assert.throws(
    () =>
      classroomGuideAction({
        id: h.id,
        revision: h.revision,
        action: 'keypoint'
      }),
    /原文/
  )
  getDb().prepare('DELETE FROM note_segments WHERE id=?').run(s.id)
  assert.equal(newest().segment_id, null)
  assert.equal(newest().stale, true)
  const before = state().total
  const changed = segment('重点：排队后修改。')
  getDb()
    .prepare('UPDATE note_segments SET raw_text=? WHERE id=?')
    .run('普通说明', changed.id)
  const deleted = segment('重点：排队后删除。')
  getDb().prepare('DELETE FROM note_segments WHERE id=?').run(deleted.id)
  await settle()
  assert.equal(state().total, before)
  segment('重点：排队后关闭。')
  enable(false)
  await settle()
  assert.equal(state().total, before)
  enable()
  segment('重点：排队后停止。')
  stopClassroomGuide()
  await settle()
  assert.equal(state().total, before)
  assert.equal(state().active, false)
  assert.throws(() => enable(), /开始/)
})

test('队列有界，重复入队幂等；失败保留原文并可恢复后续新语段', async () => {
  start('guide-session-bounded')
  enable()
  for (let i = 0; i < 40; i++) segment('重点：队列样例 ' + i)
  assert.equal(state().queued, 32)
  assert.equal(state().dropped, 8)
  await settle()
  assert.equal(state().queued, 0)
  const total = state().total,
    h = newest()
  queueClassroomGuide(h.segment_id)
  queueClassroomGuide(h.segment_id)
  await settle()
  assert.equal(state().total, total)
  getDb().exec(
    `CREATE TRIGGER guide_insert_fail BEFORE INSERT ON classroom_guide_hints BEGIN SELECT RAISE(ABORT,'guide-insert-fault'); END;`
  )
  const source = segment('重点：失败也保存原文。')
  await settle()
  assert.match(state().error, /原文已保存/)
  assert.ok(
    getDb().prepare('SELECT 1 FROM note_segments WHERE id=?').get(source.id)
  )
  getDb().exec('DROP TRIGGER guide_insert_fail')
  enable()
  segment('重点：恢复后新的语段。')
  await settle()
  assert.equal(state().error, '')
  assert.equal(state().total, total + 1)
  assert.equal(
    classroomGuideState('guide-note', 30).hints.length,
    state().total - 30
  )
})

test('IPC 拒绝未知字段/动作/非整数间隔；结束后的 ASR 回调不会写入下一场', async () => {
  stopClassroomGuide()
  registerAllIpc()
  for (const [channel, value] of [
    ['classroom:guide', { note_id: 'guide-note', offset: -1 }],
    [
      'classroom:guide-save',
      {
        note_id: 'guide-note',
        revision: null,
        enabled: true,
        cooldown_seconds: 15.5
      }
    ],
    ['classroom:guide-action', { id: 'x', revision: 'r', action: 'delete' }],
    ['classroom:guide', { note_id: 'guide-note', offset: 0, extra: 'x' }]
  ])
    assert.equal((await invoke(channel, value)).ok, false)
  const realStart = asrService.start,
    realStop = asrService.stop
  const callbacks = []
  asrService.start = async (options) => {
    callbacks.push(options.events)
  }
  asrService.stop = () => {}
  configSet('asr.model_dir', 'fake-model-only-test')
  try {
    assert.equal((await invoke('classroom:start', 'guide-note')).ok, true)
    assert.equal((await invoke('classroom:stop')).ok, true)
    assert.equal((await invoke('classroom:start', 'guide-note')).ok, true)
    const before = getDb()
      .prepare('SELECT count(*) n FROM note_segments')
      .get().n
    callbacks[0].onFinal('重点：旧课堂迟到回调。')
    assert.equal(
      getDb().prepare('SELECT count(*) n FROM note_segments').get().n,
      before
    )
    callbacks[1].onFinal('重点：当前课堂原文。')
    await settle()
    assert.equal(
      getDb().prepare('SELECT count(*) n FROM note_segments').get().n,
      before + 1
    )
  } finally {
    stopClassroom()
    asrService.start = realStart
    asrService.stop = realStop
    configSet('asr.model_dir', null)
  }
})

test('冷却时间到期恢复提示、重复窗口过期，设置旧修订不覆盖新设置', async () => {
  start('guide-clock')
  enable()
  const realNow = Date.now
  let now = realNow() + 1000
  Date.now = () => now
  try {
    const revision = state().revision
    segment('重点：冷却第一条。')
    await settle()
    assert.equal(newest().notice, true)
    now += 14000
    segment('重点：冷却尚未结束。')
    await settle()
    assert.equal(newest().notice, false)
    now += 1000
    segment('重点：冷却结束的新内容。')
    await settle()
    assert.equal(newest().notice, true)
    now += 16000
    segment('重点：冷却第一条！')
    await settle()
    assert.equal(newest().notice, false)
    assert.match(newest().quiet_reason, /相同/)
    now += 600000
    segment('重点：冷却第一条。')
    await settle()
    assert.equal(newest().notice, true)
    enable(false)
    assert.throws(
      () =>
        saveClassroomGuide({
          note_id: 'guide-note',
          revision,
          enabled: true,
          cooldown_seconds: 15
        }),
      /变化/
    )
    assert.equal(state().enabled, false)
  } finally {
    Date.now = realNow
    stopClassroomGuide()
  }
})

test('重启保留证据但无活动或待办，删除笔记级联且无悬空关联', () => {
  const before = state().total
  closeDb()
  assert.equal(state().total, before)
  assert.equal(state().active, false)
  assert.equal(state().queued, 0)
  getDb().prepare("DELETE FROM notes WHERE id='guide-note'").run()
  assert.equal(
    getDb().prepare('SELECT count(*) n FROM classroom_guide_hints').get().n,
    0
  )
  assert.equal(
    getDb().prepare('SELECT count(*) n FROM classroom_guide_settings').get().n,
    0
  )
  assert.deepEqual(getDb().pragma('foreign_key_check'), [])
})
