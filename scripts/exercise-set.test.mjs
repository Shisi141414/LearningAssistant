import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { invoke } from './test-support.mjs'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import {
  previewExerciseSet,
  importExerciseSet,
  discardExerciseSet
} from '../src/main/services/exercise-sets.ts'
import {
  getLearningDocument,
  publishLearningRevision
} from '../src/main/services/learning-documents.ts'
import {
  getExercise,
  saveExercise,
  trashExercise
} from '../src/main/services/exercises.ts'
import {
  initialLearningState,
  entryText,
  validateLearningState
} from '../shared/learning-document.ts'
import { splitExerciseSet } from '../shared/exercise-set.ts'
import { exerciseTexts } from '../shared/exercises.ts'
registerAllIpc()
after(() => closeDb())
let serial = 0
const id = () => `exercise-set-${++serial}`
const sources = (texts) =>
  texts.map((raw_text, ordinal) => ({
    id: id(),
    ordinal,
    raw_text,
    heading: '',
    locator_json: JSON.stringify({ kind: 'pdf', page: ordinal + 1 }),
    extraction: 'native'
  }))
const parse = (texts) => {
  const rows = sources(texts)
  return {
    rows,
    ...splitExerciseSet(rows, initialLearningState(rows, id), id)
  }
}
function fixture(
  texts = [
    '习题集\n1. 求 x 的导数。\n解题思路：按定义求解。\n标准答案：1\n2. 求 y。\n(1) 保留小问\n解：y=2'
  ]
) {
  const db = getDb(),
    material = id(),
    version = id(),
    doc = id(),
    revision = id(),
    rows = sources(texts),
    state = initialLearningState(rows, id)
  db.prepare(
    "INSERT INTO materials(id,title,kind,created_at) VALUES (?,'测试习题集','supplement',0)"
  ).run(material)
  db.prepare(
    "INSERT INTO material_versions(id,material_id,file_name,file_path,format,fingerprint,status,created_at) VALUES (?,?,'test.pdf','unused.pdf','pdf','hash','ready',0)"
  ).run(version, material)
  db.prepare('UPDATE materials SET current_version_id=? WHERE id=?').run(
    version,
    material
  )
  db.prepare(
    'INSERT INTO learning_documents(id,version_id,created_at) VALUES (?,?,0)'
  ).run(doc, version)
  for (const s of rows)
    db.prepare(
      'INSERT INTO learning_sources(id,document_id,ordinal,raw_text,heading,locator_json,extraction) VALUES (?,?,?,?,?,?,?)'
    ).run(
      s.id,
      doc,
      s.ordinal,
      s.raw_text,
      s.heading,
      s.locator_json,
      s.extraction
    )
  db.prepare(
    'INSERT INTO learning_revisions(id,document_id,snapshot_json,created_at) VALUES (?,?,?,0)'
  ).run(revision, doc, JSON.stringify(state))
  db.prepare(
    'UPDATE learning_documents SET current_revision_id=? WHERE id=?'
  ).run(revision, doc)
  return { material, version, revision, doc, rows }
}

test('题号、跨来源正文、括号小问和思路/答案拆分，保持原文覆盖', () => {
  const f = parse([
    '说明\n习题 1 求 $x^2$。\n(1) 子问题\n解题思路：用幂函数。',
    '标准答案：$2x$\n2. 求位移。\n2.5m 是已知量。\n答案：3m'
  ])
  assert.equal(f.changed, true)
  validateLearningState(f.state, f.rows)
  const questions = f.state.entries.filter((e) => e.type === 'exercise')
  assert.equal(questions.length, 2)
  const texts = f.state.entries.map((e) =>
    entryText(e, new Map(f.rows.map((s) => [s.id, s])))
  )
  assert.ok(texts.some((t) => t.includes('(1) 子问题')))
  assert.ok(texts.some((t) => t.includes('2.5m 是已知量')))
  assert.equal(f.state.entries.filter((e) => e.type === 'solution').length, 3)
  assert.equal(f.state.relations.length, 3)
  assert.equal(
    f.rows[0].raw_text,
    '说明\n习题 1 求 $x^2$。\n(1) 子问题\n解题思路：用幂函数。'
  )
})
test('章题号、中英文与全角编号，汇总答案按唯一题号配对，重复号不猜测', () => {
  for (const marker of [
    '第1题',
    '例题 1',
    'Exercise 1',
    'Problem 1',
    'Question 1',
    '１．'
  ]) {
    assert.equal(
      parse([marker + ' 求和']).state.entries.filter(
        (e) => e.type === 'exercise'
      ).length,
      1
    )
  }
  const f = parse([
    '1-1. 第一题\n1-2. 第二题\n参考答案\n1-2. 第二题答案\n1-1. 第一题答案'
  ])
  assert.equal(f.state.relations.length, 2)
  const ambiguous = parse([
    '1. 第一章问题\n第二章\n1. 第二章问题\n参考答案\n1. 不知道对应哪个章节'
  ])
  assert.equal(ambiguous.state.relations.length, 0)
  assert.match(ambiguous.warnings.join(''), /重复/)
})
test('无题号不把整份材料当一题，已有人工结构与公式保持不动', () => {
  assert.equal(parse(['学习说明\n这是普通的叙述。']).changed, false)
  const rows = sources(['题面 x2']),
    previous = initialLearningState(rows, id)
  previous.entries[0].type = 'exercise'
  previous.entries[0].formulas = [
    { range: [3, 5], latex: 'x^2', display: false }
  ]
  const result = splitExerciseSet(rows, previous, id)
  assert.equal(result.changed, false)
  assert.equal(result.state, previous)
})
test('预览不写习题和新修订；取消、替换与其他窗口不能提交旧预览', async () => {
  const f = fixture(),
    db = getDb(),
    before = db.prepare('SELECT count(*) n FROM exercises').get().n
  const first = await previewExerciseSet(1, f.version)
  assert.equal(first.candidates.length, 2)
  assert.equal(db.prepare('SELECT count(*) n FROM exercises').get().n, before)
  assert.equal(
    getLearningDocument({ version_id: f.version }).revision_id,
    f.revision
  )
  assert.throws(
    () =>
      importExerciseSet(2, {
        token: first.token,
        entry_ids: [first.candidates[0].id]
      }),
    /失效/
  )
  discardExerciseSet(1)
  assert.throws(
    () =>
      importExerciseSet(1, {
        token: first.token,
        entry_ids: [first.candidates[0].id]
      }),
    /失效/
  )
  const second = await previewExerciseSet(1, f.version)
  await previewExerciseSet(1, f.version)
  assert.throws(
    () =>
      importExerciseSet(1, {
        token: second.token,
        entry_ids: [second.candidates[0].id]
      }),
    /失效/
  )
})
test('选择部分导入后可继续导入其余题，保留原件引用与已有用户答案，回收站不复活', async () => {
  const f = fixture(),
    p = await previewExerciseSet(1, f.version)
  const result = importExerciseSet(1, {
    token: p.token,
    entry_ids: [p.candidates[0].id]
  })
  assert.equal(result.added, 1)
  let exercise = getExercise({ id: result.ids[0] })
  const fields = exerciseTexts(exercise.snapshot)
  assert.match(fields.approach, /按定义/)
  assert.match(fields.standard_answer, /1/)
  assert.equal(fields.user_answer, '')
  assert.equal(exercise.snapshot.status, 'unfinished')
  assert.equal(exercise.snapshot.origin.reference.material_id, f.material)
  assert.equal(
    exercise.snapshot.origin.reference.revision_id,
    result.revision_id
  )
  exercise = saveExercise({
    ...exercise.snapshot,
    id: exercise.id,
    expected_revision_id: exercise.current_revision_id,
    fields: { ...fields, user_answer: '我自己的答案' }
  })
  const again = await previewExerciseSet(1, f.version)
  assert.equal(again.candidates[0].existing_id, exercise.id)
  const rest = importExerciseSet(1, {
    token: again.token,
    entry_ids: again.candidates.map((c) => c.id)
  })
  assert.equal(rest.added, 1)
  assert.equal(rest.skipped, 1)
  assert.equal(
    exerciseTexts(getExercise({ id: exercise.id }).snapshot).user_answer,
    '我自己的答案'
  )
  exercise = trashExercise({
    id: exercise.id,
    expected_revision_id: exercise.current_revision_id
  })
  const withTrash = await previewExerciseSet(1, f.version)
  const skipped = importExerciseSet(1, {
    token: withTrash.token,
    entry_ids: [withTrash.candidates[0].id]
  })
  assert.equal(skipped.in_trash, 1)
  assert.equal(skipped.added, 0)
  assert.notEqual(getExercise({ id: exercise.id }).deleted_at, null)
  assert.equal(
    getLearningDocument({ version_id: f.version }).sources[0].raw_text,
    f.rows[0].raw_text
  )
})
test('整批写入与切分修订原子回滚；失败后保留预览以重试', async () => {
  const f = fixture(),
    p = await previewExerciseSet(3, f.version),
    db = getDb()
  db.exec(
    `CREATE TRIGGER fail_exercise_set BEFORE INSERT ON exercises WHEN instr(NEW.source_key,'${p.candidates[1].id}')>0 BEGIN SELECT RAISE(ABORT,'模拟导入失败'); END`
  )
  const before = db.prepare('SELECT count(*) n FROM exercises').get().n
  assert.throws(
    () =>
      importExerciseSet(3, {
        token: p.token,
        entry_ids: p.candidates.map((c) => c.id)
      }),
    /模拟导入失败/
  )
  assert.equal(db.prepare('SELECT count(*) n FROM exercises').get().n, before)
  assert.equal(
    getLearningDocument({ version_id: f.version }).revision_id,
    f.revision
  )
  db.exec('DROP TRIGGER fail_exercise_set')
  assert.equal(
    importExerciseSet(3, {
      token: p.token,
      entry_ids: p.candidates.map((c) => c.id)
    }).added,
    2
  )
})
test('来源更新或删除使旧预览失效；拒绝外来条目、空选择和重复选择', async () => {
  const f = fixture(),
    p = await previewExerciseSet(4, f.version)
  for (const ids of [[], ['foreign'], [p.candidates[0].id, p.candidates[0].id]])
    assert.throws(
      () => importExerciseSet(4, { token: p.token, entry_ids: ids }),
      /不重复/
    )
  const document = getLearningDocument({ version_id: f.version })
  publishLearningRevision(document, document.state)
  assert.throws(
    () =>
      importExerciseSet(4, { token: p.token, entry_ids: [p.candidates[0].id] }),
    /已有更新/
  )
  const next = await previewExerciseSet(4, f.version)
  getDb().prepare('UPDATE materials SET archived=1 WHERE id=?').run(f.material)
  assert.throws(
    () =>
      importExerciseSet(4, {
        token: next.token,
        entry_ids: [next.candidates[0].id]
      }),
    /已删除/
  )
  await assert.rejects(() => previewExerciseSet(4, f.version), /未删除/)
})
test('导入 IPC 校验参数并拒绝磁盘路径与超量选择', async () => {
  assert.equal(
    (await invoke('exerciseSets:preview', { file: 'C:/private.pdf' })).ok,
    false
  )
  assert.equal(
    (
      await invoke('exerciseSets:import', {
        token: 'test',
        entry_ids: Array(501).fill('a')
      })
    ).ok,
    false
  )
  assert.equal(
    (await invoke('exerciseSets:import', { token: 'test', entry_ids: [] })).ok,
    false
  )
})
test('单份大来源一次转换 500 题，超量明确拒绝而不静默漏题', async (t) => {
  const body = Array.from({ length: 500 }, (_, i) => `${i + 1}. ${'题面内容'.repeat(400)}\n答案：结果 ${i + 1}`).join('\n')
  const f = fixture([body]), started = performance.now(), p = await previewExerciseSet(5, f.version)
  assert.equal(p.candidates.length, 500)
  assert.equal(importExerciseSet(5, { token: p.token, entry_ids: p.candidates.map(c => c.id) }).added, 500)
  const first = getDb().prepare('SELECT snapshot_json FROM exercise_revisions WHERE exercise_id=(SELECT id FROM exercises WHERE source_key=?) ORDER BY rowid DESC LIMIT 1').get(JSON.stringify([f.version, getLearningDocument({ version_id: f.version }).revision_id, p.candidates[0].id]))
  assert.ok(first.snapshot_json.length < 30_000, '单题不重复存储整份八十万字符来源')
  const snapshot = JSON.parse(first.snapshot_json), captured = new Map(snapshot.origin.sources.map(s => [s.id, s]))
  assert.equal(entryText(snapshot.origin.entry, captured), snapshot.origin.raw_text)
  assert.equal(JSON.parse(snapshot.origin.sources[0].locator_json).original_source.id, f.rows[0].id)
  t.diagnostic(`500 道题、${body.length} 字符的预览与事务转换耗时 ${Math.round(performance.now() - started)}ms`)
  assert.throws(() => parse([body + '\n501. 多出的一题']), /最多转换 500/)
})
