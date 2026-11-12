import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { LearningPdfDocument, LearningPdfReport } from '@shared/learning-pdf'
import { learningPdfSourceLabel } from '@shared/learning-pdf'
import { entryText, learningTypes } from '@shared/learning-document'
import { MarkdownSegment } from './components/MarkdownSegment'
import { LearningFormulaContent } from './components/LearningFormulaContent'
import './print.css'

declare global { interface Window { renderLearningPdf: (data: LearningPdfDocument) => Promise<LearningPdfReport> } }
const root = createRoot(document.getElementById('root')!)
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

async function ready(data: LearningPdfDocument): Promise<LearningPdfReport> {
  await document.fonts.ready
  const images = [...document.images]
  await Promise.all(images.map(async image => { await image.decode(); if (!image.naturalWidth) throw new Error('配图未能完整载入，请检查附件后重试') }))
  let scaled = 0
  for (const formula of document.querySelectorAll<HTMLElement>('.katex')) {
    const body = formula.closest<HTMLElement>('.entry-body')!, width = body.clientWidth
    const actual = formula.getBoundingClientRect().width
    if (actual <= width) continue
    const factor = (width - 2) / actual, size = parseFloat(getComputedStyle(formula).fontSize) * factor
    if (size < 10.66) throw new Error(`第 ${body.dataset.ordinal} 条公式过宽，请选择横向纸张或手工分行后导出`)
    formula.style.fontSize = `${size}px`; scaled++
  }
  if ([...document.querySelectorAll<HTMLElement>('.entry-body,.original')].some(body => body.scrollWidth > body.clientWidth + 2)) throw new Error('存在超出纸张的内容，请选择横向纸张或整理长公式后重试')
  return { entry_count: data.state.entries.length, image_count: images.length, scaled_formulas: scaled, empty_sources: data.sources.filter(source => !source.raw_text.trim()).length }
}
function PrintDocument({ data, done, failed }: { data: LearningPdfDocument; done: (report: LearningPdfReport) => void; failed: (reason: unknown) => void }) {
  useEffect(() => { void ready(data).then(done, failed) }, [data, done, failed])
  const sources = new Map(data.sources.map(source => [source.id, source])), byId = new Map(data.state.entries.map(entry => [entry.id, entry]))
  const sections = data.state.entries.filter(entry => entry.type === 'section')
  return <>
    <style>{`@page { size: A4 ${data.landscape ? 'landscape' : 'portrait'}; margin: 17.78mm 19.05mm } body { width: ${data.landscape ? '258.9' : '171.9'}mm; }`}</style>
    <header><h1>{data.title}</h1><p>{data.subject_name || '未分学科'} · {data.source_name}</p><p>修订 {data.revision_number} · 保存于 {date(data.saved_at)} · {data.state.entries.length} 个条目</p></header>
    {sections.length > 0 && <nav aria-label="目录"><h2>目录</h2>{sections.map(entry => <p key={entry.id}><a href={`#entry-${entry.id}`}>{entry.title || '未命名章节'}</a></p>)}</nav>}
    <main>{data.state.entries.map((entry, index) => {
      const relation = data.state.relations.find(item => item.from === entry.id), target = relation && byId.get(relation.to)
      const text = entryText(entry, sources)
      return <article id={`entry-${entry.id}`} className={`entry type-${entry.type}`} key={entry.id}>
        {entry.type === 'section' ? <h2>{entry.title || '未命名章节'}</h2> : <h3><span>{learningTypes[entry.type]}</span> {entry.title || `第 ${index + 1} 条`}{entry.analysis.review_status === 'unreviewed' && <small>（待核对）</small>}</h3>}
        <div className="entry-body" data-ordinal={index + 1}>{entry.formulas?.length ? <LearningFormulaContent text={text} formulas={entry.formulas} subjectId={null} plain /> : <MarkdownSegment text={text} plain />}</div>
        {entry.figures?.map(figure => { const asset = data.assets.find(item => item.id === figure.asset_id)!; return <figure key={asset.id}><img src={`study-material://learning-assets/${asset.id}`} alt={asset.alt_text || figure.caption || '条目配图'} /><figcaption>{figure.caption || asset.alt_text || '条目配图'}</figcaption></figure> })}
        {target && <p className="reference">{relation!.type === 'proves' ? '证明' : '解答'}对象：<a href={`#entry-${target.id}`}>{target.title || learningTypes[target.type]}</a>{relation!.review_status === 'unreviewed' ? '（待核对）' : ''}</p>}
        <p className="reference">来源：{[...new Set(entry.sources.map(ref => ref.source_id))].map((id, i) => <a key={id} href={`#source-${id}`}>{i > 0 ? '；' : ''}{learningPdfSourceLabel(sources.get(id)!)}</a>)}{entry.analysis.method === 'ai' ? ` · AI 整理：${entry.analysis.model}` : entry.analysis.method === 'manual' ? ' · 人工编辑' : ''}</p>
      </article>
    })}</main>
    <section className="sources"><h2>来源与原文对照</h2><p className="reference">本文件保存选中修订的整理内容与来源位置。原件由学习助理另行保管；扫描页尚未识别的文字不会自动补全。</p>
      {data.sources.map(source => { const origin = data.origins[source.id]; return <article id={`source-${source.id}`} key={source.id}>
        <h3>{learningPdfSourceLabel(source)}{source.heading ? ` · ${source.heading}` : ''}</h3>
        <p className="reference">{origin ? `记录于 ${date(origin.recorded_at)} · 段落版本 ${origin.segment_revision} · ${origin.organized_by === 'ai' ? `AI 整理：${origin.model ?? '模型未记录'}` : origin.organized_by === 'user' ? '人工整理' : '初始记录'}` : source.extraction === 'ocr' ? 'OCR 识别来源，需对照原件核对' : '教材来源'}{!source.raw_text.trim() && ' · 本段尚无可用文字'}</p>
        {origin?.material_ref && <p className="reference">教材：{origin.material_ref.material_title} · {learningPdfSourceLabel({ ...source, locator_json: origin.material_ref.locator_json })}</p>}
        {data.include_original_text && <><h4>{origin ? '原始转写' : '来源文字'}</h4><div className="original">{origin ? origin.raw_text || '（原始转写为空）' : source.raw_text || '（来源文字为空）'}</div>{origin && source.raw_text !== origin.raw_text && <><h4>保存的整理稿</h4><div className="original">{source.raw_text || '（整理稿为空）'}</div></>}</>}
      </article> })}
      {!!Object.keys(data.origins).length && <p className="reference">记录时间不代表录音时间轴；教材位置为当时保存的锚点。</p>}
    </section>
  </>
}
window.renderLearningPdf = data => new Promise((resolve, reject) => { document.title = data.title; root.render(<PrintDocument data={data} done={resolve} failed={reject} />) })
