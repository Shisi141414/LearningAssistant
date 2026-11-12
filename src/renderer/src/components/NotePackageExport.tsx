import { useState } from 'react'
import type { NotePackageExportInput } from '@shared/note-package'

export function NotePackageExport({ source, disabled, onBusy }: { source: NotePackageExportInput; disabled: boolean; onBusy: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const save = async () => {
    setBusy(true); onBusy(true); setMessage('正在保存所选修订…'); setError('')
    try {
      const result = await window.api.notes.packageExport(source)
      if (!result.ok) { setMessage(''); setError(result.error) }
      else if (!result.data) setMessage('已取消保存。')
      else { const data = result.data; setMessage(`已保存 ${data.file_name} · ${data.entries} 个条目、${data.sources} 段来源、${data.annotations} 个标注和 ${data.evidence} 项证据${data.unmatched_annotations || data.unmatched_evidence ? `；其中 ${data.unmatched_annotations} 个标注和 ${data.unmatched_evidence} 项证据与所选来源版本不同，已单独标记` : ''}。`) }
    } catch (reason) { setMessage(''); setError(reason instanceof Error ? reason.message : '笔记导出失败，请重试') }
    finally { setBusy(false); onBusy(false) }
  }
  return <div className="learning-note-package">
    <div className="toolbar"><button disabled={disabled || busy} onClick={() => void save()}>导出笔记文档包</button>{busy && <button onClick={() => void window.api.notes.packageExportCancel(source.note_id).then(result => { if (!result.ok) setError(result.error) })}>取消笔记导出</button>}</div>
    <p className="muted">.ladoc 保存所选修订全部条目、原始口述、整理稿和教材位置；标注及知识证据为本次导出时的记录。包内含原始内容，分享前请核对。可在“笔记”页导入独立副本。</p>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
