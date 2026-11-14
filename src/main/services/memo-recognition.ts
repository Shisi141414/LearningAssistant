import { nanoid } from 'nanoid'
import { memoPrompt, parseMemoProposal } from '@shared/memo-recognition'
import { getDb } from './db'
import { memoDetail } from './memos'
import { beginWork } from './work'
import { pickModel } from '../ipc/chat.ipc'
import { getProviderWithKey } from '../ipc/providers.ipc'
import { streamChat } from './llm'

const running = new Map<string, AbortController>()
let stopping = false
export const memoRecognitionBusy = (): boolean => running.size > 0
export function recognizeMemo(input: {
  id: string
  expected_revision: string
  model_db_id: string
}): ReturnType<typeof memoDetail> {
  if (stopping) throw new Error('应用正在退出')
  if (running.size) throw new Error('已有备忘正在识别，请等待或取消')
  const detail = memoDetail(input.id),
    source = detail.versions.find((v) => v.id === detail.memo.revision)!
  if (detail.memo.archived || detail.memo.revision !== input.expected_revision)
    throw new Error('备忘已变化，请重新载入')
  const model = pickModel(input.model_db_id),
    { provider, apiKey } = getProviderWithKey(model.provider_id)
  if (!apiKey) throw new Error('所选供应商尚未配置密钥；备忘原文已保存')
  const id = nanoid(),
    controller = new AbortController(),
    release = beginWork('备忘识别')
  try {
    getDb()
      .prepare(
        "INSERT INTO memo_recognitions(id,memo_id,revision,status,provider_name,model_id,created_at) VALUES(?,?,?,'running',?,?,?)"
      )
      .run(id, input.id, source.id, provider.name, model.model_id, Date.now())
  } catch (e) {
    release()
    throw e
  }
  running.set(id, controller)
  const timer = setTimeout(
    () => controller.abort(new Error('备忘识别超时，请重试')),
    120000
  )
  void (async () => {
    try {
      let length = 0
      const response = await streamChat(
        { ...provider, apiKey },
        model.model_id,
        memoPrompt(source),
        controller.signal,
        {
          onChunk: (delta) => {
            length += delta.length
            if (length > 24000) {
              controller.abort(new Error('识别结果过长'))
              throw new Error('识别结果过长')
            }
          }
        }
      )
      if (stopping) return
      if (controller.signal.aborted) throw controller.signal.reason
      const proposal = parseMemoProposal(response, source.content)
      if (source.timezone === 'unknown' && proposal.task) {
        proposal.task.start = null
        proposal.task.end = null
        proposal.task.due = null
        proposal.uncertainties = [
          '原灵感未保存时区，请根据原文手工确认日期和时间。',
          ...proposal.uncertainties
        ].slice(0, 8)
      }
      getDb()
        .prepare(
          "UPDATE memo_recognitions SET status='ready',proposal_json=?,error='' WHERE id=? AND status='running'"
        )
        .run(JSON.stringify(proposal), id)
    } catch (error) {
      if (!stopping) {
        const reason = controller.signal.aborted
          ? controller.signal.reason
          : error
        const message = (
          reason instanceof Error ? reason.message : String(reason)
        )
          .replaceAll(apiKey, '[密钥已隐藏]')
          .slice(0, 1500)
        getDb()
          .prepare(
            "UPDATE memo_recognitions SET status='failed',error=? WHERE id=? AND status='running'"
          )
          .run(message, id)
      }
    } finally {
      clearTimeout(timer)
      running.delete(id)
      release()
    }
  })()
  return memoDetail(input.id)
}
export function cancelMemoRecognition(id: string): boolean {
  getDb()
    .prepare(
      "UPDATE memo_recognitions SET status='cancelled',error='已取消，原文与归档目标未改变' WHERE id=? AND status='running'"
    )
    .run(id)
  running.get(id)?.abort(new Error('已取消'))
  return true
}
export function recoverMemoRecognition(): void {
  stopping = false
  getDb()
    .prepare(
      "UPDATE memo_recognitions SET status='cancelled',error='上次识别已中断，请手动重试；原文已保留' WHERE status='running'"
    )
    .run()
}
export function stopMemoRecognition(): void {
  stopping = true
  for (const [id, controller] of running) {
    getDb()
      .prepare(
        "UPDATE memo_recognitions SET status='cancelled',error='应用关闭中断了识别，请重试' WHERE id=? AND status='running'"
      )
      .run(id)
    controller.abort(new Error('应用正在退出'))
  }
}
