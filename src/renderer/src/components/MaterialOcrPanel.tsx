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
  const [ppocr, setPpocr] = useState<{ presets: Array<{ key: string; label: string; ready: boolean }> } | null>(null)
  const [p2t, setP2t] = useState<{ python: boolean; pythonDetail: string; pix2text: boolean; pix2textVersion: string | null; sidecarRunning: boolean } | null>(null)
  const [engine, setEngine] = useState<'ppocr' | 'pix2text' | 'tesseract'>('ppocr')
  const [language, setLanguage] = useState('zh-en')
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
    void window.api.materials.ppocrStatus().then(result => { if (!alive) return; if (result.ok) setPpocr(result.data) })
    void window.api.materials.pix2textStatus().then(result => { if (!alive) return; if (result.ok) setP2t(result.data) })
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
  const ppocrPreset = language === 'ja' ? 'v5-ja' : language === 'ko' ? 'v5-ko' : language === 'latin' ? 'v5-latin' : 'v6-tiny'
  const ppocrReady = ppocr?.presets.find(p => p.key === ppocrPreset)?.ready ?? false
  const p2tReady = !!p2t?.python && !!p2t?.pix2text
  const engineReady = engine === 'ppocr' ? ppocrReady : engine === 'pix2text' ? p2tReady : !!models?.ready
  const prepare = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      if (engine === 'ppocr') {
        const result = await window.api.materials.ppocrPrepare(ppocrPreset)
        if (!mounted.current) return
        if (result.ok) setPpocr(result.data); else setError(result.error)
      } else if (engine === 'pix2text') {
        // Python 与 pip 包无法由应用代装：只做重新检测
        const result = await window.api.materials.pix2textStatus()
        if (!mounted.current) return
        if (result.ok) setP2t(result.data); else setError(result.error)
      } else {
        const result = await window.api.materials.ocrPrepare()
        if (!mounted.current) return
        if (result.ok) setModels(result.data); else setError(result.error)
      }
    } finally { setBusy(false) }
  }
  const run = async (): Promise<void> => {
    setBusy(true); setError('')
    try { const result = await window.api.materials.ocrStart({ version_id: version.id, from_page: from, to_page: to, engine, language: engine === 'ppocr' ? language : undefined }); if (!mounted.current) return; if (result.ok) await onVersion(result.data); else setError(result.error) }
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
      <label>引擎
        <select value={engine} onChange={e => setEngine(e.target.value as 'ppocr' | 'pix2text' | 'tesseract')} aria-label="OCR 引擎">
          <option value="ppocr">PP-OCR（推荐，中文准确率显著更高）</option>
          <option value="pix2text">文字+公式（Pix2Text，公式转 LaTeX）</option>
          <option value="tesseract">Tesseract（备选）</option>
        </select>
      </label>
      {engine === 'ppocr' && (
        <label>语言
          <select value={language} onChange={e => setLanguage(e.target.value)} aria-label="OCR 语言">
            <option value="zh-en">中文/中英混排（v6 统一模型）</option>
            <option value="ja">日文</option>
            <option value="ko">韩文</option>
            <option value="latin">拉丁语系（法德西俄等）</option>
          </select>
        </label>
      )}
      <span role="status">{engineReady ? (engine === 'ppocr' ? '模型已就绪' : engine === 'pix2text' ? `Pix2Text 已就绪（${p2t?.pythonDetail ?? ''}${p2t?.pix2textVersion ? ' · pix2text ' + p2t.pix2textVersion : ''}）` : '中英文语言包已就绪') : busy ? '正在检测/准备…' : engine === 'pix2text' ? 'Pix2Text 环境未就绪' : '模型未就绪'}</span>
      {!engineReady && !busy && <button disabled={busy} onClick={() => void prepare()}>{engine === 'ppocr' ? '下载 PP-OCR 模型（首次约 30–60 MiB）' : engine === 'pix2text' ? '重新检测' : '下载中英文语言包（约 6 MiB）'}</button>}
    </div>
    {engine === 'pix2text' && !p2tReady && (
      <div className="ocr-p2t-guide">
        {p2t && !p2t.python
          ? <p>未检测到可用的 Python。请安装 Python 3.8+（安装时勾选 Add python.exe to PATH），完成后点「重新检测」。</p>
          : <p>本机 Python 已就绪（{p2t?.pythonDetail}），但缺少 pix2text 包。请在终端执行：</p>}
        {p2t?.python && <p><code>pip install pix2text -i https://pypi.tuna.tsinghua.edu.cn/simple</code></p>}
        <p className="muted">装完后点「重新检测」。首次识别会自动下载公式识别模型（约 200 MiB，缓存到用户目录），首次请求可能需要几分钟；识别结果中公式为 LaTeX，可在笔记中用 $..$ / $$..$$ 渲染。</p>
      </div>
    )}
    <div className="toolbar ocr-range">
      <label>从第 <input aria-label="OCR 起始页" type="number" min={1} max={3000} value={from} onChange={e => setFrom(Number(e.target.value))} /> 页</label>
      <label>至第 <input aria-label="OCR 结束页" type="number" min={from} max={Math.min(3000, from + 19)} value={to} onChange={e => setTo(Number(e.target.value))} /> 页</label>
      <button className="primary" disabled={busy || dirty || !engineReady || !validRange} onClick={() => void run()}>识别为新版本</button>
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
