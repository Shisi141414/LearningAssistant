import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { ApiResult, Material, MaterialBlock, MaterialDetail, MaterialKind, MaterialVersion, MaterialNoteRef } from '@shared/types'
import { useAppStore } from '../stores/app'
import './materials.css'
import { materialLocation, materialHref } from '../utils/material'
import { ConceptText } from '../components/ConceptText'
import { MaterialOcrPanel } from '../components/MaterialOcrPanel'
import { LearningReader } from '../components/LearningReader'

const kinds: Record<MaterialKind, string> = { textbook: '教材', handout: '讲义', slides: '课件', supplement: '补充材料' }
const statuses: Record<MaterialVersion['status'], string> = { queued: '等待解析', parsing: '正在解析', ready: '可阅读', failed: '解析失败', cancelled: '已取消' }
const pending = (v?: MaterialVersion): boolean => v?.status === 'queued' || v?.status === 'parsing'

export function MaterialLibraryPage() {
  const { subjects, currentSubjectId, showToast } = useAppStore()
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('material') ?? ''
  const requestedVersion = params.get('version') ?? ''
  const [items, setItems] = useState<Material[]>([])
  const [detail, setDetail] = useState<MaterialDetail | null>(null)
  const [blocks, setBlocks] = useState<MaterialBlock[]>([])
  const [noteRefs, setNoteRefs] = useState<MaterialNoteRef[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [subject, setSubject] = useState(currentSubjectId ?? '')
  const [kind, setKind] = useState<MaterialKind>('textbook')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'source' | 'learning'>('source')
  const versionId = requestedVersion || detail?.material.current_version_id || ''
  const selectedVersion = detail?.versions.find(v => v.id === versionId)

  useEffect(() => { setSubject(currentSubjectId ?? '') }, [currentSubjectId])
  const linkedOffset = params.get('offset') ?? '0'
  const linkedBlock = params.get('block') ?? ''
  useEffect(() => { setView('source') }, [versionId, linkedBlock])
  useEffect(() => {
    setNoteRefs([])
    if (!linkedBlock) return
    let alive = true
    void window.api.materials.references(linkedBlock).then(result => { if (alive && result.ok) setNoteRefs(result.data) })
    return () => { alive = false }
  }, [linkedBlock])
  useEffect(() => {
    if (!linkedBlock) return
    const value = Number(linkedOffset)
    setOffset(Number.isSafeInteger(value) && value >= 0 && value <= 50_000 ? value : 0)
    setQuery('')
  }, [linkedOffset, linkedBlock])
  const reload = useCallback(async () => {
    const result = await window.api.materials.list(currentSubjectId ?? undefined)
    if (result.ok) setItems(result.data)
    else setError(result.error)
  }, [currentSubjectId])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    setDetail(null); setBlocks([]); setQuery('')
    if (!linkedBlock) setOffset(0)
    if (!selectedId) return
    let alive = true
    const load = async (): Promise<void> => {
      const result = await window.api.materials.get(selectedId)
      if (!alive) return
      if (result.ok) { setDetail(result.data); setError('') }
      else setError(result.error)
    }
    void load()
    const timer = setInterval(() => { void load() }, 1500)
    return () => { alive = false; clearInterval(timer) }
  }, [selectedId])
  useEffect(() => {
    if (!items.some(item => pending(item.version))) return
    const timer = setInterval(() => { void reload() }, 1500)
    return () => clearInterval(timer)
  }, [items, reload])
  useEffect(() => {
    setBlocks([]); setTotal(0)
    if (!versionId || selectedVersion?.status !== 'ready') return
    let alive = true
    const timer = setTimeout(() => {
      void window.api.materials.blocks({ version_id: versionId, query, offset }).then(result => {
        if (!alive) return
        if (result.ok) { setBlocks(result.data.blocks); setTotal(result.data.total) }
        else setError(result.error)
      })
    }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [versionId, selectedVersion?.status, query, offset])
  useEffect(() => {
    const anchor = params.get('block')
    if (anchor && blocks.length) document.getElementById(`material-${anchor}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [params, blocks])

  const importFile = async (newVersion = false): Promise<void> => {
    const targetSubject = newVersion ? detail?.material.subject_id : subject
    if (!targetSubject) { showToast('请先选择材料所属学科'); return }
    setBusy(true)
    try {
      const result = await window.api.materials.import({ subject_id: targetSubject, kind: newVersion && detail ? detail.material.kind : kind, ...(newVersion ? { material_id: selectedId } : {}) })
      if (!result.ok) showToast(result.error)
      else if (result.data) {
        setParams({ material: result.data.id, version: result.data.current_version_id ?? '' })
        const next = await window.api.materials.get(result.data.id)
        if (next.ok) setDetail(next.data)
        setOffset(0); setQuery(''); await reload()
      }
    } finally { setBusy(false) }
  }
  const action = async (promise: Promise<ApiResult<boolean>>): Promise<void> => {
    const result = await promise
    if (!result.ok) showToast(result.error)
    else { await reload(); if (selectedId) { const next = await window.api.materials.get(selectedId); if (next.ok) setDetail(next.data) } }
  }
  return <div className="page material-page">
    <h1>材料库</h1>
    <p className="muted">把教材、讲义和课件整理成可定位的学习条目，保留每一版原件。</p>
    <div className="toolbar material-import">
      <select aria-label="材料所属学科" value={subject} onChange={e => setSubject(e.target.value)}><option value="">选择所属学科</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <select aria-label="材料类别" value={kind} onChange={e => setKind(e.target.value as MaterialKind)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <button className="primary" disabled={busy || !subject} onClick={() => void importFile()}>{busy ? '正在导入…' : '+ 导入材料'}</button>
      <span className="muted">PDF / DOCX / PPTX · 每件最多 50 MiB</span>
    </div>
    {error && <p role="alert" className="material-error">{error}</p>}
    <div className="material-workspace">
      <aside className="material-shelf" aria-label="材料书架">
        <div className="material-shelf-label">{currentSubjectId ? subjects.find(s => s.id === currentSubjectId)?.name : '全部学科'} · {items.length} 件</div>
        {!items.length && <div className="empty">还没有学习材料。选择学科后导入第一份。</div>}
        {items.map(item => <button className={`material-book ${selectedId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setParams({ material: item.id })}>
          <span className="material-book-kind">{kinds[item.kind]}</span><strong>{item.title}</strong>
          <span className="muted">{subjects.find(s => s.id === item.subject_id)?.name ?? '未分类'}</span>
          {item.version && <span className="material-status">{statuses[item.version.status]}{pending(item.version) ? ` ${item.version.progress}%` : ''}</span>}
        </button>)}
      </aside>
      <section className="material-reader" aria-label="材料阅读区">
        {!detail ? <div className="empty">{selectedId ? '正在读取材料…' : '从左侧选择材料开始阅读。'}<p className="muted">旧版 DOC / PPT 请先转为 DOCX / PPTX；扫描件需要 OCR。</p></div> : <>
          <h2>{detail.material.title}</h2>
          <div className="toolbar">
            <select aria-label="材料版本" value={versionId} onChange={e => { setParams({ material: selectedId, version: e.target.value }); setOffset(0); setQuery('') }}>{detail.versions.map((v, index) => <option key={v.id} value={v.id}>版本 {detail.versions.length - index} · {{ original: '原始提取', ocr: 'OCR', correction: '人工校正' }[v.derivation]} · {v.file_name} · {statuses[v.status]}</option>)}</select>
            <button disabled={!versionId} onClick={() => void action(window.api.materials.open(versionId))}>打开原件</button>
            <button disabled={busy || !!detail.material.archived} onClick={() => void importFile(true)}>导入新版本</button>
          </div>
          {selectedVersion && <>
            <div className="material-status" role="status">{statuses[selectedVersion.status]}{pending(selectedVersion) && <> · {selectedVersion.progress}% <button onClick={() => void action(window.api.materials.cancel(versionId))}>取消解析</button><progress value={selectedVersion.progress} max={100} /></>}</div>
            {selectedVersion.error && <p role="alert" className="material-error">{selectedVersion.error}</p>}
            {['failed', 'cancelled'].includes(selectedVersion.status) && <button onClick={() => void action(window.api.materials.retry(versionId))}>重新解析</button>}
            {selectedVersion.warnings_json !== '[]' && <details className="material-warnings"><summary>提取说明与待处理内容</summary>{(JSON.parse(selectedVersion.warnings_json) as string[]).map((warning, i) => <p key={i}>{warning}</p>)}</details>}
          </>}
          {selectedVersion?.status === 'ready' && <>
            <div className="toolbar"><button aria-pressed={view === 'source'} onClick={() => setView('source')}>来源检索</button><button aria-pressed={view === 'learning'} onClick={() => setView('learning')}>学习文档</button></div>
            {view === 'learning' ? <LearningReader key={versionId} versionId={versionId} subjectId={detail.material.subject_id} /> : <>
            {selectedVersion.format === 'pdf' && <MaterialOcrPanel key={versionId} version={selectedVersion} onVersion={async id => {
              const next = await window.api.materials.get(selectedId)
              if (next.ok) setDetail(next.data)
              setParams({ material: selectedId, version: id }); setQuery(''); setOffset(0); await reload()
            }} />}
            <div className="toolbar material-search"><input aria-label="搜索材料条目" placeholder="搜索本版本的正文或标题…" value={query} onChange={e => { setQuery(e.target.value); setOffset(0) }} /><span className="muted">{total} 个条目</span></div>
            {blocks.map(block => <article id={`material-${block.id}`} className={`material-block ${params.get('block') === block.id ? 'anchored' : ''}`} key={block.id}>
              <Link className="material-anchor" to={materialHref(selectedId, block)}>{materialLocation(block)} · #{block.ordinal + 1}</Link>
              {block.heading && <h3><ConceptText text={block.heading} subjectId={detail.material.subject_id} /></h3>}<p><ConceptText text={block.text} subjectId={detail.material.subject_id} /></p>
              {linkedBlock === block.id && noteRefs.length > 0 && <details open className="classroom-backlinks"><summary>关联课堂记录（{noteRefs.length}）</summary>{noteRefs.map(ref => <Link key={ref.segment_id} to={`/notes/${ref.note_id}?segment=${ref.segment_id}`}>{ref.title}：{ref.raw_text}</Link>)}</details>}
            </article>)}
            {!blocks.length && <div className="empty">没有匹配的条目。</div>}
            <div className="toolbar"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>上一批</button><span className="muted">{total ? offset + 1 : 0}–{Math.min(total, offset + 100)} / {total}</span><button disabled={offset + 100 >= total} onClick={() => setOffset(offset + 100)}>下一批</button></div>
            </>}
          </>}
        </>}
      </section>
    </div>
  </div>
}
