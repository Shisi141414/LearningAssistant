import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeDb } from '../src/main/services/db.ts'
import { PPOCR_PRESETS, ppocrEngineVersion, ppocrModelDirectory, ppocrModelPaths, ppocrStatus, presetForLanguage } from '../src/main/services/ppocr-models.ts'
import { recognizeByPix2Text, recognizeMaterial } from '../src/main/services/material-ocr.ts'

after(closeDb)
test('PP-OCR 从实际安装入口读取版本，避免未导出子路径；语言路由明确', async () => {
  const require = createRequire(import.meta.url)
  const installed = JSON.parse(await readFile(join(require.resolve('ppu-paddle-ocr'), '..', 'package.json'), 'utf8'))
  assert.equal(await ppocrEngineVersion(), installed.version)
  assert.equal(presetForLanguage(), 'v6-tiny')
  assert.equal(presetForLanguage('ja'), 'v5-ja')
  assert.equal(presetForLanguage('ko'), 'v5-ko')
  assert.equal(presetForLanguage('latin'), 'v5-latin')
  assert.doesNotMatch(PPOCR_PRESETS['v5-latin'].label, /俄/)
})

test('队列运行前重新校验模型，损坏和 LFS 指针不能冒充已就绪', async () => {
  const dir = ppocrModelDirectory('v6-tiny')
  await mkdir(dir, { recursive: true })
  for (const rel of Object.values(PPOCR_PRESETS['v6-tiny'].files)) {
    const file = join(dir, rel.split('/').pop()), bytes = Buffer.alloc(2048, 1)
    await writeFile(file, bytes)
    await writeFile(file + '.sha256', createHash('sha256').update(bytes).digest('hex'))
  }
  const paths = await ppocrModelPaths('v6-tiny')
  assert.equal((await ppocrStatus()).presets[0].ready, true)
  await writeFile(paths.recognition, 'damaged')
  await assert.rejects(ppocrModelPaths('v6-tiny'), /未就绪/)
  const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64))
  await writeFile(paths.recognition, pointer)
  await writeFile(paths.recognition + '.sha256', createHash('sha256').update(pointer).digest('hex'))
  assert.equal((await ppocrStatus()).presets[0].ready, false)
  await assert.rejects(ppocrModelPaths('v6-tiny'), /未就绪/)
})

test('缺少所选引擎配置时明确失败，不静默切换 Tesseract', async () => {
  const input = { version_id: 'v', from_page: 1, to_page: 1 }
  await assert.rejects(recognizeMaterial('unused', input, '', '', () => {}), /PP-OCR 模型未就绪/)
  await assert.rejects(recognizeMaterial('unused', { ...input, engine: 'pix2text' }, '', '', () => {}), /公式识别服务未就绪/)
})

test('Pix2Text embedding/isolated 正确生成 LaTeX，分数来自返回值', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, blocks: [
    { type: 'text', text: '能量', position: [0, 0, 30, 20], score: 0.6 },
    { type: 'embedding', text: 'E=mc^2', position: [35, 0, 100, 20], score: 0.8 },
    { type: 'isolated', text: 'Q=U+W', position: [0, 40, 100, 60], score: 0.4 }
  ] })))
  const result = await recognizeByPix2Text('http://localhost', Buffer.from('png'))
  assert.equal(result.text, '能量$E=mc^2$\n$$Q=U+W$$')
  assert.ok(Math.abs(result.confidence - 60) < 0.0001)
  assert.equal(result.lines[0].confidence, 70)
  assert.equal(result.lines[1].confidence, 40)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, blocks: 'wrong API' })))
  await assert.rejects(recognizeByPix2Text('http://localhost', Buffer.from('png')), /识别失败/)
})
