import { useState } from 'react'
import type { LearningCropRect, LearningDocument, MaterialLocator } from '@shared/types'
import { validLearningCropRect } from '@shared/learning-crops'
import { PdfPage } from './PdfPage'

export function LearningPdfCrop({ document, busy, onBusy, onUpdated, onError }: { document: LearningDocument; busy: boolean; onBusy: (value: boolean) => void; onUpdated: (document: LearningDocument) => void; onError: (value: string) => void }) {
  const first = (JSON.parse(document.sources[0]?.locator_json ?? '{}') as MaterialLocator).page ?? 1
  const [page, setPage] = useState(String(first)), [shown, setShown] = useState<number | null>(null)
  const [rect, setRect] = useState<LearningCropRect | null>(null), [fields, setFields] = useState(['10', '10', '50', '40'])
  const [saving, setSaving] = useState(false)
  const labels = ['左侧百分比', '顶部百分比', '宽度百分比', '高度百分比']
  const select = (value: LearningCropRect | null): void => { setRect(value); if (value) setFields(value.map(n => String(Number((n * 100).toFixed(6))))) }
  const show = (): void => {
    const number = Number(page)
    if (!Number.isSafeInteger(number) || number < 1 || number > 100_000) { onError('请输入 PDF 实际页序号'); return }
    onError(''); setRect(null); setShown(number)
  }
  const save = async (): Promise<void> => {
    if (!shown || !rect) return
    setSaving(true); onBusy(true); onError('')
    try {
      const result = await window.api.learning.assetsCrop({ version_id: document.version_id, page: shown, rect })
      if (result.ok) { onUpdated(result.data); setRect(null) } else onError(result.error)
    } finally { setSaving(false); onBusy(false) }
  }
  return <section className="learning-pdf-crop" aria-label="PDF 选区配图">
    <div className="toolbar"><label>PDF 页码 <input aria-label="配图 PDF 页码" type="number" min="1" max="100000" step="1" value={page} disabled={busy} onChange={e => { setPage(e.target.value); setShown(null); setRect(null) }} /></label><button disabled={busy} onClick={show}>选择 PDF 配图</button>{shown && <button disabled={busy} onClick={() => { setShown(null); setRect(null) }}>收起原页</button>}</div>
    {shown && <>
      <p className="muted">第 {shown} 页。拖动框选，或填写位置和大小后应用选区。保存后在“整理条目”中确认归属；不识别图中文字。</p>
      <PdfPage key={`${document.version_id}:${shown}`} versionId={document.version_id} pageNumber={shown} selection={{ value: rect, onChange: select, disabled: busy }} />
      <div className="learning-crop-fields">{labels.map((label, index) => <label key={label}>{label}<input aria-label={`配图${label}`} type="number" min="0" max="100" step="0.1" value={fields[index]} disabled={busy} onChange={event => { setRect(null); setFields(values => values.map((value, i) => i === index ? event.target.value : value)) }} /></label>)}<button disabled={busy} onClick={() => { const next = fields.map(value => value.trim() ? Number(value) / 100 : NaN); if (!validLearningCropRect(next)) onError('选区须在页面内，宽高均大于零，位置和大小使用百分比'); else { onError(''); select(next) } }}>应用选区</button></div>
      <div className="toolbar"><button className="primary" disabled={busy || !rect} onClick={() => void save()}>{saving ? '正在保存选区…' : '保存选区配图'}</button><button disabled={busy || !rect} onClick={() => setRect(null)}>清除选区</button>{saving && <button onClick={() => void window.api.learning.assetsCancel(document.version_id).then(result => { if (!result.ok) onError(result.error) })}>取消保存配图</button>}</div>
    </>}
  </section>
}
