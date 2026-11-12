import { nanoid } from 'nanoid'
import type { LearningProposal, NoteLearningSuggestInput, NoteLearningSuggestion, NoteLearningSuggestionDetail } from '@shared/types'
import { buildLearningSuggestionPrompt, learningFragments, parseLearningProposal, proposalState } from '@shared/learning-suggestions'
import { getDb } from './db'
import { beginWork } from './work'
import { getNoteLearning, publishNoteLearningState } from './note-learning'
import { pickModel } from '../ipc/chat.ipc'
import { getProviderWithKey } from '../ipc/providers.ipc'
import { streamChat } from './llm'

type Row = Omit<NoteLearningSuggestion, 'entry_ids' | 'note_id'> & { request_json: string; proposal_json: string | null }
const running = new Map<string, AbortController>()
let stopping = false
function row(id: string): Row {
  const result = getDb().prepare('SELECT * FROM note_learning_suggestions WHERE id=?').get(id) as Row | undefined
  if (!result) throw new Error('笔记整理建议不存在')
  return result
}
function summary(value: Row): NoteLearningSuggestion {
  const input = JSON.parse(value.request_json) as NoteLearningSuggestInput
  return { id: value.id, note_id: input.note_id, entry_ids: input.entry_ids, base_revision_id: value.base_revision_id, provider_name: value.provider_name, model_id: value.model_id, status: value.status, error: value.error, created_at: value.created_at, applied_revision_id: value.applied_revision_id }
}
export function noteSuggestionDetail(id: string): NoteLearningSuggestionDetail {
  const result = row(id)
  return { ...summary(result), proposal: result.proposal_json ? JSON.parse(result.proposal_json) : null }
}
export function listNoteSuggestions(noteId: string): NoteLearningSuggestion[] {
  return (getDb().prepare('SELECT s.* FROM note_learning_suggestions s JOIN note_learning_documents d ON d.id=s.document_id WHERE d.note_id=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT 20').all(noteId) as Row[]).map(summary)
}
function currentDocument(input: NoteLearningSuggestInput) {
  const document = getNoteLearning({ note_id: input.note_id })
  if (document.pending_sync || document.revision_id !== input.expected_revision_id) throw new Error('笔记或来源已有变化，请读取最新笔记后重新生成建议')
  return document
}
export function startNoteSuggestion(input: NoteLearningSuggestInput): NoteLearningSuggestion {
  if (stopping) throw new Error('应用正在退出')
  if (running.size) throw new Error('已有笔记 AI 整理任务，请等待完成或取消')
  const document = currentDocument(input), fragments = learningFragments(document, input.entry_ids)
  const model = pickModel(input.model_db_id), { provider, apiKey } = getProviderWithKey(model.provider_id)
  if (!apiKey) throw new Error('所选供应商尚未配置密钥')
  const id = nanoid(), controller = new AbortController(), release = beginWork('AI 笔记结构建议')
  try {
    getDb().prepare("INSERT INTO note_learning_suggestions(id,document_id,base_revision_id,request_json,provider_name,model_id,status,created_at) VALUES(?,?,?,?,?,?,'running',?)").run(id, document.id, document.revision_id, JSON.stringify(input), provider.name, model.model_id, Date.now())
  } catch (error) { release(); throw error }
  running.set(id, controller)
  const timer = setTimeout(() => controller.abort(new Error('生成超过两分钟，请缩小范围后重试')), 120_000)
  void (async () => {
    try {
      let length = 0
      const response = await streamChat({ ...provider, apiKey }, model.model_id, buildLearningSuggestionPrompt(fragments), controller.signal, { onChunk: delta => {
        length += delta.length
        if (length > 32_768) { controller.abort(new Error('模型输出过长，请缩小范围')); throw controller.signal.reason }
      } })
      if (stopping) return
      if (controller.signal.aborted) throw controller.signal.reason
      const proposal = parseLearningProposal(response, document, input.entry_ids, fragments, `${provider.name}/${model.model_id}`, nanoid)
      getDb().prepare("UPDATE note_learning_suggestions SET status='ready',proposal_json=?,error=NULL WHERE id=? AND status='running'").run(JSON.stringify(proposal), id)
    } catch (error) {
      if (!stopping) {
        const reason = controller.signal.aborted ? controller.signal.reason : error
        const message = (reason instanceof Error ? reason.message : String(reason)).replaceAll(apiKey, '[密钥已隐藏]').slice(0, 1500)
        getDb().prepare("UPDATE note_learning_suggestions SET status='failed',error=? WHERE id=? AND status='running'").run(message, id)
      }
    } finally { clearTimeout(timer); running.delete(id); release() }
  })()
  return summary(row(id))
}
export function cancelNoteSuggestion(id: string): boolean {
  row(id)
  getDb().prepare("UPDATE note_learning_suggestions SET status='cancelled',error='已取消，笔记未改变' WHERE id=? AND status='running'").run(id)
  running.get(id)?.abort(new Error('已取消'))
  return true
}
export function dismissNoteSuggestion(id: string): boolean {
  if (row(id).status !== 'ready') throw new Error('只能放弃已生成的待审核建议')
  getDb().prepare("UPDATE note_learning_suggestions SET status='dismissed' WHERE id=? AND status='ready'").run(id)
  return true
}
export function applyNoteSuggestion(id: string) {
  return getDb().transaction(() => {
    const result = row(id)
    if (result.status !== 'ready' || !result.proposal_json) throw new Error('建议尚未就绪，或已处理')
    const input = JSON.parse(result.request_json) as NoteLearningSuggestInput, document = currentDocument(input), proposal = JSON.parse(result.proposal_json) as LearningProposal
    proposal.entries.forEach(entry => { entry.analysis.review_status = 'confirmed' })
    proposal.relations.forEach(relation => { relation.review_status = 'confirmed' })
    const published = publishNoteLearningState(input.note_id, input.expected_revision_id, proposalState(document, input.entry_ids, proposal))
    getDb().prepare("UPDATE note_learning_suggestions SET status='applied',applied_revision_id=? WHERE id=? AND status='ready'").run(published.revision_id, id)
    return published
  })()
}
export function recoverNoteSuggestions(): void {
  stopping = false
  getDb().prepare("UPDATE note_learning_suggestions SET status='cancelled',error='上次生成已中断，请手动重新生成；未自动发送请求' WHERE status='running'").run()
}
export function stopNoteSuggestions(): void {
  stopping = true
  for (const [id, controller] of running) {
    getDb().prepare("UPDATE note_learning_suggestions SET status='cancelled',error='应用关闭中断了生成，请手动重新生成' WHERE id=? AND status='running'").run(id)
    controller.abort(new Error('应用正在退出'))
  }
}
