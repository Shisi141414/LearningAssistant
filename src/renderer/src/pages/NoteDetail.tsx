/**
 * pages/NoteDetail.tsx —— 笔记编辑（M0 核心）
 *
 * - 段落级编辑：类型标记（定义/命题/例题/证明/解答/注意，分色左边框）
 * - 双视图：全局切换"整理视图 / 原文视图"，编辑的是当前视图对应字段
 *   （M0 手动维护两栏；M1 课堂模式由 AI 流水线自动填 organized_text）
 * - 标注：段落级 重点/疑问 + 备注；每段 DOM 带 data-segment-id，
 *   供全局快捷栏"选中内容 → 标注"定位
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import type { NoteWithSegments, NoteSegment, SegmentType, Annotation } from '@shared/types'
import { SEGMENT_TYPE_META } from '@shared/types'
import { useAppStore } from '../stores/app'

type ViewMode = 'organized' | 'raw'

export function NoteDetail() {
  const { noteId } = useParams<{ noteId: string }>()
  const showToast = useAppStore((s) => s.showToast)
  const [note, setNote] = useState<NoteWithSegments | null>(null)
  const [view, setView] = useState<ViewMode>('organized')
  const [title, setTitle] = useState('')

  const reload = useCallback(async () => {
    if (!noteId) return
    const res = await window.api.notes.get(noteId)
    if (res.ok) {
      setNote(res.data)
      setTitle(res.data.title)
    } else {
      showToast(res.error)
    }
  }, [noteId, showToast])

  useEffect(() => {
    void reload()
  }, [reload])

  if (!note) return <div className="page">加载中…</div>

  /* ---------- 段落操作 ---------- */

  const addSegment = async (): Promise<void> => {
    const res = await window.api.notes.addSegment({ note_id: note.id })
    if (res.ok) void reload()
  }

  const saveSegment = async (seg: NoteSegment, patch: Partial<NoteSegment>): Promise<void> => {
    const res = await window.api.notes.updateSegment(seg.id, patch as { seg_type?: SegmentType; raw_text?: string; organized_text?: string })
    if (!res.ok) showToast(`保存失败：${res.error}`)
  }

  const removeSegment = async (id: string): Promise<void> => {
    const res = await window.api.notes.removeSegment(id)
    if (res.ok) void reload()
  }

  /* ---------- 标注操作 ---------- */

  const addAnnotation = async (segmentId: string, kind: 'keypoint' | 'question'): Promise<void> => {
    const res = await window.api.annotations.add({ segment_id: segmentId, kind })
    if (res.ok) void reload()
    else showToast(`标注失败：${res.error}`)
  }

  const saveAnnotationComment = async (ann: Annotation): Promise<void> => {
    const comment = window.prompt('标注备注（可留空）：', ann.comment)
    if (comment === null) return
    const res = await window.api.annotations.update(ann.id, comment)
    if (res.ok) void reload()
  }

  const removeAnnotation = async (id: string): Promise<void> => {
    const res = await window.api.annotations.remove(id)
    if (res.ok) void reload()
  }

  const annotationsOf = (segmentId: string): Annotation[] => note.annotations.filter((a) => a.segment_id === segmentId)

  return (
    <div className="page">
      <div className="toolbar">
        <Link to="/notes">← 笔记</Link>
        <button onClick={() => void window.api.classroom.retryPending(note.id).then((result) => {
          showToast(result.ok ? `已补整理 ${result.data} 段；未成功的条目保留待重试` : result.error)
          void reload()
        })}>补整理</button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title !== note.title) {
              void window.api.notes.update(note.id, { title: title.trim() }).then(() => void reload())
            }
          }}
          style={{ fontWeight: 700, fontSize: 16, flex: 1, maxWidth: 480 }}
        />
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <button
            style={{ borderRadius: 0, border: 'none', background: view === 'organized' ? 'var(--accent-weak)' : 'var(--bg-panel)', color: view === 'organized' ? 'var(--accent)' : 'var(--text)' }}
            onClick={() => setView('organized')}
          >
            整理视图
          </button>
          <button
            style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)', background: view === 'raw' ? 'var(--accent-weak)' : 'var(--bg-panel)', color: view === 'raw' ? 'var(--accent)' : 'var(--text)' }}
            onClick={() => setView('raw')}
          >
            原文视图
          </button>
        </div>
        <button className="primary" onClick={() => void addSegment()}>
          + 添加段落
        </button>
      </div>

      <div className="muted" style={{ marginBottom: 12 }}>
        {view === 'organized'
          ? '整理视图：显示整理后的内容（M1 起由课堂转写流水线自动生成）。选中文字后用底部快捷栏可标注。'
          : '原文视图：显示规整后的口语文本，用于核对与追溯。'}
      </div>

      {note.segments.length === 0 && (
        <div className="empty">
          还没有段落。点击「添加段落」开始记录；
          <br />
          段落可标记类型（定义 / 命题 / 例题 / 证明 / 解答 / 注意）。
        </div>
      )}

      {note.segments.map((seg) => {
        const meta = SEGMENT_TYPE_META[seg.seg_type]
        return (
          <div key={seg.id} className="segment" data-segment-id={seg.id} style={{ ['--seg-color' as string]: meta.color }}>
            <div className="segment-head">
              <span className="tag">{meta.label}</span>
              <select
                value={seg.seg_type}
                onChange={(e) => {
                  void saveSegment(seg, { seg_type: e.target.value as SegmentType }).then(() => void reload())
                }}
                style={{ fontSize: 12, padding: '2px 6px' }}
              >
                {Object.entries(SEGMENT_TYPE_META).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
              {annotationsOf(seg.id).map((a) => (
                <span
                  key={a.id}
                  className={`annotation-chip ${a.kind}`}
                  title={a.comment || (a.kind === 'keypoint' ? '重点' : '疑问')}
                  onClick={() => void saveAnnotationComment(a)}
                >
                  {a.kind === 'keypoint' ? '★' : '？'}
                  {a.comment ? a.comment.slice(0, 12) : a.kind === 'keypoint' ? '重点' : '疑问'}
                  <span
                    style={{ opacity: 0.5, marginLeft: 2 }}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeAnnotation(a.id)
                    }}
                  >
                    ×
                  </span>
                </span>
              ))}
              <span className="spacer" />
              <button title="标记重点" onClick={() => void addAnnotation(seg.id, 'keypoint')}>
                ★ 重点
              </button>
              <button title="标记疑问" onClick={() => void addAnnotation(seg.id, 'question')}>
                ？疑问
              </button>
              <button title="删除段落" onClick={() => void removeSegment(seg.id)}>
                删除
              </button>
            </div>
            <SegmentEditor
              segment={seg}
              view={view}
              onSave={(patch) => void saveSegment(seg, patch)}
            />
          </div>
        )
      })}
    </div>
  )
}

/** 段落文本编辑器：编辑当前视图对应字段，失焦保存 */
function SegmentEditor({
  segment,
  view,
  onSave
}: {
  segment: NoteSegment
  view: ViewMode
  onSave: (patch: { raw_text?: string; organized_text?: string }) => void
}) {
  const field = view === 'organized' ? 'organized_text' : 'raw_text'
  const [text, setText] = useState(segment[field])

  // 视图切换或外部刷新时同步
  useEffect(() => {
    setText(segment[field])
  }, [segment.id, field, segment[field]])

  return (
    <textarea
      value={text}
      placeholder={view === 'organized' ? '整理后的内容（支持 Markdown）…' : '原文/口语文本…'}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== segment[field]) onSave({ [field]: text })
      }}
    />
  )
}
