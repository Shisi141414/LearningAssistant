import { ClassroomGuidePanel } from '../components/ClassroomGuidePanel'
/**
 * pages/ClassroomPage.tsx —— 课堂模式（M1a）
 *
 * 链路：麦克风(16k PCM) → IPC → 主进程 sherpa-onnx 流式识别
 *      → partial 实时上屏 / final 落段 → AI 整理（自动，可关）→ 分色双视图 → 标注
 * 无语音引擎时降级为"手动转写模式"（粘贴/输入文本，管线一致）——ADR-0 离线优先。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Activity, AsrStatus, NoteWithSegments, MaterialAnchor, ClassroomPosition } from '@shared/types'
import { SEGMENT_TYPE_META } from '@shared/types'
import { MarkdownSegment } from '../components/MarkdownSegment'
import { MathInput } from '../components/MathInput'
import { useAppStore } from '../stores/app'
import { ClassroomMaterialPanel } from '../components/ClassroomMaterialPanel'
import { ClassroomAlignmentPanel } from '../components/ClassroomAlignmentPanel'
import { materialLocation } from '../utils/material'
import { NoteLearningReader } from '../components/NoteLearningReader'

type Phase = 'setup' | 'live'
type ViewMode = 'uniform' | 'organized' | 'raw'

/** 麦克风采集句柄 */
interface MicHandle {
  ctx: AudioContext
  stream: MediaStream
  stop: () => void
}

async function startMic(onChunk: (pcm: Int16Array) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const ctx = new AudioContext({ sampleRate: 16000 })
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessorNode 虽已标记废弃，但在 Electron 渲染进程稳定可用，且无需额外 worklet 文件（CSP 友好）
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0 // 不回放麦克风音频（防啸叫），仅驱动处理回调
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    const f32 = e.inputBuffer.getChannelData(0)
    const pcm = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    onChunk(pcm)
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)
  return {
    ctx,
    stream,
    stop: () => {
      processor.disconnect()
      source.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

export function ClassroomPage() {
  const mountedRef = useRef(true)
  const [params, setParams] = useSearchParams()
  const resumeId = params.get('note') ?? ''
  const [resumeNote, setResumeNote] = useState<NoteWithSegments | null>(null)
  const [resumeLoading, setResumeLoading] = useState(false)
  const [startAnchor, setStartAnchor] = useState<MaterialAnchor | null>(null)
  const [position, setPosition] = useState<ClassroomPosition | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ anchor: MaterialAnchor; token: number } | null>(null)
  const [calibrationRevision, setCalibrationRevision] = useState(0)
  const [materialRefsRevision, setMaterialRefsRevision] = useState(0)
  const calibrationGeneration = useRef(0)
  /* ---- setup ---- */
  const [phase, setPhase] = useState<Phase>('setup')
  const subjects = useAppStore((s) => s.subjects)
  const currentSubjectId = useAppStore((s) => s.currentSubjectId)
  const showToast = useAppStore((s) => s.showToast)
  const [activities, setActivities] = useState<Activity[]>([])
  const [attachMode, setAttachMode] = useState<'subject' | 'activity'>('subject')
  const [subjectId, setSubjectId] = useState(currentSubjectId ?? '')
  const [activityId, setActivityId] = useState('')
  const [title, setTitle] = useState('')
  const [asr, setAsr] = useState<AsrStatus | null>(null)
  const [starting, setStarting] = useState(false)

  /* ---- live ---- */
  const [note, setNote] = useState<NoteWithSegments | null>(null)
  const [partial, setPartial] = useState('')
  const [recording, setRecording] = useState(false)
  const [asrMode, setAsrMode] = useState(false) // 语音引擎是否在跑
  const [autoOrganize, setAutoOrganize] = useState(true)
  const [view, setView] = useState<ViewMode>('uniform')
  const [focusedSegment, setFocusedSegment] = useState('')
  // partial 变化不会刷新文档；只在持久化段落列表/正文改变后产生通知。
  const liveRevision = useMemo(() => ({}), [note?.segments])
  const liveDocument = useMemo(() => ({ revision: liveRevision, active: view === 'uniform' }), [liveRevision, view])
  const [organizingIds, setOrganizingIds] = useState<Set<string>>(new Set())
  const [manualText, setManualText] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const manualSavingRef = useRef(false)

  const micRef = useRef<MicHandle | null>(null)
  const noteRef = useRef<string | null>(null)
  const autoRef = useRef(autoOrganize)
  autoRef.current = autoOrganize
  const segmentsEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!resumeId) { setResumeNote(null); return }
    if (noteRef.current && phase === 'live' && noteRef.current !== resumeId) { showToast('请先结束当前课堂'); return }
    let alive = true
    setResumeLoading(true)
    void Promise.all([window.api.notes.get(resumeId), window.api.classroom.position(resumeId)]).then(([saved, cursor]) => {
      if (!alive) return
      setResumeLoading(false)
      if (!saved.ok) { showToast(saved.error); return }
      setResumeNote(saved.data); setTitle(saved.data.title)
      setSubjectId(saved.data.subject_id ?? ''); setActivityId(saved.data.activity_id ?? '')
      setAttachMode(saved.data.activity_id ? 'activity' : 'subject')
      if (cursor.ok) { setPosition(cursor.data); setStartAnchor(cursor.data?.block ?? null) }
      else showToast(cursor.error)
    })
    return () => { alive = false }
  }, [resumeId, showToast])

  useEffect(() => {
    void window.api.activities.list().then((r) => {
      if (r.ok) setActivities(r.data)
    })
    void window.api.classroom.asrStatus().then((r) => {
      if (r.ok) setAsr(r.data)
    })
  }, [])

  /** final 落段：入库 → 视图追加 → 触发整理 */
  const appendSegment = useCallback(
    async (text: string): Promise<boolean> => {
      const noteId = noteRef.current
      const content = text.trim()
      if (!noteId || !content) return false
      const res = await window.api.notes.addSegment({ note_id: noteId, raw_text: content, organized_text: content })
      if (!res.ok) {
        showToast(`段落保存失败：${res.error}`)
        return false
      }
      setNote((n) => n?.id === res.data.note_id && !n.segments.some(segment => segment.id === res.data.id) ? { ...n, segments: [...n.segments, res.data] } : n)
      if (autoRef.current) void triggerOrganize(res.data.id)
      return true
    },
    [showToast]
  )

  const triggerOrganize = useCallback(async (segmentId: string): Promise<void> => {
    setOrganizingIds((s) => new Set([...s, segmentId]))
    const res = await window.api.classroom.organizeSegment(segmentId)
    setOrganizingIds((s) => { const next = new Set(s); next.delete(segmentId); return next })
    if (!res.ok) {
      // 整理失败不阻断课堂（离线优先降级）：保留原文
      setOrganizingIds((s) => {
        const next = new Set(s)
        next.delete(segmentId)
        return next
      })
      showToast(`自动整理失败：${res.error}`)
    }
    // 成功路径经 onSegmentOrganized 事件统一处理（含删除 organizing 标记）
  }, [showToast])

  /** 事件订阅（live 阶段挂载） */
  useEffect(() => {
    const offPartial = window.api.onClassroomPartial((e) => setPartial(e.text))
    const offFinal = window.api.onClassroomFinal((e) => {
      setPartial('')
      setNote((n) => n?.id === e.segment.note_id && !n.segments.some(s => s.id === e.segment.id) ? { ...n, segments: [...n.segments, e.segment] } : n)
    })
    const offOrg = window.api.onSegmentOrganized((e) => {
      setOrganizingIds((s) => {
        const next = new Set(s)
        next.delete(e.segment_id)
        return next
      })
      setNote((n) =>
        n?.segments.some(segment => segment.id === e.segment_id)
          ? {
              ...n,
              segments: n.segments.map((seg) =>
                seg.id === e.segment_id ? { ...seg, seg_type: e.seg_type, organized_text: e.organized_text } : seg
              )
            }
          : n
      )
    })
    return () => {
      offPartial()
      offFinal()
      offOrg()
    }
  }, [])

  /** 离开页面/卸载清理 */
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      micRef.current?.stop()
      micRef.current = null
      void window.api.classroom.stop()
    }
  }, [])

  // 新段落时滚动到底
  useEffect(() => {
    if (view === 'uniform' || focusedSegment) return
    segmentsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [note?.segments.length, partial, view, focusedSegment])
  useEffect(() => {
    if (view === 'raw' && focusedSegment) window.document.getElementById(`classroom-segment-${focusedSegment}`)?.scrollIntoView({ block: 'center' })
  }, [view, focusedSegment])

  /* ---- actions ---- */

  const startSession = async (): Promise<void> => {
    setStarting(true)
    try {
      const defaultTitle = `${new Date().toLocaleDateString('zh-CN')} ${attachMode === 'subject' ? subjects.find((s) => s.id === subjectId)?.name ?? '课堂' : activities.find((a) => a.id === activityId)?.title ?? '活动'} 课堂记录`
      const res = resumeNote ? { ok: true as const, data: resumeNote } : await window.api.notes.create({
        title: title.trim() || defaultTitle,
        subject_id: attachMode === 'subject' && subjectId ? subjectId : null,
        activity_id: attachMode === 'activity' && activityId ? activityId : null,
        source: 'class'
      })
      if (!res.ok) throw new Error(res.error)
      noteRef.current = res.data.id
      const saved = resumeNote ?? { ...res.data, segments: [], annotations: [] }
      setNote(saved)
      setView('uniform'); setFocusedSegment('')
      setResumeNote(saved)
      const calibrated = await window.api.classroom.calibrate({ note_id: saved.id, block_id: startAnchor?.id ?? null })
      if (!calibrated.ok) throw new Error(calibrated.error)
      setPosition(calibrated.data); setFocusTarget(null)

      // 读取个性化配置（设置 → 个性化）
      const [autoRecordRes, autoOrganizeRes] = await Promise.all([
        window.api.config.get('classroom.autoRecord'),
        window.api.config.get('classroom.autoOrganize')
      ])
      setAutoOrganize(autoOrganizeRes.ok ? autoOrganizeRes.data !== '0' : true) // 默认开

      setPhase('live') // 事件订阅已在挂载时安装，录音前先显示课堂。
      const startRes = await window.api.classroom.start(res.data.id)
      if (startRes.ok) {
        setAsrMode(startRes.data.mode === 'asr')
        if (startRes.data.message) showToast(startRes.data.message)
        // 个性化：进课堂自动开始录音
        if (startRes.data.mode === 'asr' && autoRecordRes.ok && autoRecordRes.data === '1') {
          try {
            micRef.current = await startMic((pcm) => window.api.classroom.feedAudio(pcm))
            setRecording(true)
          } catch (e) {
            showToast(`自动录音启动失败：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } else {
        throw new Error(startRes.error)
      }
      setPhase('live')
    } catch (e) {
      setPhase('setup')
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      micRef.current?.stop()
      micRef.current = null
      setRecording(false)
      const flush = await window.api.classroom.flush()
      if (!flush.ok) showToast(flush.error)
      return
    }
    if (!asrMode) {
      showToast('语音引擎未运行（检查设置 → 语音引擎），当前为手动转写模式')
      return
    }
    try {
      micRef.current = await startMic((pcm) => window.api.classroom.feedAudio(pcm))
      setRecording(true)
    } catch (e) {
      showToast(`麦克风启动失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const endSession = async (): Promise<void> => {
    const route = window.location.href
    micRef.current?.stop()
    micRef.current = null
    setRecording(false)
    const stopped = await window.api.classroom.stop()
    if (!mountedRef.current || window.location.href !== route) return
    if (!stopped.ok) { showToast(stopped.error); return }
    if (noteRef.current) {
      const [saved, cursor] = await Promise.all([window.api.notes.get(noteRef.current), window.api.classroom.position(noteRef.current)])
      if (!mountedRef.current || window.location.href !== route) return
      if (saved.ok) { setNote(saved.data); setResumeNote(saved.data) }
      if (cursor.ok) { setPosition(cursor.data); setStartAnchor(cursor.data?.block ?? null) }
      setParams({ note: noteRef.current })
    }
    setPhase('setup')
    setPartial('')
  }

  const addManual = async (): Promise<void> => {
    if (manualSavingRef.current) return
    const draft = manualText
    const text = manualText.trim()
    if (!text) return
    manualSavingRef.current = true; setManualSaving(true)
    try {
      if (await appendSegment(text)) setManualText(value => value === draft ? '' : value)
    } finally { manualSavingRef.current = false; setManualSaving(false) }
  }

  const calibrate = async (anchor: MaterialAnchor | null): Promise<void> => {
    if (!noteRef.current) return
    const result = await window.api.classroom.calibrate({ note_id: noteRef.current, block_id: anchor?.id ?? null })
    if (result.ok) { calibrationGeneration.current++; setPosition(result.data); setStartAnchor(result.data.block); setFocusTarget(null); setCalibrationRevision(value => value + 1); showToast(anchor ? '讲授位置已校准，后续记录使用这里的来源' : '后续记录不关联教材') }
    else showToast(result.error)
  }

  const retryOrganization = async (): Promise<void> => {
    const noteId = noteRef.current
    if (!noteId || retrying) return
    setRetrying(true)
    try {
      const result = await window.api.classroom.retryPending(noteId)
      showToast(result.ok ? `已补整理 ${result.data} 段；失败项稍后可重试` : result.error)
      const saved = await window.api.notes.get(noteId)
      if (saved.ok && noteRef.current === noteId) setNote(saved.data)
    } finally { setRetrying(false) }
  }

  const openOriginal = useCallback(async (segmentId: string): Promise<void> => {
    const noteId = noteRef.current
    if (!noteId) return
    const saved = await window.api.notes.get(noteId)
    if (!mountedRef.current || noteRef.current !== noteId) return
    if (!saved.ok) { showToast(saved.error); return }
    if (!saved.data.segments.some(segment => segment.id === segmentId)) { showToast('当前段落已删除；当时的原始转写仍保留在统一文档来源中'); return }
    setNote(saved.data); setView('raw'); setFocusedSegment(segmentId)
  }, [showToast])
  const classroomNavigation = useMemo(() => ({ original: (segmentId: string) => void openOriginal(segmentId), material: (anchor: MaterialAnchor) => setFocusTarget({ anchor, token: Date.now() }) }), [openOriginal])

  /* ---- 渲染 ---- */

  if (phase === 'setup') {
    const ready = asr?.installed && asr?.modelReady
    return (
      <div className="page">
        <h1>课堂模式</h1>
        <div className="muted" style={{ marginBottom: 14 }}>
          实时语音转写 + AI 整理。语音引擎就绪后可边听边记；未就绪也可用手动转写模式（粘贴/输入），整理管线一致。
        </div>
        <div className="card" style={{ maxWidth: 680 }}>
          {resumeNote && <p>继续已有记录：<Link to={`/notes/${resumeNote.id}`}>{resumeNote.title}</Link>。已保存的教材位置会恢复。</p>}
          <div className="form-grid2">
            <div className="field">
              <label>挂载到</label>
              <select disabled={!!resumeNote} value={attachMode} onChange={(e) => setAttachMode(e.target.value as 'subject' | 'activity')}>
                <option value="subject">课程学科</option>
                <option value="activity">活动（讲座/会议）</option>
              </select>
            </div>
            {attachMode === 'subject' ? (
              <div className="field">
                <label>学科</label>
                <select disabled={!!resumeNote} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                  <option value="">（不挂载）</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label>活动</label>
                <select disabled={!!resumeNote} value={activityId} onChange={(e) => setActivityId(e.target.value)}>
                  <option value="">（不挂载）</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label>笔记标题（默认自动生成）</label>
              <input disabled={!!resumeNote} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：11月12日 数学分析 极限与连续" />
            </div>
          </div>

          <div style={{ marginTop: 14, padding: 10, borderRadius: 8, background: ready ? '#f0fdf4' : '#fffbeb', border: `1px solid ${ready ? '#bbf7d0' : '#fde68a'}` }}>
            {asr === null ? (
              <span className="muted">语音引擎状态检查中…</span>
            ) : ready ? (
              <span style={{ color: '#15803d' }}>语音引擎就绪（{asr.modelDir}）</span>
            ) : (
              <div style={{ fontSize: 13, color: '#b45309' }}>
                语音引擎未就绪：
                {!asr.installed && ' 未安装 sherpa-onnx-node（项目目录执行 npm install sherpa-onnx-node）'}
                {asr.installed && asr.modelDir && asr.missingFiles.length > 0 && ` 模型目录缺少 ${asr.missingFiles.join('、')}`}
                {!asr.modelDir && ' 未配置模型目录'}
                {' —— 可先用手动转写模式，稍后在'} <Link to="/settings">设置 → 语音引擎</Link> 配置
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <button className="primary" disabled={starting || resumeLoading || (!!resumeId && !resumeNote)} onClick={() => void startSession()}>
              {starting || resumeLoading ? '准备中…' : resumeNote ? '继续课堂' : ready ? '开始课堂（语音就绪）' : '开始课堂（手动转写模式）'}
            </button>
            {resumeNote && <button onClick={() => { setParams({}); setResumeNote(null); setTitle(''); setNote(null); noteRef.current = null; setPosition(null); setStartAnchor(null) }}>新建另一场课堂</button>}
          </div>
        </div>
        <div className="classroom-setup-material"><ClassroomMaterialPanel currentAnchor={startAnchor} onCalibrate={anchor => setStartAnchor(anchor)} /></div>
      </div>
    )
  }

  /* live 视图 */
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="toolbar" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{note?.title}</h1>
        {recording && (
          <span className="rec-indicator">
            <span className="dot" /> 录音中
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={autoOrganize} onChange={(e) => { setAutoOrganize(e.target.checked); void window.api.config.set('classroom.autoOrganize', e.target.checked ? '1' : '0') }} /> 自动整理
        </label>
        <div className="classroom-view-tabs" role="group" aria-label="课堂记录视图">
          <button aria-pressed={view === 'uniform'} onClick={() => setView('uniform')}>统一文档</button>
          <button
            style={{ borderRadius: 0, border: 'none', background: view === 'organized' ? 'var(--accent-weak)' : 'var(--bg-panel)', color: view === 'organized' ? 'var(--accent)' : 'var(--text)' }}
            aria-pressed={view === 'organized'} onClick={() => { setView('organized'); setFocusedSegment('') }}
          >
            整理视图
          </button>
          <button
            style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)', background: view === 'raw' ? 'var(--accent-weak)' : 'var(--bg-panel)', color: view === 'raw' ? 'var(--accent)' : 'var(--text)' }}
            aria-pressed={view === 'raw'} onClick={() => { setView('raw'); setFocusedSegment('') }}
          >
            原文视图
          </button>
        </div>
        {asrMode && (
          <button className={recording ? '' : 'primary'} onClick={() => void toggleRecording()}>
            {recording ? '⏹ 停止录音' : '🎤 开始录音'}
          </button>
        )}
        <button disabled={retrying} onClick={() => void retryOrganization()}>{retrying ? '正在补整理…' : '重试待整理'}</button>
        <button onClick={() => void endSession()}>结束课堂</button>
      </div>

      {note && <ClassroomAlignmentPanel noteId={note.id} onCalibrate={calibrate} onChange={async () => {
        const id = noteRef.current
        if (!id) return
        const generation = calibrationGeneration.current
        const [cursor, saved] = await Promise.all([window.api.classroom.position(id), window.api.notes.get(id)])
        if (!mountedRef.current || noteRef.current !== id || calibrationGeneration.current !== generation) return
        if (cursor.ok) setPosition(cursor.data)
        if (saved.ok) {
          const refs = new Map(saved.data.segments.map(item => [item.id, item.material_ref]))
          setNote(previous => previous ? { ...previous, segments: previous.segments.map(segment => ({ ...segment, material_ref: refs.has(segment.id) ? refs.get(segment.id) ?? null : segment.material_ref })) } : previous)
          setMaterialRefsRevision(value => value + 1)
        }
      }} />}
      {note && <ClassroomGuidePanel key={note.id} noteId={note.id} live onOriginal={segment => void openOriginal(segment)} onAnnotated={async () => {
        const id = noteRef.current
        if (!id) return
        const saved = await window.api.notes.get(id)
        if (saved.ok && noteRef.current === id) setNote(previous => previous ? { ...previous, annotations: saved.data.annotations } : previous)
      }} />}
      <div className="classroom-split">
      <ClassroomMaterialPanel live currentAnchor={position?.block ?? null} focusTarget={focusTarget} onCalibrate={calibrate} calibrationRevision={calibrationRevision} refsRevision={`${note?.segments.length ?? 0}:${materialRefsRevision}`} />
      <section className="classroom-transcript" aria-label="课堂转写">
      <div className="classroom-transcript-scroll">
        <div className="partial-line">
          {recording ? partial || '（聆听中…）' : asrMode ? '（未开始录音——点击「开始录音」）' : '（手动转写模式：在下方输入框记录）'}
        </div>
        {organizingIds.size > 0 && <p className="muted" role="status">正在整理 {organizingIds.size} 段；原始转写已保存。</p>}
        {note && <div hidden={view !== 'uniform'}><NoteLearningReader key={note.id} noteId={note.id} live={liveDocument} classroomNavigation={classroomNavigation} /></div>}
        {view !== 'uniform' && note?.segments.map((seg) => {
          const meta = SEGMENT_TYPE_META[seg.seg_type]
          const organizing = organizingIds.has(seg.id)
          const text = view === 'organized' ? seg.organized_text || seg.raw_text : seg.raw_text
          return (
            <div id={`classroom-segment-${seg.id}`} key={seg.id} className={`segment${focusedSegment === seg.id ? ' classroom-segment-focused' : ''}`} data-segment-id={seg.id} style={{ ['--seg-color' as string]: meta.color }}>
              <div className="segment-head">
                <span className="tag">{meta.label}</span>
                {organizing && <span className="organizing-tag">AI 整理中…</span>}
                {note.annotations
                  .filter((a) => a.segment_id === seg.id)
                  .map((a) => (
                    <span key={a.id} className={`annotation-chip ${a.kind}`}>
                      {a.kind === 'keypoint' ? '★' : '？'}
                      {a.comment ? a.comment.slice(0, 12) : a.kind === 'keypoint' ? '重点' : '疑问'}
                    </span>
                  ))}
                <span className="spacer" />
                <button style={{ fontSize: 12 }} title="重新 AI 整理" onClick={() => void triggerOrganize(seg.id)}>
                  整理
                </button>
                <button
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    void window.api.annotations.add({ segment_id: seg.id, kind: 'keypoint' }).then(() => {
                      void window.api.notes.get(seg.note_id).then((r) => {
                        if (r.ok) setNote(r.data)
                      })
                    })
                  }}
                >
                  ★
                </button>
                <button
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    void window.api.annotations.add({ segment_id: seg.id, kind: 'question' }).then(() => {
                      void window.api.notes.get(seg.note_id).then((r) => {
                        if (r.ok) setNote(r.data)
                      })
                    })
                  }}
                >
                  ？
                </button>
              </div>
              {seg.material_ref && <button className="classroom-source" onClick={() => setFocusTarget({ anchor: seg.material_ref!, token: Date.now() })}>{seg.material_ref.material_title} · {materialLocation(seg.material_ref)} · 查看来源</button>}
              <div className="md-seg-wrap">
                <MarkdownSegment text={text} subjectId={note?.subject_id} />
              </div>
            </div>
          )
        })}
        <div ref={segmentsEndRef} />
      </div>

      <div className="chat-input" style={{ border: '1px solid var(--border)', borderRadius: 10, marginBottom: 4 }}>
        <MathInput
          label="课堂手动记录"
          placeholder="手动转写/补充记录（Enter 添加段落，Shift+Enter 换行，∑ 数学符号）"
          value={manualText}
          onChange={setManualText}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void addManual()
            }
          }}
        />
        <button className="primary" disabled={manualSaving} onClick={() => void addManual()}>
          {manualSaving ? '正在保存…' : '添加段落'}
        </button>
      </div>
      </section>
      </div>
    </div>
  )
}
