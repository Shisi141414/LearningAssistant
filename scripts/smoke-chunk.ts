/**
 * scripts/smoke-chunk.ts —— 文档切块器冒烟测试（纯逻辑）
 * 运行：node --experimental-strip-types scripts/smoke-chunk.ts
 */
import { chunkText } from '../shared/textChunk.ts'
import { DIAG_CHUNK_SAMPLE } from '../shared/diagSamples.ts'

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

console.log('1. 样例教材切块')
const chunks = chunkText(DIAG_CHUNK_SAMPLE)
assert(chunks.length >= 5, `块数合理（实际 ${chunks.length}）`)
const headings = new Set(chunks.map((c) => c.heading))
assert(headings.has('第二章 极限与连续 > §2.1 数列的极限'), '标题链正确（二级标题挂在一级下）')

console.log('2. 块长度约束')
const maxLen = Math.max(...chunks.map((c) => c.text.length))
assert(maxLen <= 600, `无块超过上限+容差（最大 ${maxLen} 字符）`)

console.log('3. 无内容丢失')
const sourceChars = DIAG_CHUNK_SAMPLE.replace(/\s/g, '').length
const chunkChars = chunks.map((c) => c.text.replace(/\s/g, '').length).reduce((a, b) => a + b, 0)
// 标题块会重复计入标题文本、细切 overlap 会重复字符，所以块字符总数 >= 原文
assert(chunkChars >= sourceChars, `内容完整（原文 ${sourceChars} / 块合计 ${chunkChars} 字符）`)

console.log('4. 空文本与无标题文本')
assert(chunkText('').length === 0, '空文本返回空数组')
const noHead = chunkText('只是普通段落，没有标题。'.repeat(30))
assert(noHead.length > 0 && noHead.every((c) => c.heading === ''), '无标题文本正常切块且标题链为空')

console.log('5. 超长无标点行硬切')
const longLine = 'x'.repeat(1200)
const hardChunks = chunkText(longLine, { maxChars: 500, overlap: 0 })
assert(hardChunks.length === 3 && hardChunks.every((c) => c.text.length === 500 || c.text.length === 200), '1200 字符按 500 硬切为 3 块')

console.log('')
if (failed > 0) {
  console.error(`✗ 冒烟测试失败：${failed} 项`)
  process.exit(1)
}
console.log('✓ 切块器冒烟测试全部通过')
