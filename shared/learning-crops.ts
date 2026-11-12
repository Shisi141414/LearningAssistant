import type { LearningCropRect, MaterialLocator } from './types'

/** 默认旋转后的可见页面，以左上角为原点的归一化 [左,上,宽,高]。 */
export function validLearningCropRect(value: unknown): value is LearningCropRect {
  return Array.isArray(value) && value.length === 4 && value.every(n => typeof n === 'number' && Number.isFinite(n)) && value[0] >= 0 && value[1] >= 0 && value[2] >= 0.001 && value[3] >= 0.001 && value[0] + value[2] <= 1 && value[1] + value[3] <= 1
}
export function learningCropRect(start: [number, number], end: [number, number]): LearningCropRect {
  const clamp = (n: number): number => Math.max(0, Math.min(1, n))
  const x = Math.min(clamp(start[0]), clamp(end[0])), y = Math.min(clamp(start[1]), clamp(end[1]))
  return [x, y, Math.max(clamp(start[0]), clamp(end[0])) - x, Math.max(clamp(start[1]), clamp(end[1])) - y]
}
export function validLearningPdfFigureLocator(locator: MaterialLocator): boolean {
  return locator.kind === 'pdf' && locator.source === 'pdf-crop:v1' && Number.isSafeInteger(locator.page) && locator.page! >= 1 && locator.page! <= 100_000 && validLearningCropRect(locator.crop?.rect) && [0, 90, 180, 270].includes(locator.crop!.rotation) && typeof locator.crop!.engine === 'string' && locator.crop!.engine.length > 0 && locator.crop!.engine.length <= 200 && Array.isArray(locator.bbox) && locator.bbox.length === 4 && locator.bbox.every(Number.isFinite) && locator.bbox[0] < locator.bbox[2] && locator.bbox[1] < locator.bbox[3] && Array.isArray(locator.pageSize) && locator.pageSize.length === 2 && locator.pageSize.every(n => Number.isFinite(n) && n > 0 && n <= 100_000)
}
