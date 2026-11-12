import { useState } from 'react'
import type { LearningAsset, LearningChange, LearningDocument, LearningFigure, MaterialLocator } from '@shared/types'

export function learningAssetLocation(asset: LearningAsset): string {
  const location = JSON.parse(asset.locator_json) as MaterialLocator
  return location.slide ? `幻灯片 ${location.slide} · ${location.source?.replace('image:', '图片位置 ')}` : `Word 结构位置 ${location.source?.replace('image:', '')}`
}
function AssetImage({ asset }: { asset: LearningAsset }) {
  const [failed, setFailed] = useState(false)
  return failed ? <p role="status">配图无法读取或校验失败，请对照保留的原件。</p> : <img src={`study-material://learning-assets/${asset.id}`} alt={asset.alt_text || '教材配图'} loading="lazy" onError={() => setFailed(true)} />
}
export function LearningAssetPanel({ document, editable, busy, onBusy, onUpdated, onError }: { document: LearningDocument; editable: boolean; busy: boolean; onBusy: (value: boolean) => void; onUpdated: (document: LearningDocument) => void; onError: (value: string) => void }) {
  const [extracting, setExtracting] = useState(false)
  const isPdf = document.sources.some(source => (JSON.parse(source.locator_json) as MaterialLocator).kind === 'pdf')
  const extract = async (): Promise<void> => {
    setExtracting(true); onBusy(true); onError('')
    try { const result = await window.api.learning.assetsPrepare(document.version_id); if (result.ok) onUpdated(result.data); else onError(result.error) }
    finally { setExtracting(false); onBusy(false) }
  }
  return <details className="learning-assets"><summary>文档配图 · {document.assets?.length ?? 0} 张</summary>
    <p className="muted">从 Word/PPT 提取内嵌 PNG/JPEG，再在“整理条目”中确认图文归属。图表、矢量图及 PDF 页内配图请对照原件；此操作不识别图片内容。</p>
    {isPdf && <p className="muted">本篇为 PDF，当前请通过“原件对照”查看配图；页内裁图尚未接入。</p>}
    {!isPdf && !document.asset_extraction && editable && <div className="toolbar"><button disabled={busy} onClick={() => void extract()}>{extracting ? '正在提取配图…' : '提取文档配图'}</button>{extracting && <button onClick={() => void window.api.learning.assetsCancel(document.version_id).then(result => { if (!result.ok) onError(result.error) })}>取消配图提取</button>}</div>}
    {document.asset_extraction && <p className="muted">配图已保留 · {new Date(document.asset_extraction.created_at).toLocaleString()} · 图片归属由人工确认</p>}
    {!!document.asset_extraction?.warnings.length && <details><summary>提取提示 · {document.asset_extraction.warnings.length} 项</summary><ul>{document.asset_extraction.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <div className="learning-assets-grid">{document.assets?.map((asset, index) => <figure key={asset.id}><AssetImage asset={asset} /><figcaption>配图 {index + 1} · {learningAssetLocation(asset)}{asset.alt_text && <p>{asset.alt_text}</p>}</figcaption></figure>)}</div>
    {document.asset_extraction && !document.assets?.length && <p>未提取到支持的配图，请查看提示并对照原件。</p>}
  </details>
}
export function LearningEntryFigures({ figures, assets }: { figures: LearningFigure[]; assets: LearningAsset[] }) {
  return <div className="learning-entry-figures">{figures.map(figure => {
    const asset = assets.find(item => item.id === figure.asset_id)
    return <figure key={figure.asset_id}>{asset ? <><AssetImage asset={asset} /><figcaption>{figure.caption || asset.alt_text || '教材配图'}<small>人工配图引用 · {learningAssetLocation(asset)}</small></figcaption></> : <p role="status">配图附件不存在，请对照原件。</p>}</figure>
  })}</div>
}
export function LearningFigureEditor({ document, figures = [], base, busy, onChange }: { document: LearningDocument; figures?: LearningFigure[]; base: { version_id: string; expected_revision_id: string; entry_id: string }; busy: boolean; onChange: (input: LearningChange) => Promise<void> }) {
  const [assetId, setAssetId] = useState(''), [caption, setCaption] = useState('')
  const asset = document.assets?.find(item => item.id === assetId)
  return <section className="learning-figure-editor" aria-label="条目配图"><h4>条目配图</h4>
    {!document.assets?.length ? <p className="muted">先在“文档配图”中提取嵌入图片，再选择本条对应的图片。</p> : <>
      {figures.map((figure, index) => <div className="toolbar" key={figure.asset_id}><span>配图引用 {index + 1} · {figure.caption || '未填写图注'}</span><button disabled={busy} onClick={() => { setAssetId(figure.asset_id); setCaption(figure.caption) }}>编辑配图 {index + 1}</button><button disabled={busy} onClick={() => void onChange({ ...base, action: 'figure-remove', asset_id: figure.asset_id })}>移除配图 {index + 1}</button></div>)}
      <label>选择图片<select aria-label="条目配图选择" disabled={busy} value={assetId} onChange={event => { setAssetId(event.target.value); setCaption(figures.find(figure => figure.asset_id === event.target.value)?.caption ?? '') }}><option value="">请选择配图</option>{document.assets.map((item, index) => <option key={item.id} value={item.id}>配图 {index + 1} · {learningAssetLocation(item)}</option>)}</select></label>
      <label>图注<input aria-label="条目配图图注" maxLength={1000} disabled={busy} value={caption} onChange={event => setCaption(event.target.value)} placeholder="说明此图与本条目的关系" /></label>
      {asset && <div className="learning-figure-preview"><AssetImage key={asset.id} asset={asset} /></div>}
      <button className="primary" disabled={busy || !asset} onClick={() => void onChange({ ...base, action: 'figure', figure: { asset_id: assetId, caption: caption.trim() } })}>保存配图引用</button>
    </>}
  </section>
}
