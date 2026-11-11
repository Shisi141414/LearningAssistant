import { useEffect, useRef, useState } from 'react'
import type { MaterialVersion, OcrModelsStatus, OcrPage } from '@shared/types'
import { readableOcr } from '@shared/material-ocr'
import { PdfPage } from './PdfPage'

export function MaterialOcrPanel({ version, onVersion }: { version: MaterialVersion; onVersion: (id: string) => Promise<void> }) {
  const [opened, setOpened] = useState(false)
  return <details className="material-ocr" onToggle={event => { if (event.currentTarget.open) setOpened(true) }}>
    <summary>扫描页识别与校正 <span className="muted">· 本地处理 · 每次最多 20 页</span></summary>
    {opened && <OcrEditor key={version.id} version={version} onVersion={onVersion} />}
  </details>
}
function OcrEditor({ version, onVersion }: { version: MaterialVersion; onVersion: (id: string) => Promise<void> }) {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [models, setModels] = useState<OcrModelsStatus | null>(null)
  const [from, setFrom] = useState(1), [to, setTo] = useState(1)
  const [page, setPage] = useState(1)
  const [source, setSource] = useState<OcrPage | null>(null)
  const [draft, setDraft] = useState(''), [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const dirty = draft !== saved
  useEffect(() => {
    let alive = true
    void window.api.materials.ocrModels().then(result => { if (!alive) return; if (result.ok) setModels(result.data); else setError(result.error) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    let alive = true
    setLoading(true); setSource(null); setDraft(''); setSaved('')
    void window.api.materials.ocrPage({ version_id: version.id, page }).then(result => {
      if (!alive) return
      setLoading(false)
      if (!result.ok) { setError(result.error); return }
      setSource(result.data)
      const text = result.data ? result.data.corrected_text ?? readableOcr(result.data.raw_text) : ''
      setDraft(text); setSaved(text)
    })
    return () => { alive = false }
  }, [version.id, page])
  const prepare = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.materials.ocrPrepare(); if (result.ok) setModels(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const run = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.materials.ocrStart({ version_id: version.id, from_page: from, to_page: to }); if (!mounted.current) return; if (result.ok) await onVersion(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const save = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.materials.ocrCorrect({ version_id: version.id, page, text: draft }); if (!mounted.current) return; if (result.ok) await onVersion(result.data); else setError(result.error) }
    finally { setBusy(false) }
  }
  const validRange = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from && to <= 3000 && to - from < 20
  return <div className="ocr-editor">
    <p className="muted">保留原件和旧版引用；识别或校正后生成新版本。请对照原页核对公式、表格与阅读顺序。</p>
    <div className="toolbar">
      <span role="status">{models ? models.ready ? '中英文语言包已就绪' : '尚未准备语言包' : '正在检查语言包…'}</span>
      {models && !models.ready && <button disabled={busy} onClick={() => void prepare()}>{busy ? '正在准备…' : '下载中英文语言包（约 6 MiB）'}</button>}
    </div>
    <div className="toolbar ocr-range">
      <label>从第 <input aria-label="OCR 起始页" type="number" min={1} max={3000} value={from} onChange={e => setFrom(Number(e.target.value))} /> 页</label>
      <label>至第 <input aria-label="OCR 结束页" type="number" min={from} max={Math.min(3000, from + 19)} value={to} onChange={e => setTo(Number(e.target.value))} /> 页</label>
      <button className="primary" disabled={busy || dirty || !models?.ready || !validRange} onClick={() => void run()}>识别为新版本</button>
      <span className="muted">使用 PDF 实际页序号</span>
    </div>
    {error && <p role="alert" className="material-error">{error}</p>}
    <div className="toolbar"><label>核对第 <input aria-label="OCR 核对页" type="number" min={1} max={3000} value={page} disabled={dirty || busy} onChange={e => { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= 1 && n <= 3000) setPage(n) }} /> 页</label>
      {source && <span className="muted">{source.corrected_text !== null ? '已有人工校正' : '尚未人工校正'} · 识别分数 {Math.round(source.confidence)} / 100</span>}
    </div>
    <div className="ocr-compare">
      <div className="ocr-original"><PdfPage versionId={version.id} pageNumber={page} /></div>
      <div className="ocr-correction">
        {loading ? <p role="status">正在读取识别文字…</p> : source ? <>
          <details><summary>查看 OCR 原文</summary><pre>{source.raw_text || '未识别出文字'}</pre></details>
          <label htmlFor="ocr-correction">校正文字</label>
          <textarea id="ocr-correction" aria-label="OCR 校正文字" maxLength={100_000} value={draft} onChange={e => setDraft(e.target.value)} />
          <div className="toolbar"><button className="primary" disabled={busy || !dirty || !draft.trim()} onClick={() => void save()}>保存为校正版</button>
            {dirty && <><button disabled={busy} onClick={() => setDraft(saved)}>放弃本页修改</button><span className="muted">本页修改尚未保存</span></>}
          </div>
        </> : <p className="muted">这一页尚未识别。先在上方选择页码范围，识别后可在这里校正文字。</p>}
      </div>
    </div>
  </div>
}
