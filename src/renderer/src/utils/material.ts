import type { MaterialBlock } from '@shared/types'
import type { MaterialLocator } from '@shared/types'

export function materialLocation(block: MaterialBlock): string {
  const locator = JSON.parse(block.locator_json) as MaterialLocator
  return locator.page ? `第 ${locator.page} 页` : locator.slide ? `第 ${locator.slide} 张幻灯片` : `条目 ${block.ordinal + 1}`
}
export function materialHref(materialId: string, block: MaterialBlock): string {
  return `/library?${new URLSearchParams({ material: materialId, version: block.version_id, block: block.id, offset: String(Math.floor(block.ordinal / 100) * 100) })}`
}
