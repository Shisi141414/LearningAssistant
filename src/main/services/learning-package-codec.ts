import { createReadStream } from 'node:fs'
import { open, readFile, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ZipFile as ZipWriter } from 'yazl'
import { fromBuffer, type ZipFile, type Entry } from 'yauzl'
import { imageSize } from 'image-size'
import { loadImage } from '@napi-rs/canvas'
import type { LearningPackage, LearningPackageFile } from '@shared/learning-package'
import { learningPackageFiles, learningPackageLimits as limits } from '@shared/learning-package'
import { validateLearningPackage } from './learning-package-validation'

export interface ArchiveManifest { assets: LearningPackage['assets'] }
export interface ArchiveContract<T extends ArchiveManifest> {
  validate: (value: unknown) => asserts value is T
  files: (manifest: T) => LearningPackageFile[]
}
export interface DecodedDocumentArchive<T> { manifest: T; sha256: string; files: { path: string; file: string }[] }
export type DecodedLearningPackage = DecodedDocumentArchive<LearningPackage>
const materialContract: ArchiveContract<LearningPackage> = { validate: validateLearningPackage, files: learningPackageFiles }
/** 安装前复核复制后的实际文件，避免预览与确认期间字节变化。只在工作线程使用。 */
export async function verifyDocumentArchiveFiles<T extends ArchiveManifest>(manifest: T, files: Map<string, string>, contract: ArchiveContract<T>, signal?: AbortSignal): Promise<void> {
  contract.validate(manifest)
  const declared = contract.files(manifest)
  if (files.size !== declared.length || declared.some(item => !files.has(item.path))) throw new Error('导入附件与清单不一致')
  for (const item of declared) {
    const actual = await fileDigest(files.get(item.path)!, item.byte_length, signal)
    if (actual.sha256 !== item.sha256 || actual.byte_length !== item.byte_length) throw new Error('导入文件在预览后发生变化，请重新选择文档包')
    const asset = manifest.assets.find(asset => asset.path === item.path)
    if (asset) await checkImage(files.get(item.path)!, asset)
  }
}
const zipPath = /^(document\.json|source\/(original\.(pdf|docx|pptx|doc|ppt)|converted\.(docx|pptx))|assets\/[A-Za-z0-9_-]{1,128}\.(png|jpg))$/
class CheckedBytes extends Transform {
  private bytes = 0
  private checksum = 0
  private hash = createHash('sha256')
  private maximum: number
  private expected?: Pick<LearningPackageFile, 'byte_length' | 'sha256'>
  private crc?: number
  constructor(maximum: number, expected?: Pick<LearningPackageFile, 'byte_length' | 'sha256'>, crc?: number) { super(); this.maximum = maximum; this.expected = expected; this.crc = crc }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length
    if (this.bytes > this.maximum) { done(new Error('解压或读取实际字节超过限制')); return }
    this.hash.update(chunk); this.checksum = crc32(chunk, this.checksum); done(null, chunk)
  }
  override _flush(done: TransformCallback): void {
    const hash = this.hash.digest('hex')
    done(this.expected && (this.bytes !== this.expected.byte_length || hash !== this.expected.sha256) || this.crc !== undefined && this.checksum !== this.crc ? new Error('包内文件散列、CRC 或字节数量不符') : null)
  }
}
async function boundedBuffer(stream: Readable, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [], check = new CheckedBytes(maximum)
  await pipeline(stream, check, async source => { for await (const chunk of source) chunks.push(chunk as Buffer) }, { signal })
  return Buffer.concat(chunks)
}
async function fileDigest(file: string, maximum: number, signal?: AbortSignal): Promise<{ sha256: string; byte_length: number }> {
  const hash = createHash('sha256'); let length = 0
  for await (const chunk of createReadStream(file, { signal })) {
    const bytes = chunk as Buffer; length += bytes.length
    if (length > maximum) throw new Error('文件容量超过限制')
    hash.update(bytes)
  }
  return { sha256: hash.digest('hex'), byte_length: length }
}
async function checkImage(file: string, asset: LearningPackage['assets'][number]): Promise<void> {
  if ((await stat(file)).size > limits.assetBytes) throw new Error('图片容量超过限制')
  const bytes = await readFile(file), size = imageSize(bytes)
  if (bytes.length > limits.assetBytes || size.width !== asset.width || size.height !== asset.height || (size.type === 'png' ? 'image/png' : size.type === 'jpg' ? 'image/jpeg' : '') !== asset.mime_type) throw new Error('图片头、媒体类型或尺寸不符')
  const image = await loadImage(bytes)
  if (image.width !== asset.width || image.height !== asset.height) throw new Error('图片实际解码尺寸不符')
}
function openZip(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error ? reject(error) : resolve(zip!)))
}
function zipEntries(zip: ZipFile, signal?: AbortSignal): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>(), names = new Set<string>(); let total = 0
    const finish = (error?: Error): void => { zip.removeListener('entry', entry); zip.removeListener('error', fail); zip.removeListener('end', end); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(entries) }
    const fail = (error: Error): void => finish(error), abort = (): void => finish(new Error('学习文档包操作已取消')), end = (): void => finish()
    const entry = (item: Entry): void => {
      const mode = (item.externalFileAttributes >>> 16) & 0o170000
      if (!zipPath.test(item.fileName) || names.has(item.fileName.toLowerCase()) || mode !== 0 && mode !== 0o100000 || item.isEncrypted() || ![0, 8].includes(item.compressionMethod)) { finish(new Error('包内路径重复、格式不支持或含目录/链接/加密条目')); return }
      const maximum = item.fileName === 'document.json' ? limits.manifestBytes : item.fileName.startsWith('assets/') ? limits.assetBytes : limits.fileBytes
      total += item.uncompressedSize
      if (!Number.isSafeInteger(item.uncompressedSize) || item.uncompressedSize < 1 || item.uncompressedSize > maximum || !Number.isSafeInteger(item.compressedSize) || item.compressedSize < 0 || item.compressedSize > limits.archiveBytes || total > limits.unpackedBytes || entries.size >= limits.entries) { finish(new Error('包内声明尺寸、数量或总容量超过限制')); return }
      names.add(item.fileName.toLowerCase()); entries.set(item.fileName, item); zip.readEntry()
    }
    zip.on('entry', entry); zip.on('error', fail); zip.once('end', end); signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort(); else zip.readEntry()
  })
}
async function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  const header = await new Promise<{ fileName: Buffer; generalPurposeBitFlag: number }>((resolve, reject) => zip.readLocalFileHeader(entry, { minimal: false }, (error, value) => error ? reject(error) : resolve(value)))
  if (header.fileName.toString('utf8') !== entry.fileName || (header.generalPurposeBitFlag & 1)) throw new Error('ZIP 本地名称或加密标识与目录不一致')
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)))
}
/** 调用者提供本批新建的空目录；不把 ZIP 文件名作为磁盘路径使用。必须在工作线程调用。 */
export async function readDocumentArchive<T extends ArchiveManifest>(file: string, directory: string, contract: ArchiveContract<T>, signal?: AbortSignal): Promise<DecodedDocumentArchive<T>> {
  signal?.throwIfAborted()
  if ((await readdir(directory)).length) throw new Error('文档包暂存目录必须为空')
  const source = await open(file, 'r')
  let bytes: Buffer
  try {
    if ((await source.stat()).size > limits.archiveBytes) throw new Error('学习文档包超过 192 MiB')
    bytes = await boundedBuffer(source.createReadStream({ autoClose: false, start: 0, end: limits.archiveBytes }), limits.archiveBytes, signal)
  } finally { await source.close() }
  const zip = await openZip(bytes), saved: { path: string; file: string }[] = []
  // yauzl 的后续读取错误由流或回调返回；保留监听，避免未知包触发未处理事件。
  let zipError: Error | undefined
  zip.on('error', error => { zipError = error })
  let success = false
  try {
    const entries = await zipEntries(zip, signal), manifestEntry = entries.get('document.json')
    if (!manifestEntry) throw new Error('文档包缺少 document.json')
    const manifestBytes = await boundedBuffer(await entryStream(zip, manifestEntry), limits.manifestBytes, signal)
    if (manifestBytes.length !== manifestEntry.uncompressedSize || crc32(manifestBytes) !== manifestEntry.crc32) throw new Error('文档清单 CRC 或尺寸不符')
    const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
    contract.validate(manifest)
    const declared = contract.files(manifest)
    if (entries.size !== declared.length + 1 || declared.some(item => !entries.has(item.path))) throw new Error('包内存在未声明文件或缺少附件')
    for (const item of declared) {
      signal?.throwIfAborted()
      const entry = entries.get(item.path)!
      if (entry.uncompressedSize !== item.byte_length) throw new Error('文件声明字节数量不符')
      const target = join(directory, `file-${saved.length + 1}.bin`), handle = await open(target, 'wx')
      saved.push({ path: item.path, file: target })
      try { await pipeline(await entryStream(zip, entry), new CheckedBytes(item.byte_length, item, entry.crc32), handle.createWriteStream(), { signal }) }
      finally { await handle.close().catch(() => undefined) }
      const asset = manifest.assets.find(asset => asset.path === item.path)
      if (asset) await checkImage(target, asset)
    }
    if (zipError) throw zipError
    signal?.throwIfAborted(); success = true
    return { manifest, sha256: createHash('sha256').update(bytes).digest('hex'), files: saved }
  } finally { zip.close(); if (!success) for (const item of saved) await unlink(item.file).catch(() => undefined) }
}
/** 输出只允许新文件；调用者随后原子替换用户选择的目标，失败保留既有文件。 */
export async function writeDocumentArchive<T extends ArchiveManifest>(manifest: T, files: Map<string, string>, output: string, contract: ArchiveContract<T>, signal?: AbortSignal): Promise<{ sha256: string; byte_length: number }> {
  signal?.throwIfAborted(); contract.validate(manifest)
  const metadata = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  if (metadata.length > limits.manifestBytes) throw new Error('文档包清单超过 16 MiB，请拆分材料')
  const declared = contract.files(manifest)
  if (files.size !== declared.length || declared.some(item => !files.has(item.path))) throw new Error('导出文件与清单不一致')
  for (const asset of manifest.assets) { signal?.throwIfAborted(); await checkImage(files.get(asset.path)!, asset) }
  const handle = await open(output, 'wx'), zip = new ZipWriter(), streams: Readable[] = [], destination = handle.createWriteStream()
  const result = pipeline(zip.outputStream as Readable, new CheckedBytes(limits.archiveBytes), destination, { signal })
  // 立即接住输出失败，避免等待流准备时出现未处理的 promise rejection。
  void result.catch(() => undefined)
  zip.on('error', error => (zip.outputStream as Readable).destroy(error))
  let success = false
  try {
    zip.addBuffer(metadata, 'document.json', { compress: true })
    for (const item of declared) zip.addReadStreamLazy(item.path, { size: item.byte_length, compress: false, mode: 0o100444 }, callback => {
      if (signal?.aborted) { callback(new Error('学习文档包操作已取消'), undefined as never); return }
      const stream = createReadStream(files.get(item.path)!, { signal }), checked = new CheckedBytes(item.byte_length, item)
      streams.push(stream, checked)
      // addReadStreamLazy 不转发输入流错误；必须主动使整个归档输出失败。
      checked.once('error', error => zip.emit('error', error))
      void pipeline(stream, checked, { signal }).catch(() => undefined)
      callback(null, checked)
    })
    zip.end(); await result
    const digest = await fileDigest(output, limits.archiveBytes, signal)
    signal?.throwIfAborted(); success = true; return digest
  } finally {
    for (const stream of streams) stream.destroy()
    ;(zip.outputStream as Readable).destroy(); destination.destroy(); await handle.close().catch(() => undefined)
    if (!success) await unlink(output).catch(() => undefined)
  }
}

// 教材契约与既有调用保持一致；笔记复用相同的 ZIP、CRC、字节上限和原子输出前校验。
export function verifyLearningPackageFiles(manifest: LearningPackage, files: Map<string, string>, signal?: AbortSignal) {
  return verifyDocumentArchiveFiles(manifest, files, materialContract, signal)
}
export function readLearningPackage(file: string, directory: string, signal?: AbortSignal) {
  return readDocumentArchive(file, directory, materialContract, signal)
}
export function writeLearningPackage(manifest: LearningPackage, files: Map<string, string>, output: string, signal?: AbortSignal) {
  return writeDocumentArchive(manifest, files, output, materialContract, signal)
}
