import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const OFFICE_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting">
<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
<prop oor:name="SecureURL" oor:op="fuse"><value/></prop>
<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
</item></oor:items>`

/** 仅清理由本模块在指定根内建立的随机任务目录。 */
export async function cleanOfficeAttempt(root: string, directory: string): Promise<void> {
  const rel = relative(resolve(root), resolve(directory))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('转换临时目录越界')
  await rm(directory, { recursive: true, force: true })
}
function stopTree(pid: number): Promise<void> {
  if (process.platform === 'win32') return new Promise(resolve => {
    execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => resolve())
  })
  try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ }
  return Promise.resolve()
}
export function officeProcess(executable: string, args: string[], signal: AbortSignal, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', reason: Error | undefined, killing: Promise<void> | undefined
    const terminate = (error: Error): void => {
      if (reason) return
      reason = error
      if (child.pid) killing = stopTree(child.pid).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    }
    const abort = (): void => terminate(new Error('转换已取消'))
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => terminate(new Error(timeout === 120_000 ? '转换超过两分钟，请拆分或另存为 DOCX/PPTX 后导入' : '转换程序响应超时，请检查 LibreOffice 是否可运行')), timeout)
    const collect = (bytes: Buffer): void => {
      const text = bytes.toString('utf8')
      if (output.length + text.length > 64_000) terminate(new Error('转换程序输出异常过多'))
      output = (output + text).slice(0, 64_000)
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', error => { reason = reason ?? error })
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      void (async () => {
        await killing
        if (reason) reject(reason)
        else if (code !== 0) reject(new Error(`转换程序退出（${code}），请检查文件是否损坏或加密`))
        else resolve(output.trim())
      })()
    })
  })
}
export async function convertOffice(executable: string, input: string, format: 'doc' | 'ppt', root: string, signal: AbortSignal): Promise<{ file: string; format: 'docx' | 'pptx'; engine: string; directory: string }> {
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'attempt-'))
  try {
    const profile = join(directory, 'profile'), out = join(directory, 'output')
    await mkdir(join(profile, 'user'), { recursive: true }); await mkdir(out)
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), OFFICE_PROFILE)
    const engine = (await officeProcess(executable, ['--version'], signal, 15_000)).slice(0, 300)
    if (!/LibreOffice/i.test(engine)) throw new Error('请选择 LibreOffice 的 soffice 程序')
    const target = format === 'doc' ? 'docx' : 'pptx'
    await officeProcess(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', target === 'docx' ? 'docx:Office Open XML Text' : 'pptx:Impress MS PowerPoint 2007 XML', '--outdir', out, input], signal)
    const file = join(out, `source.${target}`), info = await stat(file).catch(() => null)
    if (!info?.isFile() || !info.size || info.size > 50 * 1024 * 1024) throw new Error('转换未产生有效且小于 50 MiB 的文件，可能损坏、加密或不受支持')
    const bytes = await readFile(file)
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('转换结果不是有效的 Office 压缩文档')
    if (signal.aborted) throw new Error('转换已取消')
    return { file, format: target, engine, directory }
  } catch (error) { await cleanOfficeAttempt(root, directory); throw error }
}
