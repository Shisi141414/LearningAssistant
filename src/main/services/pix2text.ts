/**
 * services/pix2text.ts —— Pix2Text 公式识别 sidecar（Python 子进程）管理
 *
 * 架构（docs/01-research 第二轮：公式识别选 Pix2Text MFR，Mathpix 开源替代）：
 *  - 主进程把内嵌 Python 脚本写到 userData，spawn `python` 起常驻 HTTP sidecar
 *    （仅绑 127.0.0.1 随机端口，stdout 首行回报端口）
 *  - Pix2Text 模型在首个识别请求时懒加载（首次含下载，请求超时给足）
 *  - OCR worker 线程直接 POST 侧车；主进程负责生命周期与空闲回收
 *  - 用户前置：本机 Python 3.8+ 且 pip install pix2text（UI 给出指引）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { configGet } from './config'
import { withWork } from './work'

export interface Pix2TextStatus {
  python: boolean
  pythonDetail: string
  pix2text: boolean
  pix2textVersion: string | null
  sidecarRunning: boolean
  /** 依赖链健康问题（人话+修复命令）；null 表示健康或 python/pix2text 本身缺失（走通用指引） */
  issue: string | null
}

/** 内嵌 sidecar 脚本（版本随代码演进，落盘到 userData 执行） */
export const SIDECAR_PY = `import base64, io, json, sys, threading
from importlib.metadata import version
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

_model = None
_recognize_lock = threading.Lock()

def get_model():
    global _model
    if _model is None:
        from pix2text import TextFormulaOCR
        _model = TextFormulaOCR.from_config()
    return _model

def normalize_position(pos):
    try:
        pts = [(float(p[0]), float(p[1])) for p in pos]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]
    except Exception:
        return None

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ping':
            try:
                package_version = version('pix2text')
            except Exception:
                package_version = ''
            self.send_json({'ok': True, 'version': package_version})
        else:
            self.send_json({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        if self.path != '/recognize':
            return self.send_json({'ok': False, 'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 40 * 1024 * 1024:
                return self.send_json({'ok': False, 'error': 'invalid image request size'}, 413)
            req = json.loads(self.rfile.read(length).decode('utf-8'))
            img = Image.open(io.BytesIO(base64.b64decode(req['image_b64'])))
            with _recognize_lock:
                outs = get_model().recognize(img.convert('RGB'), return_text=False)
            if not isinstance(outs, list) or any(not isinstance(item, dict) for item in outs):
                raise TypeError('Pix2Text must return structured blocks')
            blocks = []
            for item in outs:
                if isinstance(item, dict):
                    blocks.append({
                        'type': str(item.get('type', 'text')),
                        'text': str(item.get('text', '') or ''),
                        'position': normalize_position(item.get('position')),
                        'score': float(item.get('score', 0)),
                    })
            self.send_json({'ok': True, 'blocks': blocks})
        except Exception as e:
            self.send_json({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, 500)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    print(json.dumps({'port': server.server_port}), flush=True)
    server.serve_forever()
`

let sidecar: { child: ChildProcess; port: number; startedAt: number } | null = null
let lastUsedAt = 0
const IDLE_SHUTDOWN_MS = 5 * 60_000
let idleTimer: ReturnType<typeof setInterval> | null = null
let users = 0
let pendingChild: ChildProcess | null = null
let starting: Promise<string> | null = null
let generation = 0

/** 工作期间持有引用；仅完成后的空闲服务参与五分钟回收。 */
export function retainPix2TextSidecar(): () => void {
  users++
  let released = false
  return () => { if (!released) { released = true; users--; lastUsedAt = Date.now() } }
}
/** 已解析可用的解释器（pythonCandidates 首次命中后缓存，sidecar 复用同一解释器） */
let resolvedCommand: { cmd: string; base: string[] } | null = null

function pythonCandidates(): Array<{ cmd: string; base: string[] }> {
  const custom = configGet('p2t.pythonPath')
  if (custom) return [{ cmd: custom, base: [] }]
  if (resolvedCommand) return [resolvedCommand]
  // Windows 常见 py 启动器；Linux/macOS 为 python3。逐个探测取首个可用。
  return [{ cmd: 'python', base: [] }, { cmd: 'py', base: [] }, { cmd: 'python3', base: [] }]
}

function runPython(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { cmd, base } = resolvedCommand ?? pythonCandidates()[0]
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [...base, ...args], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout?.on('data', (d) => { stdout += String(d) })
      child.stderr?.on('data', (d) => { stderr += String(d) })
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) })
    }
  })
}

/** 环境检测：解释器逐个探测；包状态查 importlib.metadata（毫秒级）。
 *  注意不能用 `import pix2text` 检测——那会加载 torch，冷启动数十秒，
 *  曾被 20s 超时误判为"未安装"，导致装好了也显示未就绪。 */
export async function pix2textStatus(): Promise<Pix2TextStatus> {
  const candidates = pythonCandidates()
  let lastDetail = ''
  for (const candidate of candidates) {
    const detail = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      try {
        const child = spawn(candidate.cmd, [...candidate.base, '-c', 'import sys; print(sys.version.split()[0])'], { windowsHide: true })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => child.kill(), 15_000)
        child.stdout?.on('data', (d) => { stdout += String(d) })
        child.stderr?.on('data', (d) => { stderr += String(d) })
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }) })
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
      } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e) }) }
    })
    if (detail.code !== 0 || !/^\d+\.\d+/.test(detail.stdout.trim())) {
      lastDetail = detail.code === -1 ? `未找到 ${candidate.cmd} 命令` : `${candidate.cmd} 不可用：${(detail.stderr || detail.stdout).trim().slice(0, 120)}`
      continue
    }
    resolvedCommand = candidate
    // 一次 spawn 查全依赖链元数据（毫秒级、不加载 torch）。
    // 背景：pix2text → cnocr(新版) → rapidocr>=3.9.1；rapidocr 旧版没有
    // resolve_model_key，出现"装了 pix2text 但识别即 ImportError"的错位
    // （用户 Python 3.14 上 pip 解析出旧 rapidocr 实测踩中，2026-11）。
    const pkg = await runPython(['-c', "import importlib.metadata as m\nfor name in ('pix2text','cnocr','cnstd','rapidocr'):\n    try: print(name + '=' + m.version(name))\n    except Exception: print(name + '=MISSING')"], 20_000)
    const found: Record<string, string> = {}
    for (const line of pkg.stdout.split('\n')) {
      const match = /^(\w+)=(.+)$/.exec(line.trim())
      if (match) found[match[1]] = match[2]
    }
    const p2tOk = !!found.pix2text && found.pix2text !== 'MISSING'
    let issue: string | null = null
    if (p2tOk) {
      if (!found.cnocr || found.cnocr === 'MISSING' || !found.cnstd || found.cnstd === 'MISSING' || !found.rapidocr || found.rapidocr === 'MISSING') {
        issue = 'pix2text 依赖不完整（缺 cnocr、cnstd 或 rapidocr），请在选定的 Python 环境中重新安装 pix2text 并检查依赖'
      } else if (found.cnstd === '1.2.8' && found.rapidocr === '3.10.0') {
        // 本机复现：CnSTD 1.2.8 导入 resolve_model_key，而 RapidOCR 3.10 已移除它。
        // 仅限制已确认的组合，不能把所有新版一律判错或建议无条件升级。
        issue = `CnSTD 1.2.8 与 rapidocr ${found.rapidocr} 的接口不兼容（缺 resolve_model_key）。请使用独立 Python 环境安装 rapidocr>=3.9.1,<3.10 后重试，或等待上游适配；不要直接升级系统环境`
      } else if ((found.cnstd === '1.2.8' || found.cnocr === '2.3.3') && versionLt(found.rapidocr, '3.9.1')) {
        issue = `rapidocr ${found.rapidocr} 与当前 CnSTD/CnOCR 不兼容。请在独立 Python 环境安装 rapidocr>=3.9.1,<3.10 后重试`
      }
    }
    return {
      python: true,
      pythonDetail: `Python ${detail.stdout.trim()}（${candidate.cmd}）`,
      pix2text: p2tOk,
      pix2textVersion: p2tOk ? found.pix2text ?? null : null,
      sidecarRunning: !!sidecar,
      issue
    }
  }
  return { python: false, pythonDetail: lastDetail || '未找到可用的 python 命令（安装 Python 3.8+ 并加入 PATH；Windows 也可用 py 启动器）', pix2text: false, pix2textVersion: null, sidecarRunning: !!sidecar, issue: null }
}

/** 语义化版本比较：a < b（仅数字段，缺失段按 0） */
function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

async function sidecarScriptPath(): Promise<string> {
  const dir = join(app.getPath('userData'), 'sidecar')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'pix2text_sidecar.py')
  await writeFile(file, SIDECAR_PY, 'utf-8')
  return file
}

/** 确保 sidecar 运行（幂等）。返回 base URL；失败给出可操作指引。 */
export async function ensurePix2TextSidecar(): Promise<string> {
  starting ??= startPix2TextSidecar().finally(() => { starting = null })
  return starting
}

async function startPix2TextSidecar(): Promise<string> {
  const epoch = generation
  if (sidecar) {
    lastUsedAt = Date.now()
    return `http://127.0.0.1:${sidecar.port}`
  }
  const status = await pix2textStatus()
  if (!status.python) throw new Error(status.pythonDetail)
  if (!status.pix2text) throw new Error('本机 Python 未安装 pix2text 包。请在终端执行：python -m pip install pix2text -i https://pypi.tuna.tsinghua.edu.cn/simple，完成后再试')
  if (status.issue) throw new Error(status.issue)

  return withWork('公式识别服务启动', async () => {
    if (sidecar) { lastUsedAt = Date.now(); return `http://127.0.0.1:${sidecar.port}` }
    const script = await sidecarScriptPath()
    if (epoch !== generation) throw new Error('公式识别服务启动已取消')
    // pix2textStatus 已解析并缓存可用解释器；兜底 custom/python
    const { cmd, base } = resolvedCommand ?? { cmd: configGet('p2t.pythonPath') ?? 'python', base: [] as string[] }
    const child = spawn(cmd, [...base, script], { windowsHide: true })
    pendingChild = child
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      let settled = false
      let stderr = ''
      const fail = (msg: string): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); if (pendingChild === child) pendingChild = null; reject(new Error(msg)) }
      const timer = setTimeout(() => fail('sidecar 启动超时'), 30_000)
      child.stdout?.on('data', (d) => {
        out += String(d)
        const m = /"port"\s*:\s*(\d+)/.exec(out)
        if (m && !settled) { settled = true; clearTimeout(timer); resolve(parseInt(m[1], 10)) }
      })
      child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-2000) })
      child.on('error', (e) => fail(`无法启动 python：${e.message}`))
      child.on('close', (code) => fail(`sidecar 进程退出（${code}）：${stderr.trim().slice(-500)}`))
    })
    pendingChild = null
    if (epoch !== generation || child.exitCode !== null) { child.kill(); throw new Error('公式识别服务启动已取消或退出') }
    sidecar = { child, port, startedAt: Date.now() }
    lastUsedAt = Date.now()
    child.on('exit', () => { if (sidecar?.child === child) sidecar = null })

    // 健康检查（仅确认 HTTP 通；模型懒加载在首请求）
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ ok: boolean }>).catch(() => null)
    if (!res?.ok || epoch !== generation || sidecar?.child !== child) {
      stopPix2TextSidecar()
      throw new Error('公式识别服务健康检查失败')
    }
    startIdleWatch()
    return `http://127.0.0.1:${port}`
  })
}

function startIdleWatch(): void {
  if (idleTimer) return
  idleTimer = setInterval(() => {
    if (!users && sidecar && Date.now() - lastUsedAt > IDLE_SHUTDOWN_MS) stopPix2TextSidecar()
  }, 60_000)
  idleTimer.unref()
}

export function stopPix2TextSidecar(): void {
  generation++
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
  try { pendingChild?.kill(); sidecar?.child.kill() } catch { /* ignore */ }
  pendingChild = null
  sidecar = null
}
