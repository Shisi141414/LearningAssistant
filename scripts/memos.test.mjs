import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import {
  saveMemo,
  memoDetail,
  listMemos,
  archiveMemo,
  importInspiration,
  previewMemoRoute,
  applyMemoRoute,
  undoMemoRoute,
  memoReferences
} from '../src/main/services/memos.ts'
import { saveConcept, listConcepts } from '../src/main/services/concepts.ts'
import { createTask, updateTask } from '../src/main/services/projects.ts'
import {
  memoPrompt,
  parseMemoProposal,
  memoTimestamp
} from '../shared/memo-recognition.ts'
import {
  recognizeMemo,
  recoverMemoRecognition,
  stopMemoRecognition,
  cancelMemoRecognition
} from '../src/main/services/memo-recognition.ts'
import { assertIdle } from '../src/main/services/work.ts'

await test('真实 v28 升级失败保持旧库、版本与灵感；排除故障重试 v29 成功', () => {
  let old = new Database(join(dataRoot, 'learning-assistant.db'))
  old.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 28)) old.exec(m.sql)
  old.pragma('user_version=28')
  old
    .prepare('INSERT INTO subjects VALUES(?,?,?,?,?)')
    .run('old-subject', '旧学科', '#000', '', 1)
  old
    .prepare('INSERT INTO inspirations VALUES(?,?,?,?,?)')
    .run('old-inspiration', 'old-subject', '旧灵感原文', '原始选区', 1)
  old.exec('CREATE TABLE memo_versions(id TEXT);')
  old.close()
  assert.throws(() => getDb(), /already exists/)
  old = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(old.pragma('user_version', { simple: true }), 28)
  assert.equal(
    old.prepare("SELECT 1 FROM sqlite_master WHERE name='memos'").get(),
    undefined
  )
  assert.equal(
    old.prepare('SELECT content FROM inspirations').get().content,
    '旧灵感原文'
  )
  old.exec('DROP TABLE memo_versions')
  old.close()
  assert.equal(getDb().pragma('user_version', { simple: true }), 29)
  assert.equal(
    getDb().prepare('SELECT context_text FROM inspirations').get().context_text,
    '原始选区'
  )
})
registerAllIpc()
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
const subject = 'old-subject'
const capture = (content = '傅里叶变换检查频谱，周五交实验报告。') =>
  saveMemo({ content, subject_id: subject })
const plan = (d, extra = {}) => ({
  id: d.memo.id,
  expected_revision: d.memo.revision,
  knowledge: null,
  task: {
    title: '提交实验报告',
    detail: '检查频谱',
    due_at: null,
    planned_at: null,
    planned_end_at: null,
    location: ''
  },
  ...extra
})
const apply = (p) =>
  applyMemoRoute({
    plan: p,
    fingerprint: previewMemoRoute(p).fingerprint,
    ignore_conflicts: false
  })

test('离线保存原文、修订、回收恢复、搜索分页和灵感幂等转入，原记录不动', () => {
  const d = capture(),
    edit = saveMemo({
      id: d.memo.id,
      expected_revision: d.memo.revision,
      content: d.memo.content + ' 手工补充',
      subject_id: subject
    })
  assert.equal(edit.versions.length, 2)
  assert.equal(
    edit.versions.find((v) => v.id === d.memo.revision).content,
    d.memo.content
  )
  assert.throws(
    () =>
      saveMemo({
        id: d.memo.id,
        expected_revision: d.memo.revision,
        content: '陈旧',
        subject_id: subject
      }),
    /已变化/
  )
  assert.ok(
    edit.versions.every((v) => v.timezone && Number.isSafeInteger(v.created_at))
  )
  const a = archiveMemo({
    id: d.memo.id,
    expected_revision: edit.memo.revision,
    archived: true
  })
  assert.equal(a.memo.archived, true)
  assert.throws(() => previewMemoRoute(plan(a)), /恢复/)
  assert.ok(
    listMemos({ query: '手工补充', archived: true, offset: 0 }).items.some(
      (m) => m.id === d.memo.id
    )
  )
  archiveMemo({
    id: d.memo.id,
    expected_revision: edit.memo.revision,
    archived: false
  })
  const one = importInspiration('old-inspiration'),
    two = importInspiration('old-inspiration')
  assert.equal(one.memo.id, two.memo.id)
  assert.equal(one.memo.inspiration_id, 'old-inspiration')
  assert.equal(one.memo.created_at, 1)
  assert.equal(one.versions[0].created_at, 1)
  assert.equal(one.versions[0].timezone, 'unknown')
  assert.equal(
    getDb()
      .prepare('SELECT context_text FROM inspirations WHERE id=?')
      .get('old-inspiration').context_text,
    '原始选区'
  )
  assert.throws(() => saveMemo({ content: ' ', subject_id: subject }), /字符/)
  for (let i = 0; i < 51; i++) capture(`分页独立 ${i}`)
  const page = listMemos({ query: '分页独立', archived: false, offset: 0 })
  assert.equal(page.items.length, 50)
  assert.equal(page.next_offset, 50)
  assert.equal(
    listMemos({ query: '分页独立', archived: false, offset: 50 }).items.length,
    1
  )
})
test('混合归档复用别名知识而不覆盖，待办关联知识、双向来源与相同请求去重', () => {
  const c = saveConcept({
      name: '傅里叶变换',
      summary: '人工核对条件',
      aliases: ['傅氏变换'],
      subject_id: subject
    }),
    d = capture()
  const p = plan(d, {
    knowledge: {
      kind: 'new',
      name: '傅氏变换',
      summary: '不能覆盖人工内容',
      subject_id: subject
    }
  })
  const preview = previewMemoRoute(p)
  assert.equal(preview.existing_concept_id, c.id)
  assert.equal(memoDetail(d.memo.id).routes.length, 0)
  const first = apply(p),
    second = apply(p),
    route = first.routes[0]
  assert.equal(second.routes.length, 1)
  const task = getDb()
    .prepare('SELECT * FROM tasks WHERE id=?')
    .get(route.targets.find((t) => t.kind === 'task').target_id)
  assert.equal(JSON.parse(task.knowledge_refs_json)[0].concept_id, c.id)
  assert.equal(
    listConcepts().find((x) => x.id === c.id).summary,
    '人工核对条件'
  )
  assert.equal(
    memoReferences({ kind: 'concept', id: c.id }).filter(
      (x) => x.memo_id === d.memo.id
    ).length,
    1
  )
  assert.equal(
    memoReferences({ kind: 'task', id: task.id })[0].revision,
    d.memo.revision
  )
  const changed = saveMemo({
    id: d.memo.id,
    expected_revision: d.memo.revision,
    content: '后来改写',
    subject_id: subject
  })
  assert.equal(changed.routes[0].revision, d.memo.revision)
  assert.equal(
    memoReferences({ kind: 'task', id: task.id })[0].content,
    d.memo.content
  )
})
test('半开时间冲突检查与明确忽略，日程变动使旧确认失效且不产生半份知识', () => {
  const start = Date.now() + 86400000,
    end = start + 3600000
  const existing = createTask({
      title: '固定课程',
      planned_at: start,
      planned_end_at: end
    }),
    d = capture()
  const p = plan(d, {
    knowledge: {
      kind: 'new',
      name: '冲突用独立知识',
      summary: '',
      subject_id: subject
    },
    task: {
      title: '实验',
      detail: '',
      due_at: null,
      planned_at: start,
      planned_end_at: end,
      location: '实验室'
    }
  })
  const preview = previewMemoRoute(p),
    before = memoDetail(d.memo.id)
  assert.equal(preview.conflicts.items.length, 1)
  assert.throws(() => apply(p), /时间冲突/)
  assert.deepEqual(memoDetail(d.memo.id), before)
  updateTask(existing.id, { title: '课程改名' })
  assert.throws(
    () =>
      applyMemoRoute({
        plan: p,
        fingerprint: preview.fingerprint,
        ignore_conflicts: true
      }),
    /已变化/
  )
  const fresh = previewMemoRoute(p)
  const moved = applyMemoRoute({
    plan: p,
    fingerprint: fresh.fingerprint,
    ignore_conflicts: true
  })
  assert.equal(moved.routes[0].targets.length, 2)
  const edge = plan(capture(), {
    task: { ...p.task, planned_at: end, planned_end_at: end + 3600000 }
  })
  assert.equal(previewMemoRoute(edge).conflicts.items.length, 0)
})
test('知识与待办/记录写入失败完整回滚，重试一次，撤销保留共享知识', () => {
  const d = capture(),
    p = plan(d, {
      knowledge: {
        kind: 'new',
        name: '事务用独立知识',
        summary: '保留共享知识',
        subject_id: subject
      }
    })
  const db = getDb(),
    before = db.prepare('SELECT count(*) n FROM tasks').get().n
  db.exec(
    "CREATE TRIGGER memo_fault BEFORE INSERT ON memo_targets WHEN NEW.kind='task' BEGIN SELECT RAISE(ABORT,'injected-memo-fault'); END"
  )
  assert.throws(() => apply(p), /injected/)
  assert.equal(memoDetail(d.memo.id).routes.length, 0)
  assert.equal(
    listConcepts().some((c) => c.name === '事务用独立知识'),
    false
  )
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, before)
  db.exec('DROP TRIGGER memo_fault')
  const first = apply(p),
    r = first.routes[0],
    concept = r.targets.find((t) => t.kind === 'concept').target_id,
    task = r.targets.find((t) => t.kind === 'task').target_id
  const undone = undoMemoRoute(r.id)
  assert.ok(undone.routes[0].undone_at)
  assert.equal(
    db.prepare('SELECT 1 FROM tasks WHERE id=?').get(task),
    undefined
  )
  assert.ok(listConcepts().some((c) => c.id === concept))
  assert.equal(memoReferences({ kind: 'concept', id: concept }).length, 0)
  assert.equal(
    undoMemoRoute(r.id).routes[0].undone_at,
    undone.routes[0].undone_at
  )
  assert.equal(apply(p).routes.length, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, before)
})
test('撤销拒绝删除用户修改或已排程待办，外部删除目标保留归档标题与旧原文', () => {
  const d = capture(),
    result = apply(plan(d)),
    route = result.routes[0],
    target = route.targets[0].target_id
  updateTask(target, { title: '用户改过的标题' })
  assert.throws(() => undoMemoRoute(route.id), /已被编辑/)
  getDb().prepare('DELETE FROM tasks WHERE id=?').run(target)
  const missing = memoDetail(d.memo.id)
  assert.equal(missing.routes[0].targets[0].target_id, null)
  assert.equal(missing.routes[0].targets[0].title, '提交实验报告')
  assert.equal(missing.versions[0].content, d.memo.content)
  const p = apply(plan(capture())),
    t = p.routes[0].targets[0].target_id
  getDb().prepare('INSERT INTO task_planning VALUES(?,?,?)').run(t, 'r', '{}')
  assert.throws(() => undoMemoRoute(p.routes[0].id), /排程或关联/)
})
test('IPC 拒绝额外字段、坏日期、陈旧知识/原文与含糊跨学科同名，历史原文保留', async () => {
  const d = capture(),
    p = plan(d)
  assert.equal(
    (
      await invoke('memos:save', {
        content: 'abc',
        subject_id: null,
        revision: '伪造'
      })
    ).ok,
    false
  )
  assert.equal(
    (await invoke('memos:preview', { ...p, task: { ...p.task, due_at: NaN } }))
      .ok,
    false
  )
  assert.throws(
    () =>
      previewMemoRoute({
        ...p,
        task: { ...p.task, planned_at: 10, planned_end_at: null }
      }),
    /起止/
  )
  const c = saveConcept({
    name: '同名歧义',
    summary: '',
    subject_id: subject,
    aliases: []
  })
  saveConcept({
    name: '同名歧义',
    summary: '不同含义',
    subject_id: null,
    aliases: []
  })
  assert.throws(
    () =>
      previewMemoRoute({
        ...p,
        knowledge: {
          kind: 'new',
          name: '同名歧义',
          summary: '',
          subject_id: subject
        }
      }),
    /多个/
  )
  assert.throws(
    () =>
      previewMemoRoute({
        ...p,
        knowledge: { kind: 'existing', id: c.id, revision: 999 }
      }),
    /知识点已变化/
  )
  const before = previewMemoRoute(p)
  saveMemo({
    id: d.memo.id,
    expected_revision: d.memo.revision,
    content: '新修订',
    subject_id: subject
  })
  assert.throws(
    () =>
      applyMemoRoute({
        plan: p,
        fingerprint: before.fingerprint,
        ignore_conflicts: false
      }),
    /备忘已变化/
  )
})

const source = '傅里叶变换用来分析频谱。周五交报告。',
  proposal = () => ({
    kind: 'mixed',
    knowledge: {
      name: '傅里叶变换',
      summary: '分析频谱',
      excerpt: '傅里叶变换用来分析频谱。'
    },
    task: {
      title: '交报告',
      detail: '',
      time_text: '周五',
      start: null,
      end: null,
      due: null,
      location: '',
      excerpt: '周五交报告。'
    },
    uncertainties: ['周五没有明确钟点，请补全']
  })
test('识别契约拒绝幻觉名称/摘录、额外字段、非法日期；时间和时区从保存修订取材', () => {
  assert.equal(
    parseMemoProposal(JSON.stringify(proposal()), source).task.due,
    null
  )
  assert.equal(
    memoTimestamp('2026-11-20T14:00:00+08:00'),
    Date.parse('2026-11-20T06:00:00Z')
  )
  assert.throws(() => memoTimestamp('2026-02-30T14:00:00+08:00'))
  assert.throws(() => memoTimestamp('2026-11-20T14:00:00'))
  for (const mutate of [
    (v) => (v.extra = 1),
    (v) => (v.knowledge.name = '编造'),
    (v) => (v.task.excerpt = '伪造'),
    (v) => (v.task.due = '2026-02-30T14:00:00+08:00'),
    (v) => (v.kind = 'task')
  ]) {
    const v = proposal()
    mutate(v)
    assert.throws(() => parseMemoProposal(JSON.stringify(v), source))
  }
  const d = capture(source),
    v = d.versions[0],
    user = JSON.parse(memoPrompt(v)[1].content)
  assert.deepEqual(user, {
    text: source,
    revision_created_at: new Date(v.created_at).toISOString(),
    timezone: v.timezone
  })
})
let requests = 0,
  mode = 'valid',
  lastBody
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  requests++
  lastBody = JSON.parse(body)
  if (mode === 'fail') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'memo-test-secret denied' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.flushHeaders()
  const value = proposal()
  if (mode === 'dated') value.task.due = '2030-11-22T14:00:00+08:00'
  if (mode === 'bad') value.knowledge.excerpt = '编造的原文'
  res.write(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { content: mode === 'hold' ? '{' : JSON.stringify(value) }
          }
        ]
      }) +
      '\n\n'
  )
  if (mode !== 'hold') res.end('data: [DONE]\n\n')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const provider = ok(
  await invoke('providers:save', {
    name: '备忘模拟供应商',
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    api_format: 'openai',
    api_key: 'memo-test-secret',
    enabled: true
  })
)
const model = ok(
  await invoke('models:save', {
    provider_id: provider.id,
    model_id: 'memo-fixture'
  })
)
const wait = async (fn) => {
  const until = Date.now() + 8000
  while (!fn()) {
    if (Date.now() > until) throw Error('wait timeout')
    await new Promise((r) => setTimeout(r, 15))
  }
}
test('真实 LLM 网关异步识别不归档、仅发送此修订；失败重试和取消不泄密、不重复建任务', async () => {
  const d = capture(source),
    start = () =>
      recognizeMemo({
        id: d.memo.id,
        expected_revision: d.memo.revision,
        model_db_id: model.id
      }),
    before = getDb().prepare('SELECT count(*) n FROM tasks').get().n
  mode = 'valid'
  start()
  await wait(() => memoDetail(d.memo.id).recognitions[0].status === 'ready')
  const ready = memoDetail(d.memo.id)
  assert.equal(ready.recognitions[0].proposal.kind, 'mixed')
  assert.equal(ready.routes.length, 0)
  assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, before)
  assert.equal(JSON.parse(lastBody.messages[1].content).text, source)
  assert.equal(JSON.stringify(lastBody).includes('人工核对条件'), false)
  const legacy = ok(
      await invoke('inspirations:add', { content: source, subject_id: subject })
    ),
    copied = importInspiration(legacy.id)
  mode = 'dated'
  recognizeMemo({
    id: copied.memo.id,
    expected_revision: copied.memo.revision,
    model_db_id: model.id
  })
  await wait(
    () => memoDetail(copied.memo.id).recognitions[0].status === 'ready'
  )
  const historical = memoDetail(copied.memo.id).recognitions[0].proposal
  assert.equal(historical.task.due, null)
  assert.match(historical.uncertainties[0], /时区/)
  assert.equal(JSON.parse(lastBody.messages[1].content).timezone, 'unknown')
  mode = 'bad'
  start()
  await wait(() => memoDetail(d.memo.id).recognitions[0].status === 'failed')
  mode = 'fail'
  start()
  await wait(() => memoDetail(d.memo.id).recognitions[0].status === 'failed')
  assert.equal(
    JSON.stringify(memoDetail(d.memo.id)).includes('memo-test-secret'),
    false
  )
  mode = 'hold'
  const job = start().recognitions[0]
  await wait(() => requests >= 5)
  assert.throws(assertIdle, /备忘/)
  assert.throws(start, /已有/)
  cancelMemoRecognition(job.id)
  await wait(() => memoDetail(d.memo.id).recognitions[0].status === 'cancelled')
  await new Promise((r) => setTimeout(r, 50))
  assert.doesNotThrow(assertIdle)
  getDb()
    .prepare("UPDATE memo_recognitions SET status='running' WHERE id=?")
    .run(job.id)
  const count = requests
  recoverMemoRecognition()
  assert.equal(requests, count)
  assert.equal(memoDetail(d.memo.id).recognitions[0].status, 'cancelled')
  assert.equal(getDb().prepare('SELECT count(*) n FROM tasks').get().n, before)
})
after(async () => {
  stopMemoRecognition()
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  closeDb()
})
