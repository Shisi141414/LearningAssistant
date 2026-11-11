import './test-support.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../shared/textChunk.ts'
import { useChatStore } from '../src/renderer/src/stores/chat.ts'
import { streamChat } from '../src/main/services/llm.ts'

test('首条 chunk 和没有 chunk 的完成事件都能创建助手消息', () => {
  useChatStore.setState({ activeSessionId: 's', messages: [], streamingIds: new Set() })
  useChatStore.getState().appendChunk('s', 'a', '第一句')
  useChatStore.getState().appendChunk('s', 'a', '第二句')
  assert.equal(useChatStore.getState().messages[0]?.content, '第一句第二句')
  useChatStore.getState().finishMessage('s', 'a', '完整回答', 'test')
  useChatStore.getState().finishMessage('s', 'b', '', 'test')
  assert.equal(useChatStore.getState().messages.length, 2)
  assert.equal(useChatStore.getState().streamingIds.size, 0)
})

test('切块保留短句、长句的先后顺序，且每块严格限长', () => {
  const text = '前文。' + '长'.repeat(30) + '后文。'
  assert.equal(chunkText(text, { maxChars: 10, overlap: 0 }).map(c => c.text).join(''), text)
  for (const c of chunkText('一'.repeat(9) + '。' + '二'.repeat(9) + '。', { maxChars: 10, overlap: 3 })) assert.ok(c.text.length <= 10)
  for (const maxChars of [0, -1, NaN, 1.5]) assert.throws(() => chunkText(text, { maxChars }))
})

test('Anthropic 流内错误必须上报，支持 CRLF 和跨网络块', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('event: error\r\ndata: {"type":"error","error":{"message":"quota exceeded"}}\r\n\r\n')
    await assert.rejects(streamChat({ api_format: 'anthropic', base_url: 'https://example.invalid', apiKey: 'dummy' }, 'test', [], new AbortController().signal, { onChunk() {} }), /quota exceeded/)
  } finally { globalThis.fetch = original }
})
