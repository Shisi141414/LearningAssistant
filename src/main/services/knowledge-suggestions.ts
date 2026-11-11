import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { KnowledgeAdoptInput, KnowledgeAdoption, KnowledgeCandidate, KnowledgeSuggestInput, KnowledgeSuggestion, KnowledgeSuggestionDetail, EvidenceSource } from '@shared/types'
import { evidenceLookup } from '@shared/evidence'
import { knowledgePrompt, parseKnowledgeCandidates } from '@shared/knowledge-suggestions'
import { getDb } from './db'
import { beginWork } from './work'
import { captureEvidenceSource, addEvidence, createConceptWithEvidence } from './evidence'
import { pickModel } from '../ipc/chat.ipc'
import { getProviderWithKey } from '../ipc/providers.ipc'
import { streamChat } from './llm'

type Snapshot = ReturnType<typeof captureEvidenceSource> & { source: EvidenceSource; quote_sha256: string }
interface Row { id: string; snapshot_json: string; provider_name: string; model_id: string; status: KnowledgeSuggestion['status']; error: string | null; proposal_json: string | null; created_at: number }
const running = new Map<string, AbortController>()
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
let stopping = false
function row(id: string): Row {
  const result = getDb().prepare('SELECT * FROM knowledge_suggestions WHERE id=?').get(id) as Row | undefined
  if (!result) throw new Error('知识候选记录不存在')
  return result
}
function summary(row: Row): KnowledgeSuggestion {
  const snapshot = JSON.parse(row.snapshot_json) as Snapshot
  return { id: row.id, source: snapshot.source, source_title: snapshot.source_title, provider_name: row.provider_name, model_id: row.model_id, status: row.status, error: row.error, created_at: row.created_at }
}
export function knowledgeSuggestionDetail(id: string): KnowledgeSuggestionDetail {
  const result = row(id), snapshot = JSON.parse(result.snapshot_json) as Snapshot
  const adoptions = getDb().prepare('SELECT candidate_index,concept_id,evidence_id FROM knowledge_suggestion_adoptions WHERE suggestion_id=? ORDER BY candidate_index').all(id) as KnowledgeAdoption[]
  return { ...summary(result), quote: snapshot.quote, quote_sha256: snapshot.quote_sha256, location: snapshot.location, source_subject_id: snapshot.source_subject_id, candidates: result.proposal_json ? JSON.parse(result.proposal_json) : null, adoptions }
}
export function listKnowledgeSuggestions(source: EvidenceSource): KnowledgeSuggestion[] {
  return (getDb().prepare('SELECT * FROM knowledge_suggestions WHERE source_lookup=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(evidenceLookup(source)) as Row[]).map(summary)
}
export function startKnowledgeSuggestion(input: KnowledgeSuggestInput): KnowledgeSuggestion {
  if (stopping) throw new Error('应用正在退出')
  if (running.size) throw new Error('已有知识候选生成任务，请等待完成或取消')
  const captured = captureEvidenceSource(input)
  if (!captured.quote.trim() || captured.quote.length > 12_000) throw new Error('每次提议须为非空来源且最多 12000 字符，请先拆分长条目')
  const model = pickModel(input.model_db_id), { provider, apiKey } = getProviderWithKey(model.provider_id)
  if (!apiKey) throw new Error('所选供应商尚未配置密钥')
  const snapshot: Snapshot = { ...captured, source: input.source, quote_sha256: hash(captured.quote) }
  const id = nanoid(), controller = new AbortController(), release = beginWork('AI 知识候选')
  try {
    getDb().prepare("INSERT INTO knowledge_suggestions(id,source_lookup,snapshot_json,provider_name,model_id,status,created_at) VALUES (?,?,?,?,?,'running',?)").run(id, evidenceLookup(input.source), JSON.stringify(snapshot), provider.name, model.model_id, Date.now())
  } catch (error) { release(); throw error }
  running.set(id, controller)
  const timer = setTimeout(() => controller.abort(new Error('生成超过两分钟，请缩小来源后重试')), 120_000)
  void (async () => {
    try {
      let length = 0
      const response = await streamChat({ ...provider, apiKey }, model.model_id, knowledgePrompt(snapshot.quote), controller.signal, { onChunk: delta => {
        length += delta.length
        if (length > 32_768) { controller.abort(new Error('模型输出过长')); throw new Error('模型输出过长') }
      } })
      if (stopping) return
      if (controller.signal.aborted) throw controller.signal.reason
      const candidates = parseKnowledgeCandidates(response, snapshot.quote)
      getDb().prepare("UPDATE knowledge_suggestions SET status='ready',proposal_json=?,error=NULL WHERE id=? AND status='running'").run(JSON.stringify(candidates), id)
    } catch (error) {
      if (!stopping) {
        const reason = controller.signal.aborted ? controller.signal.reason : error
        const message = (reason instanceof Error ? reason.message : String(reason)).replaceAll(apiKey, '[密钥已隐藏]').slice(0, 1500)
        getDb().prepare("UPDATE knowledge_suggestions SET status='failed',error=? WHERE id=? AND status='running'").run(message, id)
      }
    } finally { clearTimeout(timer); running.delete(id); release() }
  })()
  return summary(row(id))
}
export function cancelKnowledgeSuggestion(id: string): boolean {
  row(id)
  getDb().prepare("UPDATE knowledge_suggestions SET status='cancelled',error='已取消，知识库未改变' WHERE id=? AND status='running'").run(id)
  running.get(id)?.abort(new Error('已取消'))
  return true
}
export function dismissKnowledgeSuggestion(id: string): boolean {
  if (row(id).status !== 'ready') throw new Error('只能放弃已生成的剩余候选')
  getDb().prepare("UPDATE knowledge_suggestions SET status='dismissed' WHERE id=? AND status='ready'").run(id)
  return true
}
export function adoptKnowledgeSuggestion(input: KnowledgeAdoptInput): KnowledgeSuggestionDetail {
  return getDb().transaction(() => {
    const db = getDb(), result = row(input.suggestion_id)
    // 已采纳的候选即使证据后来移除，也不会因重复请求而重建。
    if (db.prepare('SELECT 1 FROM knowledge_suggestion_adoptions WHERE suggestion_id=? AND candidate_index=?').get(result.id, input.candidate_index)) return knowledgeSuggestionDetail(result.id)
    if (result.status !== 'ready' || !result.proposal_json) throw new Error('候选尚未就绪或已处理')
    const candidates = JSON.parse(result.proposal_json) as KnowledgeCandidate[]
    if (!candidates[input.candidate_index]) throw new Error('知识候选不存在')
    const snapshot = JSON.parse(result.snapshot_json) as Snapshot
    const source = { source: snapshot.source, ...(snapshot.source.kind === 'note' ? { expected_note_text: snapshot.quote } : {}) }
    const current = captureEvidenceSource(source)
    if (hash(current.quote) !== snapshot.quote_sha256) throw new Error('引用来源已变化，请重新生成并核对')
    let conceptId: string, evidenceId: string
    if (input.target.kind === 'existing') {
      const concept = db.prepare('SELECT revision FROM knowledge_points WHERE id=?').get(input.target.concept_id) as { revision: number } | undefined
      if (!concept || concept.revision !== input.target.expected_revision) throw new Error('所选知识点已变化，请重新载入并核对')
      conceptId = input.target.concept_id
      evidenceId = addEvidence({ ...source, role: input.role, memo: input.memo, concept_id: conceptId }).evidence.id
    } else {
      const created = createConceptWithEvidence({ ...source, role: input.role, memo: input.memo, concept: input.target.concept })
      conceptId = created.concept.id; evidenceId = created.evidence.id
    }
    db.prepare('INSERT INTO knowledge_suggestion_adoptions(suggestion_id,candidate_index,concept_id,evidence_id,decision_json,created_at) VALUES (?,?,?,?,?,?)').run(result.id, input.candidate_index, conceptId, evidenceId, JSON.stringify(input), Date.now())
    const adopted = (db.prepare('SELECT count(*) AS n FROM knowledge_suggestion_adoptions WHERE suggestion_id=?').get(result.id) as { n: number }).n
    if (adopted === candidates.length) db.prepare("UPDATE knowledge_suggestions SET status='applied' WHERE id=?").run(result.id)
    return knowledgeSuggestionDetail(result.id)
  })()
}
export function recoverKnowledgeSuggestions(): void {
  stopping = false
  getDb().prepare("UPDATE knowledge_suggestions SET status='cancelled',error='上次生成已中断，请手动重新生成；未自动发送请求' WHERE status='running'").run()
}
export function stopKnowledgeSuggestions(): void {
  stopping = true
  for (const [id, controller] of running) {
    getDb().prepare("UPDATE knowledge_suggestions SET status='cancelled',error='应用关闭中断了生成，请手动重新生成' WHERE id=? AND status='running'").run(id)
    controller.abort(new Error('应用正在退出'))
  }
}
