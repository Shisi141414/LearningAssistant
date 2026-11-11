import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Material, MaterialAnchor, MaterialBlock, MaterialDetail, MaterialLocator, MaterialNoteRef } from '@shared/types'
import { useAppStore } from '../stores/app'
import { materialLocation } from '../utils/material'
import { PdfPage } from './PdfPage'
import './classroom-material.css'

export function ClassroomMaterialPanel({ currentAnchor, focusTarget, onCalibrate, live = false, refsRevision = 0 }: {
  currentAnchor: MaterialAnchor | null
  focusTarget?: { anchor: MaterialAnchor; token: number } | null
  onCalibrate: (anchor: MaterialAnchor | null) => Promise<void> | void
  live?: boolean
  refsRevision?: number
}) {
  const showToast = useAppStore(s => s.showToast)
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialId, setMaterialId] = useState(currentAnchor?.material_id ?? '')
  const [versionId, setVersionId] = useState(currentAnchor?.version_id ?? '')
  const [detail, setDetail] = useState<MaterialDetail | null>(null)
  const [block, setBlock] = useState<MaterialAnchor | null>(currentAnchor)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MaterialBlock[]>([])
  const [searchOffset, setSearchOffset] = useState(0)
  const [searchTotal, setSearchTotal] = useState(0)
  const [refs, setRefs] = useState<MaterialNoteRef[]>([])
  const [location, setLocation] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  useEffect(() => {
    let alive = true
    void window.api.materials.list().then(result => {
      if (!alive) return
      if (result.ok) setMaterials(result.data)
      else setError(result.error)
    })
    return () => { alive = false; requestId.current++ }
  }, [])
  useEffect(() => {
    if (currentAnchor) { requestId.current++; setMaterialId(currentAnchor.material_id); setVersionId(currentAnchor.version_id); setBlock(currentAnchor) }
  }, [currentAnchor?.id])
  useEffect(() => {
    if (focusTarget) { requestId.current++; setMaterialId(focusTarget.anchor.material_id); setVersionId(focusTarget.anchor.version_id); setBlock(focusTarget.anchor) }
  }, [focusTarget])
  useEffect(() => {
    setDetail(null)
    if (!materialId) return
    let alive = true
    void window.api.materials.get(materialId).then(result => {
      if (!alive) return
      if (!result.ok) { setError(result.error); return }
      setDetail(result.data)
      setVersionId(previous => result.data.versions.some(v => v.id === previous && v.status === 'ready') ? previous : result.data.versions.find(v => v.id === result.data.material.current_version_id && v.status === 'ready')?.id ?? result.data.versions.find(v => v.status === 'ready')?.id ?? '')
    })
    return () => { alive = false }
  }, [materialId])
  useEffect(() => {
    setQuery(''); setSearchOffset(0); setError('')
    if (!versionId || block?.version_id === versionId) return
    let alive = true
    const id = ++requestId.current
    void window.api.materials.locate({ version_id: versionId, unit: 'block', index: 1 }).then(result => {
      if (!alive || id !== requestId.current) return
      if (result.ok) setBlock(result.data)
      else setError(result.error)
    })
    return () => { alive = false }
  }, [versionId])
  useEffect(() => {
    if (block) {
      const locator = JSON.parse(block.locator_json) as MaterialLocator
      setLocation(String(locator.page ?? locator.slide ?? block.ordinal + 1))
    }
    setRefs([])
    if (!block) return
    let alive = true
    void window.api.materials.references(block.id).then(result => { if (alive && result.ok) setRefs(result.data) })
    return () => { alive = false }
  }, [block?.id, refsRevision])
  useEffect(() => {
    setResults([]); setSearchTotal(0)
    if (!query.trim() || !versionId) return
    let alive = true
    const timer = setTimeout(() => {
      void window.api.materials.blocks({ version_id: versionId, query, offset: searchOffset }).then(result => {
        if (!alive) return
        if (result.ok) { setResults(result.data.blocks); setSearchTotal(result.data.total) }
        else setError(result.error)
      })
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, versionId, searchOffset])

  const selectBlock = async (id: string): Promise<void> => {
    const ticket = ++requestId.current
    const result = await window.api.materials.anchor(id)
    if (ticket !== requestId.current) return
    if (result.ok) { setBlock(result.data); setError('') }
    else setError(result.error)
  }
  const locate = async (index: number, unit: 'block' | 'page' | 'slide'): Promise<void> => {
    if (!Number.isSafeInteger(index) || index < 1 || index > 50_000) { setError('请输入有效的位置编号'); return }
    const ticket = ++requestId.current
    const result = await window.api.materials.locate({ version_id: versionId, index, unit })
    if (ticket !== requestId.current) return
    if (result.ok && result.data) { setBlock(result.data); setError('') }
    else setError(result.ok ? '该版本没有这个位置' : result.error)
  }
  const confirm = async (anchor: MaterialAnchor | null): Promise<void> => {
    setBusy(true)
    try { await onCalibrate(anchor) } finally { setBusy(false) }
  }
  const locator = block ? JSON.parse(block.locator_json) as MaterialLocator : null
  const unit = block?.format === 'pdf' ? 'page' : block?.format === 'pptx' ? 'slide' : 'block'
  return <section className="classroom-material" aria-label="课堂教材">
    <h2>{live ? '课堂教材' : '本讲材料与开始点'}</h2>
    <p className="muted">{live ? '浏览不会改变讲授位置；校准后，后续记录才关联到这里。' : '可提前选定本讲开始位置，也可不关联教材。'}</p>
    <div className="classroom-material-picker">
      <select aria-label="课堂材料" value={materialId} onChange={e => { requestId.current++; setMaterialId(e.target.value); setVersionId(''); setBlock(null) }}>
        <option value="">选择学习材料</option>{materials.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}
        {materialId && !materials.some(item => item.id === materialId) && <option value={materialId}>{block?.material_title ?? '已归档材料'}</option>}
      </select>
      {detail && <select aria-label="课堂材料版本" value={versionId} onChange={e => { requestId.current++; setVersionId(e.target.value); setBlock(null) }}><option value="">选择可阅读版本</option>{detail.versions.filter(v => v.status === 'ready').map((v, index) => <option key={v.id} value={v.id}>{v.file_name} · {new Date(v.created_at).toLocaleDateString('zh-CN')} · {index === 0 ? '较新' : '历史'}</option>)}</select>}
    </div>
    {!materials.length && <p className="muted">先到 <Link to="/library">材料库</Link> 导入教材、讲义或课件。</p>}
    {detail && !versionId && <p role="status">此材料暂时没有可阅读版本，请先完成解析。</p>}
    <div className="classroom-current" role="status">
      <strong>{live ? '当前讲到' : '已选起点'}：</strong>{currentAnchor ? `${currentAnchor.material_title} · ${materialLocation(currentAnchor)}` : '未关联教材'}
      {currentAnchor && currentAnchor.id !== block?.id && <button onClick={() => { setMaterialId(currentAnchor.material_id); setVersionId(currentAnchor.version_id); setBlock(currentAnchor) }}>回到讲授位置</button>}
    </div>
    {error && <p role="alert" className="material-error">{error}</p>}
    {block && <>
      <div className="classroom-location-controls">
        <button onClick={() => void locate(block.ordinal, 'block')} disabled={block.ordinal === 0}>上一条</button>
        <label>{unit === 'page' ? '页码' : unit === 'slide' ? '幻灯片' : '条目'}<input aria-label="跳转教材位置" inputMode="numeric" value={location} onChange={e => setLocation(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void locate(Number(location), unit) }} /></label>
        <button onClick={() => void locate(Number(location), unit)}>跳转</button><button onClick={() => void locate(block.ordinal + 2, 'block')}>下一条</button>
      </div>
      <div className="classroom-calibrate-actions">
        <button className="primary" disabled={busy} onClick={() => void confirm(block)}>{live ? '校准到这里' : '设为本讲起点'}</button>
        <button disabled={busy || !currentAnchor} onClick={() => void confirm(null)}>不关联教材</button>
        <button onClick={() => void window.api.materials.open(block.version_id).then(result => { if (!result.ok) showToast(result.error) })}>打开原件</button>
      </div>
      <input aria-label="搜索课堂教材" placeholder="搜索本版本的标题或正文…" value={query} onChange={e => { setQuery(e.target.value); setSearchOffset(0) }} />
      {query.trim() && <div className="classroom-search-results" aria-label="教材搜索结果">
        <span className="muted">{searchTotal} 个结果</span>{results.map(result => <button key={result.id} onClick={() => void selectBlock(result.id)}>{materialLocation(result)} · {result.text.slice(0, 90)}</button>)}
        <div><button disabled={searchOffset === 0} onClick={() => setSearchOffset(Math.max(0, searchOffset - 100))}>上一批</button><button disabled={searchOffset + 100 >= searchTotal} onClick={() => setSearchOffset(searchOffset + 100)}>下一批</button></div>
      </div>}
      <h3>{block.material_title} · {materialLocation(block)}</h3>
      {locator?.page && block.format === 'pdf' ? <PdfPage versionId={block.version_id} pageNumber={locator.page} /> : <p className="muted">当前展示提取文字；完整图像、公式与排版请打开原件。</p>}
      <div className="classroom-excerpt">{block.heading && <strong>{block.heading}</strong>}<p>{block.text}</p></div>
      {refs.length > 0 && <details className="classroom-backlinks"><summary>关联记录（{refs.length}）</summary>{refs.map(ref => <Link key={ref.segment_id} to={`/notes/${ref.note_id}?segment=${ref.segment_id}`}>{ref.title}：{ref.raw_text}</Link>)}</details>}
    </>}
  </section>
}
