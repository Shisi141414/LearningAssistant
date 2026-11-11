import { create } from 'zustand'
import type { Concept } from '@shared/types'

let request = 0
export const useConceptStore = create<{ items: Concept[]; error: string; load: () => Promise<void> }>((set) => ({
  items: [], error: '',
  load: async () => {
    const current = ++request
    const result = await window.api.concepts.list()
    if (current !== request) return
    if (result.ok) set({ items: result.data, error: '' })
    else set({ error: result.error })
  }
}))
