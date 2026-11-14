import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { nanoid } from 'nanoid'
import type {
  AlignmentBlock,
  AlignmentMatch,
  ClassroomAlignmentJob,
  ClassroomAlignmentState
} from '@shared/classroom-alignment'
import { getDb } from './db'
import { beginWork } from './work'
import { captureNoteLearning } from './note-learning'

interface Policy {
  revision: string
  enabled: number
  hold_segment: number
}
interface Job {
  id: string
  note_id: string
  segment_id: string
  session_id: string
  epoch: string
  source_revision: number
  raw_hash: string
  source_anchor_id: string
  version_id: string
  hold_segment: number
  status: string
}
let active: { noteId: string; sessionId: string } | null = null
let closing = false
let pumping = false
let queueError = ''
let worker: Worker | null = null
let workerVersion = ''
let rejectWorker: ((error: Error) => void) | null = null
let workerRelease: (() => void) | null = null
const waiters = new Map<string, Set<() => void>>()
const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

function settle(segmentId: string): void {
  for (const done of waiters.get(segmentId) ?? []) done()
  waiters.delete(segmentId)
}
function stopWorker(): void {
  const previous = worker
  worker = null
  workerVersion = ''
  rejectWorker?.(new Error('教材对齐已停止'))
  rejectWorker = null
  // No database is opened by the worker; release only after termination finishes.
  const release = workerRelease
  workerRelease = null
  if (previous)
    void previous.terminate().then(
      () => release?.(),
      () => release?.()
    )
  else release?.()
}
export function recoverClassroomAlignment(): void {
  getDb()
    .prepare(
      "UPDATE classroom_alignment_jobs SET status='cancelled',reason='上次课堂已中断；保留原文与当时来源',updated_at=? WHERE status IN ('queued','running')"
    )
    .run(Date.now())
}
export function startClassroomAlignment(
  noteId: string,
  sessionId: string
): void {
  active = { noteId, sessionId }
  closing = false
  queueError = ''
}
export function stopClassroomAlignment(shutdown = false): void {
  closing = closing || shutdown
  const previous = active
  active = null
  if (previous)
    getDb()
      .prepare(
        "UPDATE classroom_alignment_jobs SET status='cancelled',reason='课堂已结束；保留原文与当时来源',updated_at=? WHERE session_id=? AND status IN ('queued','running')"
      )
      .run(Date.now(), previous.sessionId)
  stopWorker()
  for (const id of waiters.keys()) settle(id)
}
export function classroomAlignmentState(
  noteId: string
): ClassroomAlignmentState {
  if (!getDb().prepare('SELECT id FROM notes WHERE id=?').get(noteId))
    throw new Error('课堂笔记不存在')
  const policy = getDb()
    .prepare('SELECT * FROM classroom_alignment_settings WHERE note_id=?')
    .get(noteId) as Policy | undefined
  const rows = getDb()
    .prepare(
      `SELECT id,epoch,session_id,segment_id,status,reason,candidates_json,applied_block_id,created_at,updated_at FROM classroom_alignment_jobs WHERE note_id=? ORDER BY rowid DESC LIMIT 20`
    )
    .all(noteId) as Array<
    Omit<ClassroomAlignmentJob, 'candidates'> & { candidates_json: string }
  >
  return {
    revision: policy?.revision ?? null,
    enabled: !!policy?.enabled,
    active: active?.noteId === noteId,
    session_id: active?.noteId === noteId ? active.sessionId : null,
    error: active?.noteId === noteId ? queueError : '',
    jobs: rows.map(({ candidates_json, ...row }) => ({
      ...row,
      candidates: JSON.parse(candidates_json)
    }))
  }
}
export function saveClassroomAlignment(input: {
  note_id: string
  revision: string | null
  enabled: boolean
}): ClassroomAlignmentState {
  const db = getDb()
  db.transaction(() => {
    if (active?.noteId !== input.note_id) throw new Error('请先开始这场课堂')
    const policy = db
      .prepare('SELECT * FROM classroom_alignment_settings WHERE note_id=?')
      .get(input.note_id) as Policy | undefined
    if ((policy?.revision ?? null) !== input.revision)
      throw new Error('跟随设置已变化，请读取最新设置')
    if (
      input.enabled &&
      !db
        .prepare(
          `SELECT 1 FROM classroom_positions p JOIN material_blocks b ON b.id=p.block_id JOIN material_versions v ON v.id=b.version_id JOIN materials m ON m.id=v.material_id WHERE p.note_id=? AND v.status='ready' AND m.archived=0`
        )
        .get(input.note_id)
    )
      throw new Error('请先校准到可阅读的教材位置')
    db.prepare(
      `INSERT INTO classroom_alignment_settings(note_id,revision,enabled,hold_segment) VALUES(?,?,?,1) ON CONFLICT(note_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,hold_segment=1`
    ).run(input.note_id, nanoid(), input.enabled ? 1 : 0)
    db.prepare(
      "UPDATE classroom_alignment_jobs SET status='cancelled',reason='跟随设置已变化；保留原文与当时来源',updated_at=? WHERE note_id=? AND status IN ('queued','running')"
    ).run(Date.now(), input.note_id)
  })()
  cancelStaleAlignment(input.note_id)
  return classroomAlignmentState(input.note_id)
}
/** Called after manual calibration commits, never inside its transaction. */
export function cancelStaleAlignment(noteId: string): void {
  if (active?.noteId !== noteId) return
  stopWorker()
  for (const id of waiters.keys()) settle(id)
  queueMicrotask(() => void pump())
}
export function queueClassroomAlignment(segmentId: string): void {
  if (!active || closing) return
  try {
    getDb().transaction(() => enqueue(segmentId))()
    queueError = ''
  } catch {
    queueError =
      '位置待校准：本段定位未能排队，原文和当时来源已保存；可手动校准'
  }
}
function enqueue(segmentId: string): void {
  if (!active || closing) return
  const db = getDb()
  const seg = db
    .prepare('SELECT note_id,raw_text,revision FROM note_segments WHERE id=?')
    .get(segmentId) as
    | { note_id: string; raw_text: string; revision: number }
    | undefined
  if (!seg || seg.note_id !== active.noteId || !seg.raw_text.trim()) return
  const policy = db
    .prepare('SELECT * FROM classroom_alignment_settings WHERE note_id=?')
    .get(seg.note_id) as Policy | undefined
  if (!policy?.enabled) return
  const anchor = db
    .prepare(
      `SELECT b.id,b.version_id FROM classroom_positions p JOIN material_blocks b ON b.id=p.block_id JOIN material_versions v ON v.id=b.version_id JOIN materials m ON m.id=v.material_id WHERE p.note_id=? AND v.status='ready' AND m.archived=0`
    )
    .get(seg.note_id) as { id: string; version_id: string } | undefined
  if (!anchor) return
  const count = (
    db
      .prepare(
        "SELECT count(*) AS n FROM classroom_alignment_jobs WHERE status IN ('queued','running')"
      )
      .get() as { n: number }
  ).n
  const now = Date.now()
  db.prepare(
    `INSERT INTO classroom_alignment_jobs(id,note_id,segment_id,session_id,epoch,source_revision,raw_hash,source_anchor_id,version_id,hold_segment,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nanoid(),
    seg.note_id,
    segmentId,
    active.sessionId,
    policy.revision,
    seg.revision,
    hash(seg.raw_text),
    anchor.id,
    anchor.version_id,
    policy.hold_segment,
    count >= 8 ? 'review' : 'queued',
    count >= 8
      ? '位置待校准：转写较快，已保留原文和上次位置'
      : '等待本地教材匹配',
    now,
    now
  )
  db.prepare(
    'UPDATE classroom_alignment_settings SET hold_segment=0 WHERE note_id=?'
  ).run(seg.note_id)
  queueMicrotask(() => void pump())
}
export function waitForClassroomAlignment(
  segmentId: string
): boolean | Promise<boolean> {
  if (closing) return false
  const row = getDb()
    .prepare('SELECT status FROM classroom_alignment_jobs WHERE segment_id=?')
    .get(segmentId) as { status: string } | undefined
  if (row && ['queued', 'running'].includes(row.status))
    return new Promise<void>((done) => {
      const set = waiters.get(segmentId) ?? new Set()
      set.add(done)
      waiters.set(segmentId, set)
    }).then(() => !closing)
  return !closing
}
function matchInWorker(
  job: Job,
  text: string,
  ordinal: number
): Promise<AlignmentMatch> {
  let blocks: AlignmentBlock[] | undefined
  if (!worker || workerVersion !== job.version_id) {
    stopWorker()
    blocks = getDb()
      .prepare(
        'SELECT id,ordinal,text,locator_json FROM material_blocks WHERE version_id=? ORDER BY ordinal LIMIT 5001'
      )
      .all(job.version_id) as AlignmentBlock[]
    if (
      blocks.length > 5000 ||
      blocks.reduce((sum, b) => sum + b.text.length, 0) > 4_000_000
    )
      throw new Error('教材超出本批自动对齐范围，请手动校准')
    worker = new Worker(
      join(
        typeof __dirname === 'string' ? __dirname : resolve('out/main'),
        'classroom-alignment-worker.js'
      )
    )
    const owned = worker
    owned.on('error', () => {
      if (worker === owned) stopWorker()
    })
    owned.on('exit', () => {
      if (worker === owned) stopWorker()
    })
    workerVersion = job.version_id
    workerRelease = beginWork('教材对齐')
  }
  const current = worker
  return new Promise((done, reject) => {
    const finish = (error?: Error, result?: AlignmentMatch): void => {
      clearTimeout(timer)
      current.removeListener('message', onMessage)
      current.removeListener('error', onError)
      current.removeListener('exit', onExit)
      if (rejectWorker === onError) rejectWorker = null
      if (error) reject(error)
      else done(result!)
    }
    const onError = (error: Error): void => finish(error)
    const onExit = (): void => finish(new Error('教材匹配线程已退出'))
    const onMessage = (message: {
      result?: AlignmentMatch
      error?: string
    }): void =>
      finish(
        message.error ? new Error(message.error) : undefined,
        message.result
      )
    const timer = setTimeout(() => {
      finish(new Error('教材匹配超时，请手动校准'))
      stopWorker()
    }, 10_000)
    current.once('message', onMessage)
    current.once('error', onError)
    current.once('exit', onExit)
    rejectWorker = onError
    current.postMessage({ blocks, text, ordinal })
  })
}
function valid(job: Job): boolean {
  if (closing || active?.sessionId !== job.session_id) return false
  const db = getDb()
  const row = db
    .prepare(
      `SELECT j.status,s.raw_text,s.revision,p.revision AS epoch,p.enabled,v.status AS version_status,m.archived,c.ended_at FROM classroom_alignment_jobs j JOIN note_segments s ON s.id=j.segment_id JOIN classroom_alignment_settings p ON p.note_id=j.note_id JOIN material_versions v ON v.id=j.version_id JOIN materials m ON m.id=v.material_id JOIN classroom_sessions c ON c.id=j.session_id WHERE j.id=?`
    )
    .get(job.id) as
    | {
        status: string
        raw_text: string
        revision: number
        epoch: string
        enabled: number
        version_status: string
        archived: number
        ended_at: number | null
      }
    | undefined
  return (
    !!row &&
    row.status === 'running' &&
    row.enabled === 1 &&
    row.epoch === job.epoch &&
    row.revision === job.source_revision &&
    hash(row.raw_text) === job.raw_hash &&
    row.version_status === 'ready' &&
    !row.archived &&
    row.ended_at === null
  )
}
async function pump(): Promise<void> {
  if (pumping || closing || !active) return
  pumping = true
  try {
    while (active && !closing) {
      const db = getDb()
      const job = db
        .prepare(
          "SELECT * FROM classroom_alignment_jobs WHERE session_id=? AND status='queued' ORDER BY rowid LIMIT 1"
        )
        .get(active.sessionId) as Job | undefined
      if (!job) break
      try {
        db.prepare(
          "UPDATE classroom_alignment_jobs SET status='running',updated_at=? WHERE id=?"
        ).run(Date.now(), job.id)
        const seg = db
          .prepare('SELECT raw_text FROM note_segments WHERE id=?')
          .get(job.segment_id) as { raw_text: string }
        const cursor = db
          .prepare(
            'SELECT b.ordinal,b.id,b.version_id FROM classroom_positions p JOIN material_blocks b ON b.id=p.block_id WHERE p.note_id=?'
          )
          .get(job.note_id) as
          | { ordinal: number; id: string; version_id: string }
          | undefined
        if (!valid(job) || !cursor || cursor.version_id !== job.version_id)
          throw new Error('教材位置或原文已变化')
        const match = await matchInWorker(job, seg.raw_text, cursor.ordinal)
        if (!active || closing) break
        db.transaction(() => {
          if (!valid(job)) {
            db.prepare(
              "UPDATE classroom_alignment_jobs SET status='cancelled',reason='原文、教材或手动校准已变化；保留当时来源',updated_at=? WHERE id=? AND status='running'"
            ).run(Date.now(), job.id)
            return
          }
          const best = match.candidates[0]
          let apply = match.strong
          let reason = match.reason
          if (apply && best.id !== cursor.id && job.hold_segment) {
            apply = false
            reason = '位置待校准：优先保留刚才的手动位置，本段候选供核对'
          }
          if (apply && Math.abs(best.ordinal - cursor.ordinal) > 4) {
            const previous = db
              .prepare(
                'SELECT candidates_json,status,strong_match,created_at FROM classroom_alignment_jobs WHERE session_id=? AND epoch=? AND rowid<(SELECT rowid FROM classroom_alignment_jobs WHERE id=?) ORDER BY rowid DESC LIMIT 1'
              )
              .get(job.session_id, job.epoch, job.id) as
              | {
                  candidates_json: string
                  status: string
                  strong_match: number
                  created_at: number
                }
              | undefined
            const candidate =
              previous &&
              previous.status === 'review' &&
              previous.strong_match &&
              Date.now() - previous.created_at < 120_000
                ? JSON.parse(previous.candidates_json)[0]
                : null
            if (
              !candidate ||
              candidate.id !== best.id ||
              candidate.coverage < 0.72
            ) {
              apply = false
              reason =
                '位置待校准：可能跳页或回讲，等待下一段核对，也可手动确认'
            }
          }
          const now = Date.now()
          db.prepare(
            'UPDATE classroom_alignment_jobs SET status=?,applied_block_id=?,candidates_json=?,reason=?,updated_at=?,strong_match=? WHERE id=?'
          ).run(
            apply ? 'applied' : 'review',
            apply ? best.id : null,
            JSON.stringify(match.candidates),
            reason,
            now,
            match.strong ? 1 : 0,
            job.id
          )
          if (apply) {
            db.prepare(
              'UPDATE classroom_positions SET block_id=?,updated_at=? WHERE note_id=?'
            ).run(best.id, now, job.note_id)
            db.prepare(
              "INSERT INTO classroom_calibrations(id,note_id,session_id,block_id,reason,created_at) VALUES(?,?,?,?,'automatic',?)"
            ).run(nanoid(), job.note_id, job.session_id, best.id, now)
            captureNoteLearning(job.segment_id)
          }
        })()
      } catch (error) {
        if (!closing && active) {
          const stale = !valid(job)
          db.prepare(
            "UPDATE classroom_alignment_jobs SET status=?,reason=?,updated_at=? WHERE id=? AND status IN ('queued','running')"
          ).run(
            stale ? 'cancelled' : 'failed',
            `位置待校准：${error instanceof Error ? error.message : String(error)}`,
            Date.now(),
            job.id
          )
          stopWorker()
        }
      } finally {
        settle(job.segment_id)
      }
    }
  } finally {
    pumping = false
  }
}
