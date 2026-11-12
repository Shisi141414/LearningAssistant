import { useEffect, useRef, useState } from 'react'
import type { NotePackagePreview, NotePackageImportResult } from '@shared/note-package'
import { useAppStore } from '../stores/app'
import { useConceptStore } from '../stores/concepts'

export function NotePackageImport({ subjectId, onImported }: { subjectId: string; onImported: (result: NotePackageImportResult) => Promise<void> }) {
  const subjects = useAppStore(state => state.subjects)
  const [preview, setPreview] = useState<NotePackagePreview | null>(null), [subject, setSubject] = useState(subjectId)
  const [includeConcepts, setIncludeConcepts] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const mounted = useRef(true), owned = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (owned.current) void window.api.notes.packageImportCancel() } }, [])
  const choose = async (): Promise<void> => {
    setBusy(true); setMessage('正在检查笔记文档包…'); setError(''); owned.current = true
    try {
      const result = await window.api.notes.packagePreview()
      if (!mounted.current) { if (result.ok && result.data) await window.api.notes.packageImportCancel(); return }
      if (!result.ok) { setError(result.error); owned.current = false }
      else if (result.data) {
        setPreview(result.data); setIncludeConcepts(true)
        setSubject(subjectId || subjects.find(item => item.name === result.data!.subject_name)?.id || '')
        setMessage('检查完成。确认前不会创建笔记或修改知识库。')
      } else { setMessage('已取消选择。'); owned.current = false }
    } finally { if (mounted.current) setBusy(false) }
  }
  const cancel = async (): Promise<void> => {
    const result = await window.api.notes.packageImportCancel()
    if (!mounted.current) return
    if (!result.ok) setError(result.error)
    else if (result.data) { setPreview(null); setMessage('已取消导入。'); owned.current = false }
  }
  const confirm = async (): Promise<void> => {
    if (!preview || !subject) return
    setBusy(true); setError(''); setMessage('正在保存原始口述、整理稿与学习条目…')
    try {
      const result = await window.api.notes.packageImport({ ticket: preview.ticket, subject_id: subject, include_concepts: includeConcepts })
      owned.current = false
      if (!mounted.current) return
      setPreview(null)
      if (!result.ok) { setError(result.error); setMessage('导入未完成，请重新选择文档包。') }
      else {
        const data = result.data
        const message = data.created ? `已导入独立副本。新建 ${data.concepts_created} 个概念，复用 ${data.concepts_reused} 个概念，${data.concept_conflicts} 个同名条目保留为独立概念。` : `已打开此学科中先前导入的副本${data.include_concepts ? '（当时已携带概念）' : '（当时未携带概念）'}，未重复创建或覆盖内容。`
        setMessage(message); useAppStore.getState().showToast(message)
        await useConceptStore.getState().load(); await onImported(data)
      }
    } finally { if (mounted.current) setBusy(false) }
  }
  return <section className="learning-package-import" aria-label="笔记文档包导入">
    <div className="toolbar"><button disabled={busy || !!preview} onClick={() => void choose()}>导入笔记文档包</button><span className="muted">.ladoc · 保留原始口述、结构与出处</span>{busy && !preview && <button onClick={() => void cancel()}>取消检查</button>}</div>
    {message && <p role="status">{message}</p>}{error && <p className="material-error" role="alert">{error}</p>}
    {preview && <div className="learning-package-preview">
      <h3>{preview.title}</h3><p>原学科：{preview.subject_name || '未指定'}</p>
      <p>{preview.sources} 个来源 · {preview.entries} 个条目 · {preview.annotations} 个标注 · {preview.concepts} 个相关概念 · {preview.evidence} 条知识证据</p>
      <p className="muted">保存包中的固定修订。再次导入同一包到同一学科会打开已有副本，保留后续人工修改。</p>
      <p className="muted">{preview.external_materials} 处教材位置作为未关联的外部出处保留；{preview.unmatched_annotations} 个标注和 {preview.unmatched_evidence} 项证据与修订不匹配，只存历史记录，不标到当前正文。</p>
      <div className="toolbar"><label>目标学科 <select aria-label="笔记包目标学科" disabled={busy} value={subject} onChange={event => setSubject(event.target.value)}><option value="">选择目标学科</option>{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><input type="checkbox" disabled={busy} checked={includeConcepts} onChange={event => setIncludeConcepts(event.target.checked)} /> 携带相关概念与知识证据</label></div>
      <p className="muted">内容与别名一致的同学科或通用概念可复用；同名但内容不同会另建条目并保留歧义，不覆盖已有知识。不携带概念时也不导入其证据。预览有效期 10 分钟。</p>
      <div className="toolbar"><button className="primary" disabled={busy || !subject} onClick={() => void confirm()}>确认导入</button><button disabled={busy} onClick={() => void cancel()}>取消预览</button></div>
    </div>}
  </section>
}
