import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mathTokens, mathEditorDocument, mathEditorText } from '../shared/math-editor.ts'

test('混排编辑视图往返保留原文字、公式、空行与未经编辑的 LaTeX', () => {
  for (const source of [
    '',
    '中文正文\n第二行\n\n',
    '速度 $\\frac{p}{m}$，$x^{2}$。',
    '$$\\int_0^1 x dx\n=1/2$$\n说明',
    '```math\n x^2 + 1 \n```',
    String.raw`未知 $\unknown{x}$ 保留`
  ]) {
    assert.equal(mathEditorText(mathEditorDocument(source)), source)
  }
  const mixed = mathEditorDocument('正文 $x$ 尾文')
  assert.equal(mixed.content[0].content[1].type, 'visualMath')
  assert.equal(mixed.content[0].content[1].attrs.latex, 'x')
})
test('代码、转义金额、未闭合美元符和 HTML 保持原文字', () => {
  for (const source of [
    '`$x$`',
    '```js\nconst x="$x$"\n```',
    String.raw`价格 \$20，未闭合 $x`,
    '<img src=x onerror=alert(1)>',
    '$' + 'x'.repeat(4001) + '$'
  ]) {
    assert.equal(
      mathTokens(source).some((t) => t.type === 'formula'),
      false
    )
    assert.equal(mathEditorText(mathEditorDocument(source)), source)
  }
})
test('编辑后按既有公式边界输出，清除仅供光标使用的空占位符', () => {
  assert.equal(
    mathEditorText({ type: 'visualMath', attrs: { latex: String.raw`\frac{p}{m}`, source: null } }),
    String.raw`$\frac{p}{m}$`
  )
  assert.equal(
    mathEditorText({
      type: 'visualMath',
      attrs: { latex: String.raw`\frac{\placeholder{}}{m}`, display: true }
    }),
    String.raw`$$\frac{}{m}$$`
  )
  assert.equal(
    mathEditorText({
      type: 'paragraph',
      content: [{ type: 'text', text: '甲' }, { type: 'hardBreak' }, { type: 'text', text: '乙' }]
    }),
    '甲\n乙'
  )
})
