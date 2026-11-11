import { nanoid } from 'nanoid'
import type { LearningDocument, LearningProposal, LearningSuggestInput, LearningSuggestion, LearningSuggestionDetail } from '@shared/types'
import { buildLearningSuggestionPrompt, learningFragments, parseLearningProposal, proposalState } from '@shared/learning-suggestions'
import { getDb } from './db'
import { beginWork } from './work'
import { getLearningDocument, publishLearningRevision } from './learning-documents'
import { pickModel } from '../ipc/chat.ipc'
import { getProviderWithKey } from '../ipc/providers.ipc'
import { streamChat } from './llm'

interface SuggestionRow extends Omit<LearningSuggestion, 'entry_ids'> { request_json: string; proposal_json: string | null }
const running = new Map<string, AbortController>()
let stopping = false
function row(id: string): SuggestionRow {
  const result = getDb().prepare('SELECT * FROM learning_suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
  if (!result) throw new Error('整理建议不存在')
  return result
}
function summary(row: SuggestionRow): LearningSuggestion {
  return { id: row.id, version_id: row.version_id, base_revision_id: row.base_revision_id, entry_ids: (JSON.parse(row.request_json) as LearningSuggestInput).entry_ids, provider_name: row.provider_name, model_id: row.model_id, status: row.status, error: row.error, created_at: row.created_at, applied_revision_id: row.applied_revision_id }
}
export function learningSuggestionDetail(id: string): LearningSuggestionDetail {
  const result = row(id)
  return { ...summary(result), proposal: result.proposal_json ? JSON.parse(result.proposal_json) : null }
}
export function listLearningSuggestions(versionId: string): LearningSuggestion[] {
  return (getDb().prepare('SELECT * FROM learning_suggestions WHERE version_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20').all(versionId) as SuggestionRow[]).map(summary)
}
function currentDocument(input: LearningSuggestInput): LearningDocument {
  const archived = getDb().prepare('SELECT m.archived FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ?').get(input.version_id) as { archived: number } | undefined
  const document = getLearningDocument({ version_id: input.version_id })
  if (!document || !archived || archived.archived) throw new Error('请选择未归档且已建立的学习文档')
  if (document.current_revision_id !== input.expected_revision_id) throw new Error('学习文档已有更新，请刷新后重新生成建议')
  return document
}
export function startLearningSuggestion(input: LearningSuggestInput): LearningSuggestion {
  if (stopping) throw new Error('应用正在退出')
  if (running.size) throw new Error('已有材料 AI 整理任务，请等待完成或取消')
  const document = currentDocument(input), fragments = learningFragments(document, input.entry_ids)
  const model = pickModel(input.model_db_id), { provider, apiKey } = getProviderWithKey(model.provider_id)
  if (!apiKey) throw new Error('所选供应商尚未配置密钥')
  const id = nanoid(), controller = new AbortController(), release = beginWork('AI 学习文档建议')
  try {
    getDb().prepare("INSERT INTO learning_suggestions (id, document_id, version_id, base_revision_id, request_json, provider_name, model_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)").run(id, document.id, input.version_id, input.expected_revision_id, JSON.stringify(input), provider.name, model.model_id, Date.now())
  } catch (error) { release(); throw error }
  running.set(id, controller)
  const timer = setTimeout(() => controller.abort(new Error('生成超过两分钟，请缩小范围后重试')), 120_000)
  void (async () => {
    try {
      let length = 0
      const response = await streamChat({ ...provider, apiKey }, model.model_id, buildLearningSuggestionPrompt(fragments), controller.signal, { onChunk: delta => {
        length += delta.length
        if (length > 32_768) { controller.abort(new Error('模型输出过长，请缩小范围')); throw new Error('模型输出过长，请缩小范围') }
      } })
      if (stopping) return
      if (controller.signal.aborted) throw controller.signal.reason
      const proposal = parseLearningProposal(response, document, input.entry_ids, fragments, `${provider.name}/${model.model_id}`, nanoid)
      getDb().prepare("UPDATE learning_suggestions SET status = 'ready', proposal_json = ?, error = NULL WHERE id = ? AND status = 'running'").run(JSON.stringify(proposal), id)
    } catch (error) {
      if (!stopping) {
        const reason = controller.signal.aborted ? controller.signal.reason : error
        const message = (reason instanceof Error ? reason.message : String(reason)).replaceAll(apiKey, '[密钥已隐藏]').slice(0, 1500)
        getDb().prepare("UPDATE learning_suggestions SET status = 'failed', error = ? WHERE id = ? AND status = 'running'").run(message, id)
      }
    } finally { clearTimeout(timer); running.delete(id); release() }
  })()
  return summary(row(id))
}
export function cancelLearningSuggestion(id: string): boolean {
  row(id)
  getDb().prepare("UPDATE learning_suggestions SET status = 'cancelled', error = '已取消，当前文档未改变' WHERE id = ? AND status = 'running'").run(id)
  running.get(id)?.abort(new Error('已取消'))
  return true
}
export function dismissLearningSuggestion(id: string): boolean {
  const result = row(id)
  if (result.status !== 'ready') throw new Error('只能放弃已生成的待审核建议')
  getDb().prepare("UPDATE learning_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'ready'").run(id)
  return true
}
export function applyLearningSuggestion(id: string): LearningDocument {
  return getDb().transaction(() => {
    const result = row(id)
    if (result.status !== 'ready' || !result.proposal_json) throw new Error('建议尚未就绪，或已处理')
    const input = JSON.parse(result.request_json) as LearningSuggestInput, document = currentDocument(input)
    const proposal = JSON.parse(result.proposal_json) as LearningProposal
    proposal.entries.forEach(entry => { entry.analysis.review_status = 'confirmed' })
    proposal.relations.forEach(relation => { relation.review_status = 'confirmed' })
    const published = publishLearningRevision(document, proposalState(document, input.entry_ids, proposal))
    getDb().prepare("UPDATE learning_suggestions SET status = 'applied', applied_revision_id = ? WHERE id = ? AND status = 'ready'").run(published.revision_id, id)
    return published
  })()
}
export function recoverLearningSuggestions(): void {
  stopping = false
  getDb().prepare("UPDATE learning_suggestions SET status = 'cancelled', error = '上次生成已中断，请手动重新生成；未自动发送请求' WHERE status = 'running'").run()
}
export function stopLearningSuggestions(): void {
  stopping = true
  for (const [id, controller] of running) {
    getDb().prepare("UPDATE learning_suggestions SET status = 'cancelled', error = '应用关闭中断了生成，请手动重新生成' WHERE id = ? AND status = 'running'").run(id)
    controller.abort(new Error('应用正在退出'))
  }
}
