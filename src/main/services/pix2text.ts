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
}

/** 内嵌 sidecar 脚本（版本随代码演进，落盘到 userData 执行） */
const SIDECAR_PY = `import base64, io, json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

_model = None

def get_model():
    global _model
    if _model is None:
        from pix2text import Pix2Text
        _model = Pix2Text()
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
                import pix2text
                version = getattr(pix2text, '__version__', '')
            except Exception:
                version = ''
            self.send_json({'ok': True, 'version': version})
        else:
            self.send_json({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        if self.path != '/recognize':
            return self.send_json({'ok': False, 'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            req = json.loads(self.rfile.read(length).decode('utf-8'))
            img = Image.open(io.BytesIO(base64.b64decode(req['image_b64'])))
            outs = get_model().recognize(img)
            blocks = []
            for item in outs:
                if isinstance(item, dict):
                    blocks.append({
                        'type': str(item.get('type', 'text')),
                        'text': str(item.get('text', '') or ''),
                        'position': normalize_position(item.get('position')),
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
    const pkg = await runPython(['-c', 'import importlib.metadata as m; print(m.version("pix2text"))'], 20_000)
    const p2tOk = pkg.code === 0 && /^\d/.test(pkg.stdout.trim())
    return {
      python: true,
      pythonDetail: `Python ${detail.stdout.trim()}（${candidate.cmd}）`,
      pix2text: p2tOk,
      pix2textVersion: p2tOk ? pkg.stdout.trim() : null,
      sidecarRunning: !!sidecar
    }
  }
  return { python: false, pythonDetail: lastDetail || '未找到可用的 python 命令（安装 Python 3.8+ 并加入 PATH；Windows 也可用 py 启动器）', pix2text: false, pix2textVersion: null, sidecarRunning: !!sidecar }
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
  if (sidecar) {
    lastUsedAt = Date.now()
    return `http://127.0.0.1:${sidecar.port}`
  }
  const status = await pix2textStatus()
  if (!status.python) throw new Error(status.pythonDetail)
  if (!status.pix2text) throw new Error('本机 Python 未安装 pix2text 包。请在终端执行：pip install pix2text（清华源：pip install pix2text -i https://pypi.tuna.tsinghua.edu.cn/simple），完成后再试')

  return withWork('公式识别服务启动', async () => {
    if (sidecar) { lastUsedAt = Date.now(); return `http://127.0.0.1:${sidecar.port}` }
    const script = await sidecarScriptPath()
    // pix2textStatus 已解析并缓存可用解释器；兜底 custom/python
    const { cmd, base } = resolvedCommand ?? { cmd: configGet('p2t.pythonPath') ?? 'python', base: [] as string[] }
    const child = spawn(cmd, [...base, script], { windowsHide: true })
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      const fail = (msg: string): void => { clearTimeout(timer); reject(new Error(msg)) }
      const timer = setTimeout(() => fail('sidecar 启动超时'), 30_000)
      child.stdout?.on('data', (d) => {
        out += String(d)
        const m = /"port"\s*:\s*(\d+)/.exec(out)
        if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)) }
      })
      child.stderr?.on('data', (d) => { const s = String(d); if (/Error|Traceback/i.test(s)) fail(`sidecar 启动失败：${s.trim().slice(0, 200)}`) })
      child.on('error', (e) => fail(`无法启动 python：${e.message}`))
      child.on('close', (code) => fail(`sidecar 进程退出（${code}）`))
    })
    sidecar = { child, port, startedAt: Date.now() }
    lastUsedAt = Date.now()
    child.on('exit', () => { sidecar = null })

    // 健康检查（仅确认 HTTP 通；模型懒加载在首请求）
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ ok: boolean }>).catch(() => null)
    if (!res?.ok) {
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
    if (sidecar && Date.now() - lastUsedAt > IDLE_SHUTDOWN_MS) stopPix2TextSidecar()
  }, 60_000)
}

export function stopPix2TextSidecar(): void {
  if (!sidecar) return
  try { sidecar.child.kill() } catch { /* ignore */ }
  sidecar = null
}
