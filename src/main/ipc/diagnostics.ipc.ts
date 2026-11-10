/**
 * ipc/diagnostics.ipc.ts —— 功能自检：各能力链路单独验证
 *
 * ASR 测试用模型自带 test_wavs（无需麦克风，验证引擎加载+识别全链路）；
 * LLM 类测试用默认模型（识图测试挑第一个 vision 模型）。
 */
import { ipcMain } from 'electron'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '@shared/ipc-channels'
import type { DiagAsrResult, DiagChatResult, DiagOrganizeResult, DiagVisionResult } from '@shared/types'
import { DIAG_ORGANIZE_SAMPLE, DIAG_VISION_PNG_BASE64 } from '@shared/diagSamples'
import { getDb } from '../services/db'
import { configGet } from '../services/config'
import { asrService, parseWav } from '../services/asr'
import { completeChat, completeVision } from '../services/llm'
import { buildOrganizePrompt, parseOrganizedResponse } from '../services/organize'
import { getProviderWithKey } from './providers.ipc'
import { pickModel } from './chat.ipc'
import { handleResult } from './helpers'

export function registerDiagnosticsIpc(): void {
  /** 语音识别：加载引擎 + 转写模型自带测试音频（不用麦克风，课堂页再实测麦克风） */
  ipcMain.handle(IPC.DiagnosticsAsr, () =>
    handleResult(async (): Promise<DiagAsrResult> => {
      const modelDir = configGet('asr.model_dir')
      if (!modelDir) throw new Error('未配置语音模型目录（设置 → 语音引擎）')
      const wavs = readdirSync(modelDir).filter((f) => f.endsWith('.wav'))
      const wavDir = join(modelDir, 'test_wavs')
      let wavFile: string | null = null
      let wavPath: string | null = null
      if (wavs.length > 0) {
        wavFile = wavs[0]
        wavPath = join(modelDir, wavFile)
      } else {
        try {
          const tw = readdirSync(wavDir).filter((f) => f.endsWith('.wav'))
          if (tw.length > 0) {
            wavFile = `test_wavs/${tw[0]}`
            wavPath = join(wavDir, tw[0])
          }
        } catch {
          /* 无 test_wavs */
        }
      }
      if (!wavFile || !wavPath) throw new Error('模型目录里没有 .wav 测试音频（找不到 test_wavs）')

      const t0 = Date.now()
      const startedByDiag = !asrService.running
      if (startedByDiag) {
        await asrService.start({ modelDir, hotwords: configGet('asr.hotwords') ?? '', events: { onPartial: () => undefined, onFinal: () => undefined } })
      }
      try {
        const { samples } = parseWav(readFileSync(wavPath))
        const text = asrService.recognizeSamples(samples)
        return { wavFile, text, latencyMs: Date.now() - t0 }
      } finally {
        if (startedByDiag) asrService.stop()
      }
    })
  )

  /** 文本对话：最小补全请求验证 供应商+模型+Key+网络 */
  ipcMain.handle(IPC.DiagnosticsChat, () =>
    handleResult(async (): Promise<DiagChatResult> => {
      const t0 = Date.now()
      const model = pickModel(null)
      const { provider, apiKey } = getProviderWithKey(model.provider_id)
      if (!apiKey) throw new Error(`供应商「${provider.name}」未配置 API Key`)
      const reply = await completeChat(
        { base_url: provider.base_url, api_format: provider.api_format, apiKey },
        model.model_id,
        [{ role: 'user', content: '连通性测试：请只回复两个字「正常」' }]
      )
      return { reply, model: `${provider.name} / ${model.display_name}`, latencyMs: Date.now() - t0 }
    })
  )

  /** 笔记整理：全管线（prompt→LLM→容错解析），用含同音错字的固定样例 */
  ipcMain.handle(IPC.DiagnosticsOrganize, () =>
    handleResult(async (): Promise<DiagOrganizeResult> => {
      const t0 = Date.now()
      const model = pickModel(null)
      const { provider, apiKey } = getProviderWithKey(model.provider_id)
      if (!apiKey) throw new Error(`供应商「${provider.name}」未配置 API Key`)
      const response = await completeChat(
        { base_url: provider.base_url, api_format: provider.api_format, apiKey },
        model.model_id,
        buildOrganizePrompt(DIAG_ORGANIZE_SAMPLE, '数学分析')
      )
      const parsed = parseOrganizedResponse(response, DIAG_ORGANIZE_SAMPLE)
      return { ...parsed, model: `${provider.name} / ${model.display_name}`, latencyMs: Date.now() - t0 }
    })
  )

  /** 识图：内嵌 64×64 纯红 PNG 发给第一个 vision 模型，应答"红色"类描述 */
  ipcMain.handle(IPC.DiagnosticsVision, () =>
    handleResult(async (): Promise<DiagVisionResult> => {
      const db = getDb()
      const m = db.prepare(
        'SELECT m.id, m.model_id, m.display_name, m.provider_id FROM models m JOIN providers p ON m.provider_id = p.id WHERE p.enabled = 1 AND m.supports_vision = 1 ORDER BY p.created_at, m.created_at LIMIT 1'
      ).get() as { id: string; model_id: string; display_name: string; provider_id: string } | undefined
      if (!m) throw new Error('没有识图模型：请到「设置 → 模型服务」添加并勾选"支持识图"（如 qwen-vl-plus / glm-4v / gpt-4o）')
      const { provider, apiKey } = getProviderWithKey(m.provider_id)
      if (!apiKey) throw new Error(`供应商「${provider.name}」未配置 API Key`)
      const t0 = Date.now()
      const reply = await completeVision(
        { base_url: provider.base_url, api_format: provider.api_format, apiKey },
        m.model_id,
        '这张图片是什么颜色的什么形状？10 个字以内回答。',
        { mime: 'image/png', base64: DIAG_VISION_PNG_BASE64 }
      )
      return { reply, model: `${provider.name} / ${m.display_name}`, latencyMs: Date.now() - t0 }
    })
  )
}
