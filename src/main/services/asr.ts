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

/** 在模型目录中探测 zipformer transducer 四件套（优先 int8 量化版） */
export function findModelFiles(dir: string): { files: AsrModelFiles } | { missing: string[] } {
  if (!existsSync(dir)) return { missing: ['目录不存在'] }
  const names = readdirSync(dir)
  const pick = (base: string): string | null => {
    for (const cand of [`${base}.int8.onnx`, `${base}.onnx`]) {
      if (names.includes(cand)) return join(dir, cand)
    }
    return null
  }
  const enc = pick('enc')
  const dec = pick('dec')
  const joiner = pick('join')
  const tokens = names.includes('tokens.txt') ? join(dir, 'tokens.txt') : null
  const missing: string[] = []
  if (!enc) missing.push('enc.onnx / enc.int8.onnx')
  if (!dec) missing.push('dec.onnx / dec.int8.onnx')
  if (!joiner) missing.push('join.onnx / join.int8.onnx')
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

    const config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { enc: found.files.enc, dec: found.files.dec, join: found.files.join },
        tokens: found.files.tokens,
        numThreads: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))),
        debug: 0,
        provider: 'cpu'
      },
      // 端点检测：静音 2.4s 或（有语音后）静音 1.2s 断句；最长 20s 强制断
      endpointConfig: {
        rule1: { mustContainNonSilence: false, minTrailingSilence: 2.4, minUtteranceLength: 20 },
        rule2: { mustContainNonSilence: true, minTrailingSilence: 1.2, minUtteranceLength: 20 },
        rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 }
      },
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
}

export const asrService = new AsrService()
