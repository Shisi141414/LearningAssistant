import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchElectronBackground } from './launch-electron-background.cjs'

const launcher = path.resolve('scripts/launch-electron-background.cjs')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('真实 Electron 在启动器退出后仍能写日志和状态，无 EPIPE', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'learning-assistant-pipe-')
  )
  const fixture = path.join(root, 'probe with spaces.cjs')
  const release = path.join(root, 'parent-exited')
  const status = path.join(root, 'status.json')
  fs.writeFileSync(
    fixture,
    `
    const {app}=require('electron'),fs=require('node:fs');
    app.disableHardwareAcceleration();
    app.setPath('userData',process.argv[2]);
    process.on('uncaughtException',error=>{
      fs.writeFileSync(process.argv[4],JSON.stringify({error:error.code||error.name}));
      app.exit(1);
    });
    app.whenReady().then(()=>{
      const deadline=Date.now()+10000;
      const timer=setInterval(()=>{
        if(Date.now()>deadline)app.exit(2);
        if(!fs.existsSync(process.argv[3]))return;
        clearInterval(timer);
        console.log('console after parent exit');
        process.stdout.write('stdout after parent exit\\n');
        process.stderr.write('stderr after parent exit\\n');
        setTimeout(()=>{
          fs.writeFileSync(process.argv[4],JSON.stringify({state:'verified'}));
          app.exit(0);
        },100);
      },20);
    });
  `
  )
  const result = spawnSync(
    process.execPath,
    [launcher, fixture, root, release, status],
    {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000
    }
  )
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const run = JSON.parse(result.stdout.trim())
  assert.ok(run.pid > 0)
  assert.ok(fs.existsSync(run.logFile))
  try {
    fs.writeFileSync(release, 'launcher has exited')
    const deadline = Date.now() + 15000
    while (!fs.existsSync(status) && Date.now() < deadline) await delay(40)
    assert.ok(fs.existsSync(status), fs.readFileSync(run.logFile, 'utf8'))
    assert.deepEqual(JSON.parse(fs.readFileSync(status, 'utf8')), {
      state: 'verified'
    })
    const log = fs.readFileSync(run.logFile, 'utf8')
    assert.match(log, /console after parent exit/)
    assert.match(log, /stdout after parent exit/)
    assert.match(log, /stderr after parent exit/)
    assert.doesNotMatch(log, /EPIPE/)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(run.runDir, 'process.json'))),
      run
    )
  } finally {
    // Only the exact process started by this isolated fixture may be stopped.
    try {
      process.kill(run.pid)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
})

test('入口或可执行文件不存在时明确失败，不伪报已启动', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'learning-assistant-launch-')
  )
  await assert.rejects(
    launchElectronBackground(path.join(root, 'absent.cjs')),
    { code: 'ENOENT' }
  )
  const fixture = path.join(root, 'probe.cjs')
  fs.writeFileSync(fixture, '')
  await assert.rejects(
    launchElectronBackground(fixture, [], {
      outputDir: root,
      executable: path.join(root, 'absent.exe')
    }),
    { code: 'ENOENT' }
  )
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('electron-background-')) {
      assert.equal(fs.existsSync(path.join(root, entry, 'process.json')), false)
    }
  }
})
