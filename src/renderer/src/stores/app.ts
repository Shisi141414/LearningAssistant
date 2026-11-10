/**
 * stores/app.ts —— 全局应用状态：学科、toast 通知
 */
import { create } from 'zustand'
import type { Subject } from '@shared/types'

interface AppState {
  subjects: Subject[]
  currentSubjectId: string | null
  /** 全局 toast（null 为隐藏） */
  toast: string | null
  setSubjects: (s: Subject[]) => void
  setCurrentSubject: (id: string | null) => void
  showToast: (msg: string) => void
  clearToast: () => void
  loadSubjects: () => Promise<void>
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useAppStore = create<AppState>((set) => ({
  subjects: [],
  currentSubjectId: null,
  toast: null,
  setSubjects: (subjects) => set({ subjects }),
  setCurrentSubject: (id) => set({ currentSubjectId: id }),
  showToast: (msg) => {
    set({ toast: msg })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => set({ toast: null }), 2600)
  },
  clearToast: () => set({ toast: null }),
  loadSubjects: async () => {
    const res = await window.api.subjects.list()
    if (res.ok) {
      set({ subjects: res.data })
      // 保持当前学科有效
      const cur = useAppStore.getState().currentSubjectId
      if (!cur || !res.data.some((s) => s.id === cur)) {
        set({ currentSubjectId: res.data[0]?.id ?? null })
      }
    }
  }
}))
