import { test } from 'node:test'
import assert from 'node:assert/strict'
import katex from 'katex'
import { convertLatexToMathMl } from 'mathlive/ssr'
import { MATH_PALETTES } from '../shared/mathPalette.ts'

test('希腊大小写键数量与位置逐一对应，保留 phi 变体位置', () => {
  const lower = MATH_PALETTES.find((g) => g.key === 'greek-lower').symbols
  const upper = MATH_PALETTES.find((g) => g.key === 'greek-upper').symbols
  assert.equal(lower.length, 24)
  assert.equal(upper.length, lower.length)
  lower.forEach((key, index) => assert.equal(upper[index].label, key.label.toUpperCase()))
  for (const key of [...lower, ...upper]) {
    assert.doesNotThrow(() => katex.renderToString(key.latex, { throwOnError: true }))
  }
  for (const key of upper) assert.match(convertLatexToMathMl(key.latex), new RegExp(key.label))
})
