/**
 * services/ppocr-models.ts —— PP-OCR（ppu-paddle-ocr）模型管理
 *
 * 语言路由（用户需求：按材料语言选引擎/模型）：
 *   zh/en → v6-tiny 统一模型（PP-OCRv6 单模型覆盖 50+ 语言，中英最优默认）
 *   ja   → v3 日文专用 rec 模型；ko → v5 韩文专用
 *   其他语言 → v5 latin 系或回退 v6-tiny；tesseract 保留为备选引擎
 *
 * 模式与 ocr-models.ts（tesseract 语言包）一致：显式准备 IPC 才联网下载，
 * 识别 worker 只读本地文件（离线推理）；下载原子写 + 大小上限 + 记录摘要。
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { dirname } from 'node:path'
import { dbFilePath } from './db'
import { withWork } from './work'

const HF_BASE = 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main'
const GH_BASE = 'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main'
/** GitHub raw 国内可达性通常好于 HF；失败自动回退 HF */
const urlFor = (rel: string, mirror: boolean): string => `${mirror ? (rel.endsWith('.txt') ? 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main' : GH_BASE) : HF_BASE}/${rel}`

/** 从已解析的公开入口读取同目录元数据，避免访问未导出的 package.json 子路径。 */
export async function ppocrEngineVersion(): Promise<string> {
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
  const metadata = JSON.parse(await readFile(join(dirname(require.resolve('ppu-paddle-ocr')), 'package.json'), 'utf-8'))
  if (metadata.name !== 'ppu-paddle-ocr' || typeof metadata.version !== 'string') throw new Error('PP-OCR 版本信息无效')
  return metadata.version
}

export interface PpocrPreset {
  key: string
  label: string
  files: { detection: string; recognition: string; charactersDictionary: string }
}

/** 与 ppu-paddle-ocr/model-catalogue 的预设对应（URL 路径硬编码，不接受外部输入） */
export const PPOCR_PRESETS: Record<string, PpocrPreset> = {
  'v6-tiny': {
    key: 'v6-tiny',
    label: '中英·PP-OCRv6 统一（推荐，覆盖 50+ 语言）',
    files: {
      detection: 'detection/ort/PP-OCRv6_tiny_det.ort',
      recognition: 'recognition/ort/PP-OCRv6_tiny_rec.ort',
      charactersDictionary: 'recognition/ppocrv6_tiny_dict.txt'
    }
  },
  'v5-ja': {
    key: 'v5-ja',
    label: '日文·PP-OCRv3 日文专用',
    files: {
      detection: 'detection/PP-OCRv5_mobile_det_infer.onnx',
      recognition: 'recognition/multi/japan/v3/japan_PP-OCRv3_mobile_rec_infer.onnx',
      charactersDictionary: 'recognition/multi/japan/v3/japan_dict.txt'
    }
  },
  'v5-ko': {
    key: 'v5-ko',
    label: '韩文·PP-OCRv5 韩文专用',
    files: {
      detection: 'detection/PP-OCRv5_mobile_det_infer.onnx',
      recognition: 'recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx',
      charactersDictionary: 'recognition/multi/korean/v5/ppocrv5_korean_dict.txt'
    }
  },
  'v5-latin': {
    key: 'v5-latin',
    label: '拉丁字母·PP-OCRv5 拉丁专用（法德西等）',
    files: {
      detection: 'detection/PP-OCRv5_mobile_det_infer.onnx',
      recognition: 'recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx',
      charactersDictionary: 'recognition/multi/latin/v5/ppocrv5_latin_dict.txt'
    }
  }
}

export interface PpocrModelsStatus {
  /** missing：未下载或校验失败的文件名（诊断用，UI 直接展示） */
  presets: Array<{ key: string; label: string; ready: boolean; missing: string[] }>
}

const MODEL_MAX_BYTES = 96 * 1024 * 1024
const DICT_MAX_BYTES = 4 * 1024 * 1024

export const ppocrModelDirectory = (preset: string): string => join(dirname(dbFilePath()), 'ocr-models', `ppocr-${preset}`)

async function validFile(path: string, recordedSha: string): Promise<boolean> {
  try {
    const bytes = await readFile(path)
    if (!validContents(bytes, path)) return false
    return createHash('sha256').update(bytes).digest('hex') === recordedSha
  } catch {
    return false
  }
}

function validContents(bytes: Buffer, path: string): boolean {
  if (bytes.length === 0 || bytes.length > (path.endsWith('.txt') ? DICT_MAX_BYTES : MODEL_MAX_BYTES)) return false
  const prefix = bytes.subarray(0, 200).toString('utf-8').trimStart()
  return !/^(version https:\/\/git-lfs|<!doctype html|<html)/i.test(prefix) && (path.endsWith('.txt') || bytes.length > 1024)
}

async function readSha(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf-8')).trim() || null
  } catch {
    return null
  }
}

export async function ppocrStatus(): Promise<PpocrModelsStatus> {
  const presets: PpocrModelsStatus['presets'] = []
  for (const preset of Object.values(PPOCR_PRESETS)) {
    const dir = ppocrModelDirectory(preset.key)
    let ready = true
    const missing: string[] = []
    for (const rel of Object.values(preset.files)) {
      const name = rel.split('/').pop() as string
      const sha = await readSha(join(dir, `${name}.sha256`))
      if (!sha || !(await validFile(join(dir, name), sha))) { ready = false; missing.push(name) }
    }
    presets.push({ key: preset.key, label: preset.label, ready, missing })
  }
  return { presets }
}

let preparing: Record<string, Promise<PpocrModelsStatus>> = {}

/** 显式准备：下载预设三件套（GitHub 镜像优先，HF 回退）。原子写 + 摘要记录。 */
export function preparePpocrModel(presetKey: string): Promise<PpocrModelsStatus> {
  const preset = PPOCR_PRESETS[presetKey]
  if (!preset) throw new Error('未知的 PP-OCR 模型预设')
  preparing[presetKey] ??= withWork(`PP-OCR 模型准备（${preset.label}）`, async () => {
    const directory = ppocrModelDirectory(presetKey)
    await mkdir(directory, { recursive: true })
    for (const rel of Object.values(preset.files)) {
      const name = rel.split('/').pop() as string
      const target = join(directory, name)
      const shaFile = `${target}.sha256`
      const recorded = await readSha(shaFile)
      if (recorded && (await validFile(target, recorded))) continue
      const limit = name.includes('dict') ? DICT_MAX_BYTES : MODEL_MAX_BYTES
      const bytes = (await download(urlFor(rel, true), limit, rel)) ?? (await download(urlFor(rel, false), limit, rel))
      if (!bytes) throw new Error(`模型文件下载失败（GitHub 镜像与 HuggingFace 均不可达）：${name}`)
      const temporary = `${target}.${nanoid()}.part`
      try {
        await writeFile(temporary, bytes)
        await rename(temporary, target)
        await writeFile(shaFile, `${createHash('sha256').update(bytes).digest('hex')}\n`)
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    }
    return ppocrStatus()
  }).finally(() => { delete preparing[presetKey] })
  return preparing[presetKey]
}

async function download(url: string, limit: number, rel: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: 'follow' })
    if (!response.ok || !response.body) return null
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) {
        await response.body.cancel().catch(() => undefined)
        throw new Error('模型文件超过体积限制')
      }
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    return validContents(bytes, rel) ? bytes : null
  } catch (e) {
    if (e instanceof Error && e.message.includes('体积限制')) throw e
    return null
  }
}

/** 语言 → 模型预设路由（zh-en 及未识别语言走 v6 统一模型） */
export function presetForLanguage(language: string | undefined): string {
  if (language === 'ja') return 'v5-ja'
  if (language === 'ko') return 'v5-ko'
  if (language === 'latin') return 'v5-latin'
  return 'v6-tiny'
}

/** 识别 worker 用：本地模型路径（不联网）。文件缺失时抛错。 */
export async function ppocrModelPaths(presetKey: string): Promise<{ detection: string; recognition: string; charactersDictionary: string }> {
  const preset = PPOCR_PRESETS[presetKey]
  if (!preset) throw new Error('未知的 PP-OCR 模型预设')
  const dir = ppocrModelDirectory(presetKey)
  const paths = {
    detection: join(dir, preset.files.detection.split('/').pop() as string),
    recognition: join(dir, preset.files.recognition.split('/').pop() as string),
    charactersDictionary: join(dir, preset.files.charactersDictionary.split('/').pop() as string)
  }
  for (const p of Object.values(paths)) {
    const sha = await readSha(`${p}.sha256`)
    if (!sha || !(await stat(p).then((s) => s.isFile()).catch(() => false)) || !(await validFile(p, sha))) {
      throw new Error(`PP-OCR 模型未就绪，请先在材料库「准备模型」（缺 ${p.split('\\').pop()?.split('/').pop() ?? '文件'}）`)
    }
  }
  return paths
}
