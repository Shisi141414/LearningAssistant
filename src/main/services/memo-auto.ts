import { nanoid } from 'nanoid'
import type {
  MemoAutoJob,
  MemoAutoSettings,
  MemoAutoState,
  MemoRoutePlan
} from '@shared/memos'
import { memoTimestamp } from '@shared/memo-recognition'
import { verifyMemoTime } from '@shared/memo-auto'
import { getDb } from './db'
import { applyMemoRoute, memoDetail, previewMemoRoute, memoHash } from './memos'
import {
  cancelMemoRecognition,
  memoRecognitionBusy,
  recognizeMemo
} from './memo-recognition'
import { pickModel } from '../ipc/chat.ipc'

const defaults = (): MemoAutoSettings => ({
  revision: 'initial',
  enabled: false,
  model_db_id: null,
  subject_ids: [],
  include_unassigned: false,
  knowledge: true,
  tasks: true,
  since: 0
})
function modelStamp(id: string | null): string {
  if (!id) throw new Error('自动整理模型不存在')
  const model = pickModel(id)
  // Hash only in main; no credential or provider snapshot is sent to the renderer.
  return memoHash([
    model,
    getDb()
      .prepare(
        'SELECT id,name,base_url,api_format,enabled,api_key_encrypted FROM providers WHERE id=?'
      )
      .get(model.provider_id)
  ])
}
export function memoAutoSettings(): MemoAutoSettings {
  const row = getDb()
    .prepare('SELECT revision,value_json FROM memo_auto_settings WHERE id=1')
    .get() as { revision: string; value_json: string } | undefined
  return row
    ? { ...JSON.parse(row.value_json), revision: row.revision }
    : defaults()
}
export function memoAutoState(): MemoAutoState {
  return {
    settings: memoAutoSettings(),
    jobs: getDb()
      .prepare(
        'SELECT j.*,substr(v.content,1,100) AS excerpt FROM memo_auto_jobs j JOIN memo_versions v ON v.id=j.revision ORDER BY j.updated_at DESC,j.id LIMIT 50'
      )
      .all() as MemoAutoJob[]
  }
}
function finish(
  job: MemoAutoJob,
  status: MemoAutoJob['status'],
  reason: string
): void {
  getDb()
    .prepare(
      'UPDATE memo_auto_jobs SET status=?,reason=?,updated_at=? WHERE id=?'
    )
    .run(status, reason.slice(0, 1500), Date.now(), job.id)
}
function cancel(job: MemoAutoJob, reason: string): void {
  if (job.status === 'running' && job.recognition_id)
    cancelMemoRecognition(job.recognition_id)
  finish(job, 'cancelled', reason)
}
function jobs(): MemoAutoJob[] {
  return getDb()
    .prepare(
      "SELECT * FROM memo_auto_jobs WHERE status IN ('pending','running') ORDER BY created_at,id"
    )
    .all() as MemoAutoJob[]
}
export function saveMemoAutoSettings(
  input: Omit<MemoAutoSettings, 'since'>
): MemoAutoState {
  return getDb().transaction(() => {
    const old = memoAutoSettings()
    if (input.revision !== old.revision)
      throw new Error('自动整理设置已变化，请重新载入')
    if (
      input.subject_ids.length > 100 ||
      new Set(input.subject_ids).size !== input.subject_ids.length
    )
      throw new Error('学科选择无效')
    for (const id of input.subject_ids)
      if (!getDb().prepare('SELECT 1 FROM subjects WHERE id=?').get(id))
        throw new Error('学科不存在')
    if (input.enabled) {
      if (!input.model_db_id) throw new Error('请选择自动整理使用的模型')
      pickModel(input.model_db_id)
      if (!input.subject_ids.length && !input.include_unassigned)
        throw new Error('请选择允许处理的学科或未分类备忘')
      if (!input.knowledge && !input.tasks)
        throw new Error('请选择允许归档的种类')
    }
    const next = {
      ...input,
      revision: nanoid(),
      since: old.enabled
        ? old.since
        : (
            getDb()
              .prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM memo_versions')
              .get() as { n: number }
          ).n
    }
    getDb()
      .prepare(
        'INSERT INTO memo_auto_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json'
      )
      .run(next.revision, JSON.stringify(next))
    for (const job of jobs())
      cancel(job, '自动整理规则已变更，旧请求已取消；可按新规则重试')
    return memoAutoState()
  })()
}
function allowed(subject: string | null, s: MemoAutoSettings): boolean {
  return subject === null
    ? s.include_unassigned
    : s.subject_ids.includes(subject)
}
function enqueue(id: string, s: MemoAutoSettings, now: number): boolean {
  const memo = getDb()
    .prepare('SELECT revision,subject_id,archived FROM memos WHERE id=?')
    .get(id) as {
    revision: string
    subject_id: string | null
    archived: number
  }
  if (
    memo.archived ||
    getDb()
      .prepare('SELECT 1 FROM memo_routes WHERE revision=? LIMIT 1')
      .get(memo.revision) ||
    !allowed(memo.subject_id, s)
  )
    return false
  return !!getDb()
    .prepare(
      "INSERT OR IGNORE INTO memo_auto_jobs(id,memo_id,revision,policy_revision,policy_json,status,attempts,next_at,created_at,updated_at) VALUES(?,?,?,?,?,'pending',0,?,?,?)"
    )
    .run(
      nanoid(),
      id,
      memo.revision,
      s.revision,
      JSON.stringify(s),
      now,
      now,
      now
    ).changes
}
/** Explicit backlog consent, bounded batches; repeats do not duplicate revision identities. */
export function enqueueMemoBacklog(): number {
  const s = memoAutoSettings()
  if (!s.enabled) throw new Error('请先启用并保存自动整理规则')
  return getDb().transaction(() => {
    const rows = getDb()
      .prepare(
        'SELECT m.id FROM memos m WHERE archived=0 AND (subject_id IN (SELECT value FROM json_each(?)) OR (subject_id IS NULL AND ?)) AND NOT EXISTS(SELECT 1 FROM memo_auto_jobs j WHERE j.revision=m.revision) AND NOT EXISTS(SELECT 1 FROM memo_routes r WHERE r.revision=m.revision) ORDER BY created_at,id LIMIT 100'
      )
      .all(JSON.stringify(s.subject_ids), Number(s.include_unassigned)) as {
      id: string
    }[]
    let count = 0
    for (const row of rows) {
      if (enqueue(row.id, s, Date.now())) count++
      if (count >= 100) break
    }
    return count
  })()
}
export function actMemoAuto(input: {
  id: string
  action: 'cancel' | 'retry'
}): MemoAutoState {
  return getDb().transaction(() => {
    const job = getDb()
      .prepare('SELECT * FROM memo_auto_jobs WHERE id=?')
      .get(input.id) as MemoAutoJob | undefined
    if (!job) throw new Error('处理记录不存在')
    if (input.action === 'cancel') {
      if (!['pending', 'running'].includes(job.status))
        throw new Error('此处理已结束')
      cancel(job, '用户停止了此条自动整理；原文保留，可手工整理或重试')
    } else {
      const s = memoAutoSettings(),
        d = memoDetail(job.memo_id)
      if (!s.enabled || !allowed(d.memo.subject_id, s))
        throw new Error('此备忘不在当前启用范围内')
      if (d.memo.archived || d.memo.revision !== job.revision)
        throw new Error('原文已变化，请处理当前修订')
      if (d.routes.some((r) => r.revision === job.revision))
        throw new Error('此修订已归档或撤销，请手工核对，不能自动重复创建')
      if (['pending', 'running'].includes(job.status))
        throw new Error('此条已在处理中')
      getDb()
        .prepare(
          "UPDATE memo_auto_jobs SET status='pending',attempts=0,next_at=?,recognition_id=NULL,policy_revision=?,policy_json=?,reason='已按当前规则重新排队',updated_at=? WHERE id=?"
        )
        .run(Date.now(), s.revision, JSON.stringify(s), Date.now(), job.id)
    }
    return memoAutoState()
  })()
}
function route(job: MemoAutoJob, s: MemoAutoSettings): void {
  getDb().transaction(() => {
    const stamp = getDb()
      .prepare('SELECT model_stamp FROM memo_auto_jobs WHERE id=?')
      .get(job.id) as { model_stamp: string | null }
    if (stamp.model_stamp !== modelStamp(s.model_db_id))
      throw new Error('模型或供应商配置已变化，请按当前规则重试')
    const d = memoDetail(job.memo_id),
      recognition = d.recognitions.find((r) => r.id === job.recognition_id),
      p = recognition?.proposal
    if (!p) throw new Error('识别结果不存在，请重新识别')
    if (p.uncertainties.length) throw new Error(p.uncertainties.join('；'))
    if ((p.knowledge && !s.knowledge) || (p.task && !s.tasks))
      throw new Error('候选包含未获准自动归档的种类，请手工核对')
    if (!p.knowledge && !p.task)
      throw new Error('项目想法或其他记录留在待整理箱')
    if (p.knowledge && !d.memo.subject_id) throw new Error('请先为知识选择学科')
    const plan: MemoRoutePlan = {
      id: job.memo_id,
      expected_revision: job.revision,
      knowledge: p.knowledge
        ? {
            kind: 'new',
            name: p.knowledge.name,
            summary: p.knowledge.summary,
            subject_id: d.memo.subject_id!
          }
        : null,
      task: null
    }
    if (p.task) {
      if (
        d.routes.some(
          (r) =>
            r.revision !== job.revision &&
            !r.undone_at &&
            r.targets.some((t) => t.kind === 'task' && t.target_id)
        )
      )
        throw new Error(
          '此备忘的旧修订已生成待办，请核对原待办后手工整理；不会自动改期或创建第二份'
        )
      verifyMemoTime(d.versions.find((v) => v.id === job.revision)!, p.task)
      if (p.task.location && !d.memo.content.includes(p.task.location))
        throw new Error('地点没有原文依据，请手工核对')
      plan.task = {
        title: p.task.title.trim(),
        detail: p.task.detail,
        due_at: memoTimestamp(p.task.due),
        planned_at: memoTimestamp(p.task.start),
        planned_end_at: memoTimestamp(p.task.end),
        location: p.task.location
      }
      if (
        (plan.task.planned_at !== null && plan.task.planned_at < Date.now()) ||
        (plan.task.due_at !== null && plan.task.due_at < Date.now())
      )
        throw new Error('时间已过去，请手工确认后归档')
      const duplicate = getDb()
        .prepare(
          'SELECT id FROM tasks WHERE status<>? AND title=? AND due_at IS ? AND planned_at IS ? AND planned_end_at IS ? LIMIT 1'
        )
        .get(
          'done',
          plan.task.title,
          plan.task.due_at,
          plan.task.planned_at,
          plan.task.planned_end_at
        )
      if (duplicate) throw new Error('已有同名同时间待办，请核对是否重复')
    }
    const preview = previewMemoRoute(plan)
    if (preview.conflicts.items.length)
      throw new Error('日程存在时间冲突，请核对后决定是否忽略')
    applyMemoRoute({
      plan,
      fingerprint: preview.fingerprint,
      ignore_conflicts: false
    })
    finish(job, 'routed', '已按启用规则自动归档；可查看固定原文和撤销记录')
  })()
}
/** One synchronous bounded tick. Async LLM owns its work lock and durable recognition state. */
export function checkMemoAuto(now = Date.now()): void {
  const s = memoAutoSettings()
  for (const job of jobs()) {
    const memo = getDb()
      .prepare(
        'SELECT revision,subject_id,archived,EXISTS(SELECT 1 FROM memo_routes r WHERE r.revision=?) AS routed FROM memos WHERE id=?'
      )
      .get(job.revision, job.memo_id) as {
      revision: string
      subject_id: string | null
      archived: number
      routed: number
    }
    if (
      !s.enabled ||
      job.policy_revision !== s.revision ||
      !allowed(memo.subject_id, s) ||
      memo.archived ||
      memo.revision !== job.revision ||
      memo.routed
    ) {
      cancel(job, '原文、归档或启用规则已变化，旧处理已停止')
      continue
    }
    if (job.status !== 'running') continue
    const d = memoDetail(job.memo_id)
    const r = d.recognitions.find((r) => r.id === job.recognition_id)
    if (r?.status === 'running') continue
    if (r?.status === 'ready') {
      try {
        route(job, s)
      } catch (e) {
        finish(job, 'review', e instanceof Error ? e.message : String(e))
      }
    } else if (r?.status === 'cancelled')
      finish(job, 'cancelled', '识别已取消；可手工整理或明确重试')
    else if (job.attempts < 3) {
      getDb()
        .prepare(
          "UPDATE memo_auto_jobs SET status='pending',next_at=?,reason=?,updated_at=? WHERE id=?"
        )
        .run(
          now + (job.attempts === 1 ? 30000 : 120000),
          `识别失败，稍后补处理（已尝试 ${job.attempts}/3）：${r?.error ?? '请求中断'}`,
          now,
          job.id
        )
    } else
      finish(
        job,
        'review',
        `已尝试 3 次，请检查网络或模型后重试：${r?.error ?? '请求中断'}`
      )
  }
  if (!s.enabled) return
  // Version identity, not an offset cursor: captures saved offline or during a crash are discovered after restart.
  const candidates = getDb()
    .prepare(
      'SELECT m.id FROM memos m JOIN memo_versions v ON v.id=m.revision WHERE m.archived=0 AND v.rowid>? AND (m.subject_id IN (SELECT value FROM json_each(?)) OR (m.subject_id IS NULL AND ?)) AND NOT EXISTS(SELECT 1 FROM memo_auto_jobs j WHERE j.revision=m.revision) AND NOT EXISTS(SELECT 1 FROM memo_routes r WHERE r.revision=m.revision) ORDER BY v.rowid,m.id LIMIT 100'
    )
    .all(
      s.since,
      JSON.stringify(s.subject_ids),
      Number(s.include_unassigned)
    ) as { id: string }[]
  let count = 0
  for (const row of candidates) {
    if (enqueue(row.id, s, now)) count++
    if (count >= 100) break
  }
  if (memoRecognitionBusy()) return
  const job = getDb()
    .prepare(
      "SELECT * FROM memo_auto_jobs WHERE status='pending' AND next_at<=? ORDER BY created_at,id LIMIT 1"
    )
    .get(now) as MemoAutoJob | undefined
  if (!job) return
  getDb()
    .prepare(
      "UPDATE memo_auto_jobs SET status='running',attempts=attempts+1,updated_at=?,reason='正在识别原文' WHERE id=?"
    )
    .run(now, job.id)
  try {
    const d = recognizeMemo({
      id: job.memo_id,
      expected_revision: job.revision,
      model_db_id: s.model_db_id!
    })
    // Recognition may upgrade a legacy plaintext key to safeStorage before returning.
    const stamp = modelStamp(s.model_db_id)
    const recognition = d.recognitions.find(
      (r) => r.status === 'running' && r.revision === job.revision
    )!
    getDb()
      .prepare(
        'UPDATE memo_auto_jobs SET recognition_id=?,model_stamp=? WHERE id=?'
      )
      .run(recognition.id, stamp, job.id)
  } catch (e) {
    finish(job, 'review', e instanceof Error ? e.message : String(e))
  }
}
export function recoverMemoAuto(now = Date.now()): void {
  // recoverMemoRecognition runs first; its interrupted candidates are never trusted for writes.
  getDb()
    .prepare(
      "UPDATE memo_auto_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'review' END,next_at=?,recognition_id=NULL,reason=CASE WHEN attempts<3 THEN '上次处理已中断，原文保留；将按当前启用规则补处理' ELSE '上次处理已中断且达到 3 次上限，请手工核对或明确重试' END,updated_at=? WHERE status='running'"
    )
    .run(now, now)
}
