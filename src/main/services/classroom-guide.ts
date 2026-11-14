import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type {
  ClassroomGuideAction,
  ClassroomGuideHint,
  ClassroomGuideSave,
  ClassroomGuideState,
  GuideEvidence,
  GuideKind
} from '@shared/classroom-guide'
import {
  detectClassroomGuide,
  GUIDE_RULE_VERSION
} from '@shared/classroom-guide'
import { getDb, dbFilePath } from './db'

interface Policy {
  revision: string
  enabled: number
  cooldown_seconds: number
}
interface Job {
  note: string
  session: string
  epoch: string
  segment: string
  hash: string
  generation: number
}
interface HintRow {
  id: string
  revision: string
  session_id: string
  segment_id: string | null
  source_hash: string
  kind: GuideKind
  evidence_json: string
  excerpt: string
  rule_version: string
  notice: number
  quiet_reason: string
  status: 'open' | 'dismissed' | 'adopted'
  annotation_id: string | null
  annotation_kind: 'keypoint' | 'question' | null
  created_at: number
  raw_text: string | null
}
let active: {
  note: string
  session: string
  database: string
  generation: number
  lastNotice: number
  signatures: Map<string, number>
  dropped: number
  error: string
} | null = null
let generation = 0,
  closing = false
let queue: Job[] = []
let timer: ReturnType<typeof setImmediate> | null = null
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const policy = (id: string) =>
  getDb()
    .prepare(
      'SELECT revision,enabled,cooldown_seconds FROM classroom_guide_settings WHERE note_id=?'
    )
    .get(id) as Policy | undefined
function clearQueue(): void {
  if (timer) clearImmediate(timer)
  timer = null
  queue = []
}
export function stopClassroomGuide(permanent = false): void {
  clearQueue()
  active = null
  generation++
  if (permanent) closing = true
}
export function startClassroomGuide(note: string, session: string): void {
  if (closing) return
  stopClassroomGuide()
  if (
    !getDb()
      .prepare(
        'SELECT 1 FROM classroom_sessions WHERE id=? AND note_id=? AND ended_at IS NULL'
      )
      .get(session, note)
  )
    throw Error('课堂已结束')
  active = {
    note,
    session,
    database: dbFilePath(),
    generation,
    lastNotice: 0,
    signatures: new Map(),
    dropped: 0,
    error: ''
  }
}
function present(row: HintRow): ClassroomGuideHint {
  const { evidence_json, source_hash, raw_text, ...rest } = row
  return {
    ...rest,
    evidence: JSON.parse(evidence_json) as GuideEvidence[],
    notice: !!row.notice,
    stale: raw_text === null || hash(raw_text) !== source_hash
  }
}
export function classroomGuideState(
  note: string,
  offset = 0
): ClassroomGuideState {
  if (!getDb().prepare('SELECT 1 FROM notes WHERE id=?').get(note))
    throw Error('笔记不存在')
  const p = policy(note),
    a =
      active?.note === note && active.database === dbFilePath() ? active : null
  const total = (
    getDb()
      .prepare(
        'SELECT count(*) AS n FROM classroom_guide_hints WHERE note_id=?'
      )
      .get(note) as { n: number }
  ).n
  const hints = getDb()
    .prepare(
      'SELECT h.*,s.raw_text FROM classroom_guide_hints h LEFT JOIN note_segments s ON s.id=h.segment_id WHERE h.note_id=? ORDER BY h.created_at DESC,h.rowid DESC LIMIT 30 OFFSET ?'
    )
    .all(note, offset) as HintRow[]
  // Keep source hashes and mutable source text in the main process.
  return {
    revision: p?.revision ?? null,
    enabled: !!p?.enabled,
    cooldown_seconds: p?.cooldown_seconds ?? 45,
    active: !!a,
    session_id: a?.session ?? null,
    queued: a ? queue.length : 0,
    dropped: a?.dropped ?? 0,
    error: a?.error ?? '',
    hints: hints.map(present),
    total,
    offset
  }
}
export function saveClassroomGuide(
  input: ClassroomGuideSave
): ClassroomGuideState {
  if (
    active?.note !== input.note_id ||
    active.database !== dbFilePath() ||
    !getDb()
      .prepare(
        'SELECT 1 FROM classroom_sessions WHERE id=? AND ended_at IS NULL'
      )
      .get(active.session)
  )
    throw Error('请先开始这场课堂')
  if (
    !Number.isInteger(input.cooldown_seconds) ||
    input.cooldown_seconds < 15 ||
    input.cooldown_seconds > 300
  )
    throw Error('提醒间隔应为 15 至 300 秒')
  getDb().transaction(() => {
    if ((policy(input.note_id)?.revision ?? null) !== input.revision)
      throw Error('导学设置已变化，请刷新后再保存')
    getDb()
      .prepare(
        'INSERT INTO classroom_guide_settings VALUES(?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,cooldown_seconds=excluded.cooldown_seconds'
      )
      .run(
        input.note_id,
        nanoid(),
        input.enabled ? 1 : 0,
        input.cooldown_seconds
      )
  })()
  clearQueue()
  active.error = ''
  active.lastNotice = 0
  active.signatures.clear()
  return classroomGuideState(input.note_id)
}
/** Post-commit enqueue only; no rule evaluation, model or network on the ASR callback. */
export function queueClassroomGuide(segment: string): void {
  if (!active || closing) return
  try {
    const s = getDb()
      .prepare('SELECT note_id,raw_text FROM note_segments WHERE id=?')
      .get(segment) as { note_id: string; raw_text: string } | undefined
    if (!s || s.note_id !== active.note || !s.raw_text.trim()) return
    const p = policy(active.note)
    if (!p?.enabled) return
    if (queue.length >= 32) {
      queue.shift()
      active.dropped++
    }
    queue.push({
      note: active.note,
      session: active.session,
      epoch: p.revision,
      segment,
      hash: hash(s.raw_text),
      generation
    })
    schedule()
  } catch {
    if (active) active.error = '导学提示暂时不可用；原文已保存，可停用后重试。'
  }
}
function schedule(): void {
  if (!timer && queue.length) timer = setImmediate(processNext)
}
function processNext(): void {
  timer = null
  const job = queue.shift(),
    a = active
  try {
    if (
      !job ||
      !a ||
      closing ||
      a.database !== dbFilePath() ||
      a.generation !== job.generation ||
      job.note !== a.note ||
      job.session !== a.session
    )
      return
    const p = policy(job.note)
    if (!p?.enabled || p.revision !== job.epoch) return
    if (
      !getDb()
        .prepare(
          'SELECT 1 FROM classroom_sessions WHERE id=? AND ended_at IS NULL'
        )
        .get(job.session)
    )
      return
    const source = getDb()
      .prepare('SELECT raw_text FROM note_segments WHERE id=? AND note_id=?')
      .get(job.segment, job.note) as { raw_text: string } | undefined
    if (!source || hash(source.raw_text) !== job.hash) return
    if (
      getDb()
        .prepare(
          'SELECT 1 FROM classroom_guide_hints WHERE session_id=? AND segment_id=? AND source_hash=?'
        )
        .get(job.session, job.segment, job.hash)
    )
      return
    const match = detectClassroomGuide(source.raw_text)
    if (!match) return
    const now = Date.now(),
      signature = hash(
        source.raw_text
          .normalize('NFKC')
          .replace(/[\p{P}\p{Z}\s]/gu, '')
          .toLowerCase()
      )
    for (const [key, time] of a.signatures)
      if (now - time >= 600000) a.signatures.delete(key)
    const repeated = a.signatures.has(signature),
      cooling =
        a.lastNotice !== 0 && now - a.lastNotice < p.cooldown_seconds * 1000
    const notice = match.priority >= 70 && !repeated && !cooling
    const first = match.evidence[0],
      excerpt = source.raw_text.slice(
        Math.max(0, first.start - 80),
        first.end + 240
      )
    getDb()
      .prepare(
        'INSERT INTO classroom_guide_hints(id,revision,note_id,session_id,segment_id,source_hash,rule_version,kind,evidence_json,excerpt,notice,quiet_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        nanoid(),
        nanoid(),
        job.note,
        job.session,
        job.segment,
        job.hash,
        GUIDE_RULE_VERSION,
        match.kind,
        JSON.stringify(match.evidence),
        excerpt,
        notice ? 1 : 0,
        repeated
          ? '相同语段已提示，保留记录'
          : cooling
            ? '提醒间隔内，保留记录'
            : match.priority < 70
              ? '一般讲授线索，仅保留记录'
              : '',
        now
      )
    a.signatures.set(signature, now)
    if (a.signatures.size > 256)
      a.signatures.delete(a.signatures.keys().next().value!)
    if (notice) a.lastNotice = now
  } catch {
    if (a && active === a) {
      a.error = '导学提示暂时不可用；原文已保存，可停用后重试。'
      clearQueue()
    }
  } finally {
    if (active && !closing) schedule()
  }
}
export function classroomGuideAction(
  input: ClassroomGuideAction
): ClassroomGuideHint {
  if (!['dismiss', 'keypoint', 'question'].includes(input.action))
    throw Error('不支持的导学操作')
  return getDb().transaction(() => {
    const row = getDb()
      .prepare(
        'SELECT h.*,s.raw_text FROM classroom_guide_hints h LEFT JOIN note_segments s ON s.id=h.segment_id WHERE h.id=?'
      )
      .get(input.id) as HintRow | undefined
    if (!row || row.revision !== input.revision)
      throw Error('提示已变化，请刷新后再操作')
    if (input.action === 'dismiss') {
      getDb()
        .prepare(
          "UPDATE classroom_guide_hints SET status='dismissed',revision=? WHERE id=?"
        )
        .run(nanoid(), row.id)
    } else {
      if (!row.segment_id || present(row).stale)
        throw Error('原文已修改或删除，请回到当前原文核对后手动标注')
      const kind = input.action
      const existing = getDb()
        .prepare(
          'SELECT id FROM annotations WHERE segment_id=? AND kind=? ORDER BY created_at,id LIMIT 1'
        )
        .get(row.segment_id, kind) as { id: string } | undefined
      const annotation = existing?.id ?? nanoid()
      if (!existing)
        getDb()
          .prepare(
            'INSERT INTO annotations(id,segment_id,kind,anchor_json,comment,created_at) VALUES(?,?,?,NULL,?,?)'
          )
          .run(
            annotation,
            row.segment_id,
            kind,
            '导学线索：' + JSON.parse(row.evidence_json)[0].reason,
            Date.now()
          )
      getDb()
        .prepare(
          "UPDATE classroom_guide_hints SET status='adopted',annotation_id=?,annotation_kind=?,revision=? WHERE id=?"
        )
        .run(annotation, kind, nanoid(), row.id)
    }
    return present(
      getDb()
        .prepare(
          'SELECT h.*,s.raw_text FROM classroom_guide_hints h LEFT JOIN note_segments s ON s.id=h.segment_id WHERE h.id=?'
        )
        .get(row.id) as HintRow
    )
  })()
}
