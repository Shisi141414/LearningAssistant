import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { closeDb } from '../src/main/services/db.ts'
import { assertIdle } from '../src/main/services/work.ts'
import { ensurePix2TextSidecar, pix2textStatus, retainPix2TextSidecar, stopPix2TextSidecar } from '../src/main/services/pix2text.ts'

after(closeDb)
function fakePython(t, options = {}) {
  const children = []
  t.mock.method(cp, 'spawn', (_cmd, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, kills: 0 })
    child.kill = () => { child.kills++; child.exitCode = 1; queueMicrotask(() => { child.emit('exit', 1); child.emit('close', 1) }); return true }
    queueMicrotask(() => {
      if (args[0] === '-c') {
        const result = args[1].includes('sys.version') ? '3.14.0\n' : `pix2text=1.1.7\ncnocr=2.3.3\ncnstd=1.2.8\nrapidocr=${options.rapidocr || '3.9.1'}\n`
        child.stdout.emit('data', result); child.exitCode = 0; child.emit('close', 0)
      } else {
        children.push(child)
        options.onSpawn?.(child)
        child.stderr.emit('data', 'Recovered Error warning, not fatal\n')
        if (!options.hang) child.stdout.emit('data', '{"port":12345}\n')
      }
    })
    return child
  })
  syncBuiltinESMExports()
  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}'))
  t.after(() => { stopPix2TextSidecar(); t.mock.restoreAll(); syncBuiltinESMExports() })
  return children
}

test('sidecar 并发启动复用，长任务不被空闲回收；释放后回收并清理计时器', async t => {
  const children = fakePython(t)
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
  const release = retainPix2TextSidecar()
  t.after(release)
  const urls = await Promise.all([ensurePix2TextSidecar(), ensurePix2TextSidecar()])
  assert.equal(urls[0], urls[1]); assert.equal(children.length, 1)
  t.mock.timers.tick(10 * 60_000)
  assert.equal((await pix2textStatus()).sidecarRunning, true)
  assert.equal(children[0].kills, 0)
  release(); release()
  t.mock.timers.tick(6 * 60_000)
  assert.equal((await pix2textStatus()).sidecarRunning, false)
  assert.equal(children[0].kills, 1)
  assertIdle()
})

test('启动超时必须结束未报告端口的 Python 子进程并释放工作锁', async t => {
  let spawned
  const ready = new Promise(resolve => { spawned = resolve })
  const children = fakePython(t, { hang: true, onSpawn: spawned })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starting = ensurePix2TextSidecar()
  const rejected = assert.rejects(starting, /启动超时/)
  await ready
  t.mock.timers.tick(30_001)
  await rejected
  assert.equal(children[0].kills, 1)
  assert.equal((await pix2textStatus()).sidecarRunning, false)
  assertIdle()
})

test('已确认的不兼容版本组合不能显示为环境就绪', async t => {
  fakePython(t, { rapidocr: '3.10.0' })
  const status = await pix2textStatus()
  assert.equal(status.pix2text, true)
  assert.match(status.issue, /resolve_model_key/)
  await assert.rejects(ensurePix2TextSidecar(), /不兼容/)
  assertIdle()
})
