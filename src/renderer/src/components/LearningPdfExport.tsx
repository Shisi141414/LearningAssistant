import { useState } from 'react'
import type { LearningPdfSource } from '@shared/learning-pdf'

export function LearningPdfExport({ source, disabled = false, onBusy, emptySources = 0 }: { source: LearningPdfSource; disabled?: boolean; onBusy?: (busy: boolean) => void; emptySources?: number }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [landscape, setLandscape] = useState(false), [original, setOriginal] = useState(source.kind === 'note')
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  const save = async () => {
    setBusy(true); onBusy?.(true); setMessage('正在排版所选修订的全部条目…'); setError('')
    try {
      const result = await window.api.learning.pdfExport({ source, landscape, include_original_text: original })
      if (!result.ok) { setMessage(''); setError(result.error) }
      else if (!result.data) setMessage('已取消保存。')
      else { const report = result.data; setMessage(`已保存 ${report.file_name} · ${report.entry_count} 个条目 · ${report.image_count} 张配图${report.scaled_formulas ? ` · ${report.scaled_formulas} 个公式缩放适配纸张` : ''}${report.empty_sources ? ` · ${report.empty_sources} 段来源尚无文字，请对照原件` : ''}。`) }
    } catch (reason) { setMessage(''); setError(reason instanceof Error ? reason.message : '导出失败，请重试') }
    finally { setBusy(false); onBusy?.(false) }
  }
  return <div className="learning-pdf-export">
    <button disabled={disabled || busy} onClick={() => setOpen(value => !value)}>{open ? '收起 PDF 选项' : '导出 PDF'}</button>
    {open && <div><p className="muted">保存当前所选修订的全部条目；搜索与类型筛选不会删减导出内容。按条目重新排版，原件仍单独保管。</p>
    {emptySources > 0 && <p role="status">有 {emptySources} 段来源尚无文字，本次只保留其来源位置和已关联配图。需要扫描页正文时，请先识别相应页面。</p>}<div className="toolbar">
      <label>纸张方向 <select aria-label="PDF 纸张方向" value={landscape ? 'landscape' : 'portrait'} disabled={busy} onChange={event => setLandscape(event.target.value === 'landscape')}><option value="portrait">A4 纵向</option><option value="landscape">A4 横向</option></select></label>
      <label><input type="checkbox" checked={original} disabled={busy} onChange={event => setOriginal(event.target.checked)} />附来源文字{source.kind === 'note' && '与原始转写'}</label>
      <button className="primary" disabled={disabled || busy} onClick={() => void save()}>选择位置并保存 PDF</button>
      {busy && <button onClick={() => void window.api.learning.pdfCancel().then(result => { if (!result.ok) setError(result.error); else if (!result.data) setMessage('尚未开始排版或文件已保存；如保存窗口仍打开，可在该窗口取消。') })}>取消 PDF 导出</button>}
    </div></div>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
