import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { dataRoot, invoke } from './test-support.mjs'
import { MIGRATIONS } from '../src/main/db/migrations.ts'
import { getDb, closeDb } from '../src/main/services/db.ts'
import {
  saveMemo,
  memoDetail,
  archiveMemo,
  undoMemoRoute
} from '../src/main/services/memos.ts'
import {
  memoAutoState,
  saveMemoAutoSettings,
  enqueueMemoBacklog,
  checkMemoAuto,
  actMemoAuto,
  recoverMemoAuto
} from '../src/main/services/memo-auto.ts'
import {
  recoverMemoRecognition,
  stopMemoRecognition,
  memoRecognitionBusy
} from '../src/main/services/memo-recognition.ts'
import { registerAllIpc } from '../src/main/ipc/index.ts'
import { createTask } from '../src/main/services/projects.ts'
import { saveConcept } from '../src/main/services/concepts.ts'
import { verifyMemoTime } from '../shared/memo-auto.ts'
import { assertIdle } from '../src/main/services/work.ts'

await test('真实 v29→30 失败回滚、原文/灵感/旧归档保留，排除故障后重试', () => {
  let old = new Database(join(dataRoot, 'learning-assistant.db'))
  old.pragma('foreign_keys=ON')
  for (const m of MIGRATIONS.filter((m) => m.version <= 29)) old.exec(m.sql)
  old.pragma('user_version=29')
  old
    .prepare('INSERT INTO subjects VALUES(?,?,?,?,?)')
    .run('s', '学科', '#000', '', 1)
  old
    .prepare('INSERT INTO inspirations VALUES(?,?,?,?,?)')
    .run('i', 's', '原始灵感', '原选区', 1)
  old
    .prepare(
      'INSERT INTO memos(id,revision,content,subject_id,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    )
    .run('old', 'v', '原始备忘', 's', 1, 1)
  old
    .prepare('INSERT INTO memo_versions VALUES(?,?,?,?,?,?)')
    .run('v', 'old', '原始备忘', 's', 1, 'Asia/Shanghai')
  old
    .prepare('INSERT INTO memo_routes VALUES(?,?,?,?,?,?,?)')
    .run('r', 'old', 'v', 'key', '{}', 1, null)
  old.exec('CREATE TABLE memo_auto_jobs(id TEXT)')
  old.close()
  assert.throws(() => getDb(), /already exists/)
  old = new Database(join(dataRoot, 'learning-assistant.db'))
  assert.equal(old.pragma('user_version', { simple: true }), 29)
  assert.equal(
    old
      .prepare("SELECT 1 FROM sqlite_master WHERE name='memo_auto_settings'")
      .get(),
    undefined
  )
  assert.equal(
    old.prepare('SELECT content FROM memos').get().content,
    '原始备忘'
  )
  old.exec('DROP TABLE memo_auto_jobs')
  old.close()
  assert.equal(getDb().pragma('user_version', { simple: true }), MIGRATIONS.at(-1).version)
  assert.equal(memoDetail('old').routes[0].id, 'r')
  assert.equal(
    getDb().prepare('SELECT context_text FROM inspirations').get().context_text,
    '原选区'
  )
})
registerAllIpc()
const ok = (r) => {
  assert.equal(r.ok, true, r.error)
  return r.data
}
const capture = (text) => saveMemo({ content: text, subject_id: 's' })
let mode = 'valid',
  requests = 0,
  lastBody
const makeProposal = (text) => {
  if (text === '牛顿第二定律：F=ma。')
    return {
      kind: 'knowledge',
      knowledge: { name: '牛顿第二定律', summary: 'F=ma', excerpt: text },
      task: null,
      uncertainties: []
    }
  const task = {
    title: text.includes('讨论')
      ? '热力学讨论'
      : text.includes('报告')
        ? '交报告'
        : text,
    detail: '',
    time_text: '',
    start: null,
    end: null,
    due: null,
    location: '',
    excerpt: text
  }
  if (text.includes('2030-11-20')) {
    task.time_text = '2030-11-20 10:00–11:00'
    task.start = '2030-11-20T10:00:00+08:00'
    task.end = '2030-11-20T11:00:00+08:00'
  }
  if (text.includes('周五')) task.time_text = '周五'
  if (text.includes('2030-11-21')) {
    task.time_text = '2030-11-21 14:00'
    task.due = '2030-11-21T14:00:00+08:00'
  }
  const knowledge = text.includes('傅氏变换')
    ? { name: '傅氏变换', summary: '分析频谱', excerpt: '傅氏变换分析频谱。' }
    : null
  if (text === '傅氏变换分析频谱。')
    return { kind: 'knowledge', knowledge, task: null, uncertainties: [] }
  return {
    kind: knowledge ? 'mixed' : 'task',
    knowledge,
    task,
    uncertainties: []
  }
}
const server = createServer(async (req, res) => {
  let body = ''
  for await (const part of req) body += part
  requests++
  lastBody = JSON.parse(body)
  if (mode === 'fail') {
    res.writeHead(503)
    res.end(JSON.stringify({ error: { message: 'auto-secret offline' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.flushHeaders()
  if (mode === 'hold') {
    res.write('data: {"choices":[{"index":0,"delta":{"content":"{"}}]}\n\n')
    return
  }
  const p = makeProposal(JSON.parse(lastBody.messages[1].content).text)
  if (mode === 'uncertain') p.uncertainties = ['请确认']
  if (mode === 'badtime') {
    p.task.time_text = '周五'
    p.task.due = '2030-11-22T14:00:00+08:00'
  }
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: JSON.stringify(p) } }]
      }) +
      '\n\ndata: [DONE]\n\n'
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const provider = ok(
  await invoke('providers:save', {
    name: '自动备忘模拟',
    base_url: `http://127.0.0.1:${server.address().port}/v1`,
    api_format: 'openai',
    api_key: 'auto-secret',
    enabled: true
  })
)
const model = ok(
  await invoke('models:save', {
    provider_id: provider.id,
    model_id: 'auto-fixture'
  })
)
const configure = (patch = {}) => {
  const { since, ...old } = memoAutoState().settings
  return saveMemoAutoSettings({
    ...old,
    enabled: true,
    model_db_id: model.id,
    subject_ids: ['s'],
    ...patch
  })
}
const wait = async (fn) => {
  const end = Date.now() + 9000
  while (!fn()) {
    if (Date.now() > end) throw Error('wait timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const job = (d) =>
  memoDetail(d.memo.id).automation.find((j) => j.revision === d.memo.revision)
const settle = async (d, now = Date.now()) => {
  checkMemoAuto(now)
  await wait(() => !memoRecognitionBusy())
  checkMemoAuto(now)
  return job(d)
}
test('默认不发送；明确模型/学科/种类；新条目自动排队，已有原文需显式补处理', async () => {
  assert.equal(memoAutoState().settings.enabled, false)
  const old = capture('此前的原文')
  checkMemoAuto()
  assert.equal(requests, 0)
  assert.equal(job(old), undefined)
  assert.throws(() => configure({ subject_ids: [] }), /学科/)
  assert.throws(() => configure({ knowledge: false, tasks: false }), /种类/)
  const realNow = Date.now
  Date.now = () => old.memo.created_at
  let saved
  try {
    saved = configure()
  } finally {
    Date.now = realNow
  }
  assert.throws(
    () => saveMemoAutoSettings({ ...saved.settings, revision: 'wrong' }),
    /变化/
  )
  // Exactly the same clock value: opt-in uses a version watermark, not timestamp ordering.
  checkMemoAuto()
  assert.equal(job(old), undefined)
  assert.equal(enqueueMemoBacklog(), 1)
  assert.equal(enqueueMemoBacklog(), 0)
  assert.equal((await settle(old)).status, 'routed')
  assert.equal(JSON.parse(lastBody.messages[1].content).text, '此前的原文')
  assert.equal(JSON.stringify(lastBody).includes('原始灵感'), false)
  Date.now = () => old.memo.created_at - 10000
  let rolled
  try {
    rolled = capture('系统时钟回拨后保存')
  } finally {
    Date.now = realNow
  }
  assert.equal((await settle(rolled)).status, 'routed')
  assertIdle()
})
test('知识、纯待办、混合自动归档，别名复用且不覆盖；固定回链、撤销后不重建', async () => {
  const c = saveConcept({
    subject_id: 's',
    name: '傅里叶变换',
    aliases: ['傅氏变换'],
    summary: '保留人工总结'
  })
  for (const text of [
    '傅氏变换分析频谱。',
    '牛顿第二定律：F=ma。',
    '整理实验器材',
    '傅氏变换分析频谱。记得检查频谱'
  ]) {
    const d = capture(text),
      j = await settle(d)
    assert.equal(j.status, 'routed', j.reason)
    assert.equal(JSON.parse(j.policy_json).model_db_id, model.id)
    const a = memoDetail(d.memo.id)
    assert.equal(a.routes.length, 1)
    assert.equal(
      a.routes[0].targets.length,
      text === '傅氏变换分析频谱。记得检查频谱' ? 2 : 1
    )
    if (text.includes('傅氏'))
      assert.equal(
        a.routes[0].targets.find((t) => t.kind === 'concept').target_id,
        c.id
      )
    if (text.includes('牛顿')) {
      const target = a.routes[0].targets[0]
      assert.equal(target.created, true)
      assert.equal(
        getDb()
          .prepare('SELECT subject_id FROM knowledge_points WHERE id=?')
          .get(target.target_id).subject_id,
        's'
      )
    }
    checkMemoAuto()
    assert.equal(memoDetail(d.memo.id).routes.length, 1)
    undoMemoRoute(a.routes[0].id)
    checkMemoAuto()
    assert.equal(memoDetail(d.memo.id).routes.length, 1)
    assert.throws(
      () => actMemoAuto({ id: j.id, action: 'retry' }),
      /归档或撤销/
    )
  }
  assert.equal(
    getDb().prepare('SELECT summary FROM knowledge_points WHERE id=?').get(c.id)
      .summary,
    '保留人工总结'
  )
})
test('模型自称确定也拒绝含糊日期、冲突、重复待办及未获准混合条目', async () => {
  mode = 'badtime'
  const ambiguous = capture('周五交报告'),
    aj = await settle(ambiguous)
  assert.equal(aj.status, 'review')
  assert.match(aj.reason, /日期不明确/)
  assert.equal(memoDetail(ambiguous.memo.id).routes.length, 0)
  mode = 'valid'
  createTask({
    title: '固定课程',
    kind: 'manual',
    planned_at: Date.parse('2030-11-20T10:30:00+08:00'),
    planned_end_at: Date.parse('2030-11-20T11:30:00+08:00')
  })
  const conflict = capture('2030-11-20 10:00–11:00 热力学讨论'),
    cj = await settle(conflict)
  assert.equal(cj.status, 'review')
  assert.match(cj.reason, /冲突/)
  const first = capture('核对实验设备')
  assert.equal((await settle(first)).status, 'routed')
  const duplicate = capture('核对实验设备')
  assert.match((await settle(duplicate)).reason, /重复/)
  configure({ knowledge: false })
  const mixed = capture('傅氏变换分析频谱。检查混合测试')
  assert.match((await settle(mixed)).reason, /未获准/)
  configure({ knowledge: true })
})
test('断网重试退避、三次上限、持久化与重新打开补处理，失败不泄密或丢原文', async () => {
  mode = 'fail'
  const d = capture('断网捕获的待办')
  let j = await settle(d)
  assert.equal(j.status, 'pending')
  assert.equal(j.attempts, 1)
  assert.equal(j.reason.includes('auto-secret'), false)
  const before = requests
  checkMemoAuto(j.next_at - 1)
  assert.equal(requests, before)
  closeDb()
  getDb()
  recoverMemoRecognition()
  recoverMemoAuto()
  mode = 'valid'
  j = await settle(d, j.next_at)
  assert.equal(j.status, 'routed')
  assert.equal(j.attempts, 2)
  assert.equal(memoDetail(d.memo.id).routes.length, 1)
  mode = 'fail'
  const exhaust = capture('持续离线捕获')
  let ej = await settle(exhaust)
  ej = await settle(exhaust, ej.next_at)
  ej = await settle(exhaust, ej.next_at)
  assert.equal(ej.status, 'review')
  assert.equal(ej.attempts, 3)
  assert.equal(memoDetail(exhaust.memo.id).memo.content, '持续离线捕获')
  mode = 'valid'
  actMemoAuto({ id: ej.id, action: 'retry' })
  assert.equal((await settle(exhaust)).status, 'routed')
})
test('处理中编辑/回收/取消/改规则阻止旧决定；重启补处理中断且不重复', async () => {
  for (const action of ['edit', 'archive', 'cancel', 'settings', 'restart']) {
    mode = 'hold'
    const d = capture('处理中 ' + action)
    checkMemoAuto()
    await wait(() => memoRecognitionBusy())
    const j = job(d)
    assert.equal(j.status, 'running')
    assert.throws(() => assertIdle(), /备忘识别/)
    if (action === 'edit')
      saveMemo({
        id: d.memo.id,
        expected_revision: d.memo.revision,
        subject_id: 's',
        content: '修改后的原文'
      })
    if (action === 'archive')
      archiveMemo({
        id: d.memo.id,
        expected_revision: d.memo.revision,
        archived: true
      })
    if (action === 'cancel') actMemoAuto({ id: j.id, action: 'cancel' })
    if (action === 'settings') configure({ enabled: false })
    if (action === 'restart') {
      stopMemoRecognition()
      await wait(() => !memoRecognitionBusy())
      closeDb()
      getDb()
      recoverMemoRecognition()
      recoverMemoAuto()
    }
    mode = 'valid'
    checkMemoAuto()
    await wait(() => !memoRecognitionBusy())
    if (action === 'restart') {
      checkMemoAuto()
      assert.equal(job(d).status, 'routed')
      assert.equal(memoDetail(d.memo.id).routes.length, 1)
    } else {
      assert.equal(job(d).status, 'cancelled')
      assert.equal(memoDetail(d.memo.id).routes.length, 0)
    }
    if (action === 'settings') configure()
    // Finish the newly edited revision before starting the next held fixture.
    checkMemoAuto()
    await wait(() => !memoRecognitionBusy())
    checkMemoAuto()
  }
  assertIdle()
})
test('归档事务故障不会留下半份知识/任务/来源，重试一次且回收/范围外不发送', async () => {
  const d = capture('事务回滚测试')
  getDb().exec(
    "CREATE TRIGGER memo_auto_fault BEFORE UPDATE OF status ON memo_auto_jobs WHEN NEW.status='routed' BEGIN SELECT RAISE(ABORT,'故障注入'); END"
  )
  let j = await settle(d)
  assert.equal(j.status, 'review')
  assert.match(j.reason, /故障注入/)
  assert.equal(memoDetail(d.memo.id).routes.length, 0)
  assert.equal(
    getDb().prepare('SELECT id FROM tasks WHERE title=?').get('事务回滚测试'),
    undefined
  )
  getDb().exec('DROP TRIGGER memo_auto_fault')
  actMemoAuto({ id: j.id, action: 'retry' })
  j = await settle(d)
  assert.equal(j.status, 'routed')
  assert.equal(memoDetail(d.memo.id).routes.length, 1)
  const foreign = saveMemo({ content: '未分类私密备忘', subject_id: null }),
    trashed = capture('回收站原文')
  archiveMemo({
    id: trashed.memo.id,
    expected_revision: trashed.memo.revision,
    archived: true
  })
  checkMemoAuto()
  assert.equal(job(foreign), undefined)
  assert.equal(job(trashed), undefined)
  for (const [channel, input] of [
    ['memo-auto:save', { ...memoAutoState().settings, extra: 1 }],
    ['memo-auto:action', { id: j.id, action: 'delete' }]
  ])
    assert.equal((await invoke(channel, input)).ok, false)
})
test('供应商变化使已完成的旧候选失效；明确截止自动进入待办', async () => {
  const d = capture('供应商改变前的待办')
  checkMemoAuto()
  await wait(() => !memoRecognitionBusy())
  ok(
    await invoke('providers:save', {
      id: provider.id,
      name: '更改后的供应商',
      base_url: provider.base_url,
      api_format: 'openai',
      enabled: true
    })
  )
  checkMemoAuto()
  assert.equal(job(d).status, 'review')
  assert.match(job(d).reason, /配置已变化/)
  assert.equal(memoDetail(d.memo.id).routes.length, 0)
  actMemoAuto({ id: job(d).id, action: 'retry' })
  assert.equal((await settle(d)).status, 'routed')
  const dated = capture('2030-11-21 14:00交报告'),
    dj = await settle(dated)
  assert.equal(dj.status, 'routed', dj.reason)
  const target = memoDetail(dated.memo.id).routes[0].targets[0].target_id
  assert.equal(
    getDb().prepare('SELECT due_at FROM tasks WHERE id=?').get(target).due_at,
    Date.parse('2030-11-21T14:00:00+08:00')
  )
})
test('编辑已归档备忘不自动重复建任务或改期，旧任务和固定来源保留', async () => {
  const d = capture('已归档的实验待办')
  assert.equal((await settle(d)).status, 'routed')
  const original = memoDetail(d.memo.id).routes[0],
    task = original.targets[0].target_id
  const edited = saveMemo({
    id: d.memo.id,
    expected_revision: d.memo.revision,
    subject_id: 's',
    content: '修改要求后的实验待办'
  })
  const j = await settle(edited)
  assert.equal(j.status, 'review')
  assert.match(j.reason, /旧修订已生成待办/)
  assert.equal(memoDetail(d.memo.id).routes.length, 1)
  assert.equal(memoDetail(d.memo.id).routes[0].revision, d.memo.revision)
  assert.equal(
    getDb().prepare('SELECT title FROM tasks WHERE id=?').get(task).title,
    '已归档的实验待办'
  )
  assert.equal(
    getDb()
      .prepare('SELECT id FROM tasks WHERE title=?')
      .get('修改要求后的实验待办'),
    undefined
  )
})
test('旧密钥加密升级不误判为用户更改配置，后台识别仍能归档', async () => {
  getDb()
    .prepare('UPDATE providers SET api_key_encrypted=? WHERE id=?')
    .run(Buffer.from('plain:auto-secret'), provider.id)
  const d = capture('旧密钥升级后的待办'),
    j = await settle(d)
  assert.equal(j.status, 'routed', j.reason)
  assert.equal(
    getDb()
      .prepare('SELECT api_key_encrypted FROM providers WHERE id=?')
      .get(provider.id)
      .api_key_encrypted.toString()
      .startsWith('plain:'),
    false
  )
})
test('中文明确日期与相对日期按原修订时区核对，拒绝缺钟点、猜测、DST歧义和多任务钟点', () => {
  const source = {
    id: 'v',
    subject_id: 's',
    created_at: Date.parse('2030-11-14T23:00:00+08:00'),
    timezone: 'Asia/Shanghai'
  }
  const task = (due, start = null, end = null) => ({
    title: '报告',
    detail: '',
    time_text: '时间',
    start,
    end,
    due,
    location: '',
    excerpt: '报告'
  })
  for (const [content, due] of [
    ['2030年11月20日14点交报告', '2030-11-20T14:00:00+08:00'],
    ['明天上午9点30分交报告', '2030-11-15T09:30:00+08:00'],
    ['后天下午2点交报告', '2030-11-16T14:00:00+08:00'],
    ['本周五10:00交报告', '2030-11-15T10:00:00+08:00'],
    ['下周一10:00交报告', '2030-11-18T10:00:00+08:00']
  ])
    assert.doesNotThrow(
      () => verifyMemoTime({ ...source, content }, task(due)),
      content
    )
  assert.doesNotThrow(() =>
    verifyMemoTime(
      { ...source, content: '明天10:00–11:00讨论' },
      task(null, '2030-11-15T10:00:00+08:00', '2030-11-15T11:00:00+08:00')
    )
  )
  assert.doesNotThrow(() =>
    verifyMemoTime(
      { ...source, content: '整理器材' },
      { ...task(null), time_text: '' }
    )
  )
  // Even a model omitting all time fields must not turn an ambiguous deadline into an undated task.
  for (const content of [
    '三天后交报告',
    '过几天交报告',
    '明早交报告',
    '饭后讨论',
    '11/20交报告',
    'in two weeks submit report'
  ])
    assert.throws(
      () =>
        verifyMemoTime(
          { ...source, content },
          { ...task(null), time_text: '' }
        ),
      content
    )
  for (const content of [
    '周五交报告',
    '明天交报告',
    '下次课前交报告',
    '明天9点半交报告',
    '明天9点以后交报告',
    '每周五9点交报告',
    '明天10:00讨论，11:00交报告',
    '2030-02-30 10:00交报告'
  ])
    assert.throws(
      () =>
        verifyMemoTime(
          { ...source, content },
          task('2030-11-15T09:00:00+08:00')
        ),
      content
    )
  assert.throws(
    () =>
      verifyMemoTime(
        { ...source, content: '明天9点交报告' },
        task('2030-11-15T10:00:00+08:00')
      ),
    /不一致/
  )
  assert.throws(
    () =>
      verifyMemoTime(
        { ...source, timezone: 'unknown', content: '明天9点交报告' },
        task(null)
      ),
    /时区/
  )
  assert.throws(() =>
    verifyMemoTime(
      {
        ...source,
        timezone: 'America/New_York',
        content: '2030-11-03 01:30交报告'
      },
      task('2030-11-03T01:30:00-04:00')
    )
  )
})
after(async () => {
  stopMemoRecognition()
  await wait(() => !memoRecognitionBusy())
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  closeDb()
})
