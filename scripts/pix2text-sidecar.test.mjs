import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile, access } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { dataRoot } from './test-support.mjs'
import { SIDECAR_PY } from '../src/main/services/pix2text.ts'

// 实际 Python HTTP 进程 + 伪识别器验证适配协议，不下载模型；不作为模型准确率证据。
test('Python sidecar: ping 不导入模型，结构化参数、并发串行、公式和错误保留', async t => {
  const python = process.env.OCR_TEST_PYTHON
  if (!python) return t.skip('设置 OCR_TEST_PYTHON 后执行真实 Python 协议验收')
  const marker = join(dataRoot, 'model-imported')
  await writeFile(join(dataRoot, 'pix2text.py'), `from pathlib import Path
import time
Path(${JSON.stringify(marker)}).touch()
class TextFormulaOCR:
    busy = False
    @classmethod
    def from_config(cls): return cls()
    def recognize(self, img, return_text=True):
        assert return_text is False, 'must request structured blocks'
        assert not self.busy, 'concurrent inference'
        self.busy = True
        time.sleep(0.05)
        self.busy = False
        return [{'type': 'embedding', 'text': 'x^2', 'score': 0.75, 'position': [[1,2],[3,2],[3,4],[1,4]]}]
`)
  const script = join(dataRoot, 'sidecar.py')
  await writeFile(script, SIDECAR_PY)
  const child = spawn(python, [script], { windowsHide: true })
  let err = ''
  child.stderr.on('data', data => { err += data })
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'close') } })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('sidecar timeout: ' + err)), 15000)
    let out = ''
    child.stdout.on('data', data => { out += data; const m = /"port":\s*(\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('exit', code => { clearTimeout(timer); reject(Error('sidecar exited ' + code + ': ' + err)) })
  })
  const url = `http://127.0.0.1:${port}`
  assert.equal((await (await fetch(url + '/ping')).json()).ok, true)
  await assert.rejects(access(marker), { code: 'ENOENT' })
  const image_b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOCkAAAAASUVORK5CYII='
  const request = async image => (await fetch(url + '/recognize', { method: 'POST', body: JSON.stringify({ image_b64: image }) })).json()
  const results = await Promise.all([request(image_b64), request(image_b64)])
  for (const result of results) {
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.blocks[0], { type: 'embedding', text: 'x^2', position: [1, 2, 3, 4], score: 0.75 })
  }
  const invalid = await request('invalid image')
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /Error|image/i)
})
