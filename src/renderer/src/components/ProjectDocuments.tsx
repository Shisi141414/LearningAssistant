import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Material } from '@shared/types'
import type { ProjectDocumentKind, ProjectDocumentSummary } from '@shared/project-documents'
import { projectDocumentKinds } from '@shared/project-documents'
import '../pages/project-documents.css'

export function ProjectDocuments({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<ProjectDocumentSummary[]>([]),
    [trash, setTrash] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('')
  const [materials, setMaterials] = useState<Material[]>([]),
    [materialId, setMaterialId] = useState('')
  const [kind, setKind] = useState<ProjectDocumentKind>('requirements'),
    [importOpen, setImportOpen] = useState(false)
  useEffect(() => {
    let alive = true
    void window.api.projectDocuments.list({ project_id: projectId, trash }).then((result) => {
      if (!alive) return
      if (result.ok) setItems(result.data)
      else setError(result.error)
    })
    return () => {
      alive = false
    }
  }, [projectId, trash])
  useEffect(() => {
    if (!importOpen) return
    let alive = true
    void window.api.materials.list().then((result) => {
      if (!alive) return
      if (result.ok) setMaterials(result.data.filter((item) => !item.archived))
      else setError(result.error)
    })
    return () => {
      alive = false
    }
  }, [importOpen])
  const transfer = async () => {
    const material = materials.find((item) => item.id === materialId)
    if (!material?.current_version_id || busy) return
    setBusy(true)
    setError('')
    try {
      const source = await window.api.learning.get({ version_id: material.current_version_id })
      if (!source.ok) {
        setError(source.error)
        return
      }
      if (!source.data) {
        setError('请先到材料库打开此材料的学习文档，完成来源整理后再导入项目。')
        return
      }
      const result = await window.api.projectDocuments.import({
        project_id: projectId,
        material_id: material.id,
        version_id: material.current_version_id,
        revision_id: source.data.revision_id,
        kind
      })
      if (result.ok) navigate(`/projects/${projectId}/documents/${result.data.id}`)
      else setError(result.error)
    } finally {
      setBusy(false)
    }
  }
  const shown = items.filter((item) =>
    item.title.toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <section className="project-documents" aria-label="项目要求计划与文档">
      <h2>要求、计划与文档</h2>
      <p className="muted">每次保存保留一个版本；归档项目后仍可查阅。</p>
      <div className="toolbar">
        <Link className="project-document-create" to={`/projects/${projectId}/documents/new`}>
          新建项目文档
        </Link>
        <button onClick={() => setImportOpen((value) => !value)}>从材料库导入</button>
        <label>
          <input
            type="checkbox"
            checked={trash}
            onChange={(event) => setTrash(event.target.checked)}
          />
          文档回收站
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {importOpen && (
        <div className="project-document-import">
          <p>
            先在材料库导入 Word、PDF 或
            PPT，并打开学习文档。这里复制所选材料的当前修订，后续修改互不覆盖，原件保留在材料库。
          </p>
          <div className="toolbar">
            <select
              aria-label="导入项目的材料"
              value={materialId}
              disabled={busy}
              onChange={(e) => setMaterialId(e.target.value)}
            >
              <option value="">选择已有材料</option>
              {materials.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            <select
              aria-label="导入项目文档用途"
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as ProjectDocumentKind)}
            >
              {Object.entries(projectDocumentKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <button disabled={busy || !materialId} onClick={() => void transfer()}>
              {busy ? '正在导入…' : '导入所选修订'}
            </button>
            <Link to="/library">前往材料库</Link>
          </div>
        </div>
      )}
      <input
        aria-label="查找项目文档"
        placeholder="按文档标题查找"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="project-document-list">
        {shown.map((item) => (
          <Link key={item.id} to={`/projects/${projectId}/documents/${item.id}`}>
            <span>{projectDocumentKinds[item.kind]}</span>
            <strong>{item.title}</strong>
            <small>{new Date(item.updated_at).toLocaleString('zh-CN')}</small>
          </Link>
        ))}
      </div>
      {!shown.length && (
        <p className="muted">
          {trash ? '没有匹配的已删除文档。' : '尚无匹配的文档。可新建要求、计划书或从材料库导入。'}
        </p>
      )}
    </section>
  )
}
