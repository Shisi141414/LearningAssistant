// Background GUI probes must not inherit a terminal pipe with a shorter lifetime.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

async function launchElectronBackground(script, args = [], options = {}) {
  const cwd = path.resolve(options.cwd || path.join(__dirname, '..'))
  const entry = path.resolve(cwd, script)
  if (!fs.statSync(entry).isFile()) throw new Error('验收入口不是文件')
  const base = path.resolve(options.outputDir || path.join(cwd, 'out-tmp'))
  fs.mkdirSync(base, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(base, 'electron-background-'))
  const logFile = path.join(runDir, 'runtime.log')
  const descriptor = fs.openSync(logFile, 'a', 0o600)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let child
  try {
    child = spawn(options.executable || require('electron'), [entry, ...args], {
      cwd,
      env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', descriptor, descriptor]
    })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', resolve)
    })
    const result = { pid: child.pid, runDir, logFile }
    // Keep the PID available without recording arguments (which may be private).
    fs.writeFileSync(path.join(runDir, 'process.json'), JSON.stringify(result))
    child.unref()
    return result
  } catch (error) {
    if (child?.pid) child.kill()
    throw error
  } finally {
    // The child owns a duplicated file handle; closing ours does not close its log.
    fs.closeSync(descriptor)
  }
}

module.exports = { launchElectronBackground }

if (require.main === module) {
  const [script, ...args] = process.argv.slice(2)
  if (!script) {
    console.error(
      '用法：node scripts/launch-electron-background.cjs <验收脚本> [参数]'
    )
    process.exitCode = 1
  } else {
    launchElectronBackground(script, args).then(
      (result) => console.log(JSON.stringify(result)),
      (error) => {
        console.error('验收程序启动失败：' + (error.code || error.message))
        process.exitCode = 1
      }
    )
  }
}
