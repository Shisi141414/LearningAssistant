/**
 * services/asr.ts —— 本地流式语音识别（课堂模式核心，M1a）
 *
 * 架构（docs/01-research.md §3，ADR-0 本地优先）：
 *  - sherpa-onnx-node + 流式 zipformer-transducer 模型（支持热词）
 *  - 端点检测（endpoint rules）自动分段：partial 实时上屏，final 落段
 *  - M1b 计划：2-pass 离线精转修正（cueflow 式）、讯飞云端 Provider
 *
 * 音频链路：渲染进程麦克风采集 16kHz PCM → IPC → feed() → 本服务。
 */
import { app } from 'electron'
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'
import type { OnlineRecognizer, OnlineStream } from 'sherpa-onnx-node'

const SAMPLE_RATE = 16000

export interface AsrEvents {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
}

export interface AsrModelFiles {
  enc: string
  dec: string
  join: string
  tokens: string
}

/** 在模型目录中探测流式 zipformer transducer 四件套（优先 int8 量化版）。
 *  兼容官方 Release 两种命名：encoder-epoch-99-avg-1(.int8).onnx 与 enc(.int8).onnx */
export function findModelFiles(dir: string): { files: AsrModelFiles } | { missing: string[] } {
  if (!existsSync(dir)) return { missing: ['目录不存在'] }
  const names = readdirSync(dir)
  // 按角色前缀 + .onnx 后缀匹配，int8 量化版优先（体积小、CPU 快、精度损失极小）
  const fuzzy = (prefix: string): string | null => {
    const hits = names
      .filter((n) => n.startsWith(prefix) && /\.onnx$/.test(n))
      .map((n) => ({ path: join(dir, n), quantized: n.includes('.int8.') }))
      .sort((a, b) => (a.quantized === b.quantized ? 0 : a.quantized ? -1 : 1))
    return hits[0]?.path ?? null
  }
  const enc = fuzzy('enc') // encoder-*.onnx / enc*.onnx
  const dec = fuzzy('dec') // decoder-*.onnx / dec*.onnx
  const joiner = fuzzy('join') // joiner-*.onnx / join*.onnx
  const tokens = names.includes('tokens.txt') ? join(dir, 'tokens.txt') : null
  const missing: string[] = []
  if (!enc) missing.push('encoder*.onnx（如 encoder-epoch-99-avg-1.int8.onnx）')
  if (!dec) missing.push('decoder*.onnx')
  if (!joiner) missing.push('joiner*.onnx')
  if (!tokens) missing.push('tokens.txt')
  if (missing.length > 0) return { missing }
  return { files: { enc, dec, join: joiner, tokens } as AsrModelFiles }
}

/** sherpa-onnx-node 是否已安装（动态探测，给设置页状态用） */
export async function checkSherpaInstalled(): Promise<{ installed: boolean; error?: string }> {
  try {
    await import('sherpa-onnx-node')
    return { installed: true }
  } catch (e) {
    return { installed: false, error: e instanceof Error ? e.message : String(e) }
  }
}

class AsrService {
  private recognizer: OnlineRecognizer | null = null
  private stream: OnlineStream | null = null
  private events: AsrEvents | null = null
  private lastText = ''

  get running(): boolean {
    return this.recognizer !== null
  }

  /** 启动识别器。hotwords 每行一个词，写入临时文件传给引擎（transducer 系支持）。 */
  async start(opts: { modelDir: string; hotwords?: string; events: AsrEvents }): Promise<void> {
    if (this.running) throw new Error('识别器已在运行')
    const found = findModelFiles(opts.modelDir)
    if ('missing' in found) throw new Error(`模型目录缺少文件：${found.missing.join('、')}（目录：${opts.modelDir}）`)

    const mod = await import('sherpa-onnx-node')

    let hotwordsFile = ''
    if (opts.hotwords && opts.hotwords.trim()) {
      hotwordsFile = join(app.getPath('userData'), 'hotwords.txt')
      writeFileSync(hotwordsFile, opts.hotwords.trim(), 'utf-8')
    }

    // sherpa-onnx-node v2 配置（以 node_modules/sherpa-onnx-node/types.js 为准）：
    //  - transducer 字段名 encoder/decoder/joiner（v1 为 enc/dec/join）
    //  - endpoint 扁平化：enableEndpoint + ruleN*（v1 为嵌套 endpointConfig）
    const config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: found.files.enc, decoder: found.files.dec, joiner: found.files.join },
        tokens: found.files.tokens,
        numThreads: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
        debug: 0,
        provider: 'cpu'
      },
      // 热词需 modified_beam_search 解码；无热词用 greedy_search 更快
      decodingMethod: hotwordsFile ? 'modified_beam_search' : 'greedy_search',
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4, // 静音 2.4s 断句
      rule2MinTrailingSilence: 1.2, // 有语音后静音 1.2s 断句
      rule3MinUtteranceLength: 20, // 最长 20s 强制断句
      hotwordsFile,
      hotwordsScore: 1.5,
      ruleFsts: '',
      ruleFars: ''
    }

    this.events = opts.events
    this.recognizer = new mod.OnlineRecognizer(config)
    this.stream = this.recognizer.createStream()
    this.lastText = ''
  }

  /** 喂入 16kHz 单声道 PCM（float 归一化） */
  feed(samples: Float32Array): void {
    if (!this.recognizer || !this.stream) return
    this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
    }
    const text = this.recognizer.getResult(this.stream).text.trim()
    if (text && text !== this.lastText) {
      this.lastText = text
      this.events?.onPartial(text)
    }
    if (this.recognizer.isEndpoint(this.stream)) {
      const final = text || this.lastText
      if (final) this.events?.onFinal(final)
      this.recognizer.reset(this.stream)
      this.lastText = ''
    }
  }

  stop(): void {
    this.recognizer = null
    this.stream = null
    this.events = null
    this.lastText = ''
  }

  /** 整段识别（自检用）：喂完全部样本后取完整结果，不动端点状态。
   *  需先 start()；复用课堂单例引擎，避免模型重复加载（enc int8 约 180MB）。 */
  recognizeSamples(samples: Float32Array): string {
    if (!this.recognizer || !this.stream) throw new Error('识别引擎未启动')
    const CHUNK = 4000 // 与课堂实时喂入粒度一致
    for (let i = 0; i < samples.length; i += CHUNK) {
      this.stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(i, i + CHUNK) })
      while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream)
    }
    const text = this.recognizer.getResult(this.stream).text.trim()
    this.recognizer.reset(this.stream)
    this.lastText = ''
    return text
  }
}

/** 解析 PCM WAV（RIFF）为 { sampleRate, samples }。仅支持未压缩 PCM（sherpa 官方 test_wavs 即此格式）。 */
export function parseWav(buf: Buffer): { sampleRate: number; samples: Float32Array } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法 WAV 文件')
  }
  let offset = 12
  let sampleRate = SAMPLE_RATE
  let bitsPerSample = 16
  let channels = 1
  let data: Buffer | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      bitsPerSample = buf.readUInt16LE(offset + 22)
    } else if (id === 'data') {
      data = buf.subarray(offset + 8, offset + 8 + size)
      break
    }
    offset += 8 + size + (size % 2)
  }
  if (!data) throw new Error('WAV 缺少 data 块')
  if (bitsPerSample !== 16) throw new Error(`仅支持 16bit PCM（实际 ${bitsPerSample}bit）`)
  const i16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2))
  // 立体声简单取左声道；采样率与引擎不同时直接按原样喂入（zipformer 特征提取按配置采样率，16k 模型遇非 16k 音频会在 asr:status 引导用户）
  const take = channels > 1 ? (n: number) => i16[n * channels] : (n: number) => i16[n]
  const samples = new Float32Array(Math.floor(i16.length / channels))
  for (let i = 0; i < samples.length; i++) samples[i] = take(i) / 32768
  return { sampleRate, samples }
}

export const asrService = new AsrService()
