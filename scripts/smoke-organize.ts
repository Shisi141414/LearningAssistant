/**
 * scripts/smoke-organize.ts —— AI 整理响应解析的冒烟测试（纯逻辑，不依赖 electron）
 * 运行：node --experimental-strip-types scripts/smoke-organize.ts
 */
import { parseOrganizedResponse, buildOrganizePrompt } from '../src/main/services/organize.ts'

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

console.log('1. prompt 构建')
const prompt = buildOrganizePrompt('科西中值定理是微分中值定理的一般形式', '数学分析')
assert(prompt[0].role === 'system' && prompt[0].content.includes('柯西'), 'system prompt 含术语纠错要求与学科名')
assert(prompt[1].role === 'user' && prompt[1].content.includes('科西'), 'user 消息为原文')

console.log('2. 标准 JSON 解析')
const r1 = parseOrganizedResponse('{"seg_type":"proposition","organized_text":"**柯西中值定理** …"}', 'raw')
assert(!r1.fallback && r1.seg_type === 'proposition', '正常解析 seg_type')
assert(r1.organized_text.startsWith('**柯西'), '正常解析 organized_text')

console.log('3. 代码围栏与前后杂讯容错')
const r2 = parseOrganizedResponse('好的，以下是整理结果：\n```json\n{"seg_type":"definition","organized_text":"定义：极限…"}\n```\n希望有帮助', 'raw')
assert(!r2.fallback && r2.seg_type === 'definition', '剥围栏+截取 JSON 对象成功')

console.log('4. 非法 seg_type 归一为 other')
const r3 = parseOrganizedResponse('{"seg_type":"定理","organized_text":"x"}', 'raw')
assert(!r3.fallback && r3.seg_type === 'other', '未知 seg_type 安全归一')

console.log('5. 不可解析 → 回退原文（离线优先降级）')
const r4 = parseOrganizedResponse('抱歉我无法处理这个请求。', '原始转写文本')
assert(r4.fallback && r4.organized_text === '原始转写文本' && r4.seg_type === 'other', '回退原文且标记 fallback')
const r5 = parseOrganizedResponse('{"seg_type":"note","organized_text":""}', '原文')
assert(r5.fallback, 'organized_text 为空同样回退')

console.log('')
if (failed > 0) {
  console.error(`✗ 冒烟测试失败：${failed} 项`)
  process.exit(1)
}
console.log('✓ organize 解析冒烟测试全部通过')
