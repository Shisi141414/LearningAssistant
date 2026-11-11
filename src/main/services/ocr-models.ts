import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { OcrModelsStatus } from '@shared/types'
import { dbFilePath } from './db'
import { withWork } from './work'

export const OCR_MODEL_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd'
export const OCR_MODELS = [
  { name: 'eng.traineddata', sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
  { name: 'chi_sim.traineddata', sha256: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730' }
] as const
const MAX_BYTES = 15 * 1024 * 1024
export const ocrModelDirectory = (): string => join(dirname(dbFilePath()), 'ocr-models', `tessdata-fast-${OCR_MODEL_COMMIT.slice(0, 8)}`)

export async function validOcrModel(path: string, sha256: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_BYTES) return false
    const bytes = await readFile(path)
    return bytes.length <= MAX_BYTES && createHash('sha256').update(bytes).digest('hex') === sha256
  } catch { return false }
}
export async function ocrModelsStatus(): Promise<OcrModelsStatus> {
  const directory = ocrModelDirectory()
  const files = await Promise.all(OCR_MODELS.map(async file => ({ name: file.name, ready: await validOcrModel(join(directory, file.name), file.sha256) })))
  return { ready: files.every(file => file.ready), files }
}
let preparing: Promise<OcrModelsStatus> | undefined
/** 只有显式的语言包准备请求会联网；URL 与摘要不接受渲染进程输入。 */
export function prepareOcrModels(): Promise<OcrModelsStatus> {
  preparing ??= withWork('OCR 语言包准备', async () => {
    const directory = ocrModelDirectory()
    await mkdir(directory, { recursive: true })
    for (const file of OCR_MODELS) {
      const target = join(directory, file.name)
      if (await validOcrModel(target, file.sha256)) continue
      const temporary = target + '.' + nanoid() + '.part'
      try {
        const response = await fetch(`https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${OCR_MODEL_COMMIT}/${file.name}`, { signal: AbortSignal.timeout(60_000) })
        if (!response.ok || !response.body) throw new Error(`语言包下载失败（${response.status}）`)
        const chunks: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > MAX_BYTES) { await response.body.cancel().catch(() => undefined); throw new Error('语言包超过体积限制') }
          chunks.push(chunk)
        }
        const bytes = Buffer.concat(chunks)
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('语言包校验失败，请重新准备')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(temporary, bytes, { flag: 'wx' })
        await rename(temporary, target)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') console.warn('语言包临时文件清理失败', error.message) }) }
    }
    return ocrModelsStatus()
  }).finally(() => { preparing = undefined })
  return preparing
}
