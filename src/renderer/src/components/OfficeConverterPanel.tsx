import { useState } from 'react'
import type { OfficeConverterStatus } from '@shared/types'

export function OfficeConverterPanel() {
  const [status, setStatus] = useState<OfficeConverterStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const load = async (method: 'converterStatus' | 'converterPick' | 'converterAuto'): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.api.materials[method]()
      if (result.ok) setStatus(result.data); else setError(result.error)
    } finally { setBusy(false) }
  }
  return <details className="material-warnings office-converter" onToggle={event => { if (event.currentTarget.open && !status && !busy) void load('converterStatus') }}>
    <summary>旧版 Office 转换（DOC / PPT）</summary>
    <p className="muted">旧版文件通过本机 LibreOffice 转成 DOCX / PPTX 后整理；原件和转换结果都会保留。扫描图片仍需要 OCR。</p>
    {status && <p role="status">{status.ready ? `已就绪 · ${status.version}` : status.error}</p>}
    {status?.path && <p className="muted" style={{ overflowWrap: 'anywhere' }}>{status.path}</p>}
    {error && <p className="material-error" role="alert">{error}</p>}
    <div className="toolbar"><button disabled={busy} onClick={() => void load('converterPick')}>选择 LibreOffice 程序</button><button disabled={busy} onClick={() => void load('converterAuto')}>自动查找</button>{busy && <span role="status">正在检查转换工具…</span>}</div>
    <p className="muted">未安装时可从 libreoffice.org 获取，安装后选择 program 目录中的 soffice 程序；再对失败的材料点击“重新解析”。转换可能改变公式、字体和版式，请对照原件。</p>
  </details>
}
