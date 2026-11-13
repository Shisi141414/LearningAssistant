import { TaskSourceLinks } from '../components/TaskResources'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { ProjectDocumentDetail, ProjectDocumentKind } from '@shared/project-documents'
import { projectDocumentKinds } from '@shared/project-documents'
import type { LearningOperation } from '@shared/types'
import { entryText, learningTypes } from '@shared/learning-document'
import { useConceptStore } from '../stores/concepts'
import { MathInput } from '../components/MathInput'
import { LearningFormulaContent } from '../components/LearningFormulaContent'
import { LearningEntryEditor } from '../components/LearningEntryEditor'
import { LearningEntryFigures } from '../components/LearningFigures'
import { LearningPdfExport } from '../components/LearningPdfExport'
import '../components/learning-reader.css'
import './project-documents.css'

export function ProjectDocumentPage() {
  const { projectId = '', documentId = '' } = useParams()
  const [params] = useSearchParams()
  const revisionId = params.get('revision') ?? '', targetEntryId = params.get('entry') ?? ''
  return (
    <DocumentEditor
      key={`${projectId}:${documentId}:${revisionId}:${targetEntryId}`}
      initialRevisionId={revisionId} targetEntryId={targetEntryId}
      projectId={projectId}
      documentId={documentId}
    />
  )
}
function DocumentEditor({ projectId, documentId, initialRevisionId, targetEntryId }: { projectId: string; documentId: string; initialRevisionId: string; targetEntryId: string }) {
  const isNew = documentId === 'new',
    navigate = useNavigate(),
    { items: concepts, load: loadConcepts } = useConceptStore()
  useEffect(() => {
    void loadConcepts()
  }, [loadConcepts])
  const [detail, setDetail] = useState<ProjectDocumentDetail | null>(null),
    [loading, setLoading] = useState(!isNew)
  const [title, setTitle] = useState(''),
    [kind, setKind] = useState<ProjectDocumentKind>('requirements'),
    [body, setBody] = useState(''),
    [conceptIds, setConceptIds] = useState<string[]>([])
  const [editing, setEditing] = useState(isNew),
    [replaceBody, setReplaceBody] = useState(isNew),
    [baseline, setBaseline] = useState(
      JSON.stringify({
        title: '',
        kind: 'requirements',
        body: '',
        conceptIds: [],
        replaceBody: true
      })
    )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [activeEntry, setActiveEntry] = useState(''),
    [offset, setOffset] = useState(0)
  const lock = useRef(false),
    alive = useRef(true)
  const fields = JSON.stringify({ title, kind, body, conceptIds, replaceBody }),
    dirty = editing && fields !== baseline
  const apply = (doc: ProjectDocumentDetail) => {
    setDetail(doc)
    setTitle(doc.snapshot.title)
    setKind(doc.snapshot.kind)
    setBody(doc.snapshot.sources.map((item) => item.raw_text).join('\n'))
    setConceptIds(doc.snapshot.concept_ids)
    setEditing(false)
    setReplaceBody(false)
    setActiveEntry('')
    const index = doc.snapshot.state.entries.findIndex(entry => entry.id === targetEntryId)
    setOffset(index >= 0 ? Math.floor(index / 100) * 100 : 0)
    if (targetEntryId && index < 0) setError('所引修订中没有此条目，请核对引用链接')
    setBaseline(
      JSON.stringify({
        title: doc.snapshot.title,
        kind: doc.snapshot.kind,
        body: doc.snapshot.sources.map((item) => item.raw_text).join('\n'),
        conceptIds: doc.snapshot.concept_ids,
        replaceBody: false
      })
    )
  }
  useEffect(() => {
    alive.current = true
    if (!isNew)
      void window.api.projectDocuments.get({ id: documentId, ...(initialRevisionId ? { revision_id: initialRevisionId } : {}) }).then((result) => {
        if (!alive.current) return
        setLoading(false)
        if (result.ok && result.data.project_id === projectId) apply(result.data)
        else setError(result.ok ? '文档不属于此项目' : result.error)
      })
    return () => {
      alive.current = false
    }
  }, [documentId, projectId, isNew])
  useEffect(() => {
    if (detail && targetEntryId) document.getElementById(`project-document-entry-${targetEntryId}`)?.scrollIntoView({ block: 'center' })
  }, [detail?.revision_id, targetEntryId, offset, loading])
  useEffect(() => {
    if (!dirty) return
    const leave = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
      if (
        link &&
        link.href !== location.href &&
        !window.confirm('文档有未保存的修改，仍要离开吗？')
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    document.addEventListener('click', leave, true)
    window.addEventListener('beforeunload', unload)
    return () => {
      document.removeEventListener('click', leave, true)
      window.removeEventListener('beforeunload', unload)
    }
  }, [dirty])
  const perform = async (
    action: () => Promise<{ ok: true; data: ProjectDocumentDetail } | { ok: false; error: string }>
  ) => {
    if (lock.current || busy) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (!alive.current) return
      if (result.ok) {
        apply(result.data)
        if (isNew) navigate(`/projects/${projectId}/documents/${result.data.id}`, { replace: true })
      } else setError(result.error)
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  const save = () => {
    if (!title.trim() || (replaceBody && !body.trim())) {
      setError('请填写标题和正文')
      return
    }
    if (
      !isNew &&
      replaceBody &&
      !window.confirm(
        '替换正文将重建本版条目，并移除原有公式校正与配图；旧版和导入来源仍保留。继续吗？'
      )
    )
      return
    void perform(() =>
      window.api.projectDocuments.save({
        project_id: projectId,
        ...(!isNew ? { id: documentId, expected_revision_id: detail!.head_revision_id } : {}),
        title,
        kind,
        concept_ids: conceptIds,
        ...(replaceBody ? { body } : {})
      })
    )
  }
  if (loading)
    return (
      <div className="page" role="status">
        正在读取项目文档…
      </div>
    )
  if (!isNew && !detail)
    return (
      <div className="page">
        <Link to={`/projects/${projectId}`}>返回项目</Link>
        <p role="alert">{error}</p>
      </div>
    )
  const historical = !!detail && detail.revision_id !== detail.head_revision_id,
    deleted = detail?.deleted_at !== null && !!detail,
    snapshot = detail?.snapshot
  const action = { id: documentId, expected_revision_id: detail?.head_revision_id ?? '' }
  const sources = new Map(snapshot?.sources.map((item) => [item.id, item]) ?? [])
  const operate = (entry_id: string, operation: LearningOperation) => {
    if (operation.action === 'figure' || operation.action === 'figure-remove')
      return Promise.resolve()
    return perform(() => window.api.projectDocuments.change({ ...action, entry_id, ...operation }))
  }
  return (
    <div className="page project-document-page">
      <Link to={`/projects/${projectId}`}>返回项目</Link>
      <h1>{isNew ? '新建项目文档' : snapshot?.title}</h1>
      <p className="muted">{projectDocumentKinds[kind]} · 保存修订，保留要求与计划的演变。</p>
      {error && (
        <p role="alert" className="material-error">
          {error}
        </p>
      )}
      {deleted && <p role="status">文档在回收站，正文与历史仍保留。</p>}
      {historical && <p role="status">正在查看历史修订，只读。恢复会新增版本并保留当前内容。</p>}
      <div className="toolbar project-document-actions">
        {!isNew && (
          <button
            disabled={busy}
            onClick={() => {
              if (
                dirty &&
                !window.confirm('读取最新修订会放弃草稿，请先复制需要保留的内容。继续吗？')
              )
                return
              void perform(() => window.api.projectDocuments.get({ id: documentId }))
            }}
          >
            读取最新修订
          </button>
        )}
        {editing ? (
          <>
            <button className="primary" disabled={busy} onClick={save}>
              保存文档
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (dirty && !window.confirm('放弃未保存的修改？')) return
                if (detail) apply(detail)
                else navigate(`/projects/${projectId}`)
              }}
            >
              取消编辑
            </button>
          </>
        ) : (
          <>
            <button
              disabled={busy || historical || deleted}
              onClick={() => {
                setEditing(true)
                setBaseline(fields)
              }}
            >
              编辑文档
            </button>
            {historical && (
              <button
                disabled={busy || deleted}
                onClick={() => {
                  if (window.confirm('将所选历史修订恢复为新版本？当前版本仍可查看。'))
                    void perform(() =>
                      window.api.projectDocuments.revisionRestore({
                        ...action,
                        revision_id: detail!.revision_id
                      })
                    )
                }}
              >
                恢复此修订
              </button>
            )}
            <button
              disabled={busy || historical}
              onClick={() => {
                if (!deleted && !window.confirm('将文档移入回收站？历史和原件会保留。')) return
                void perform(() =>
                  deleted
                    ? window.api.projectDocuments.restore(action)
                    : window.api.projectDocuments.trash(action)
                )
              }}
            >
              {deleted ? '恢复文档' : '删除文档'}
            </button>
          </>
        )}
      </div>
      {detail && (
        <label className="project-document-history">
          修订
          <select
            aria-label="项目文档修订"
            value={detail.revision_id}
            disabled={busy || editing}
            onChange={(e) =>
              void perform(() =>
                window.api.projectDocuments.get({ id: documentId, revision_id: e.target.value })
              )
            }
          >
            {detail.history.map((item, index) => (
              <option key={item.id} value={item.id}>
                第 {detail.history.length - index} 版 ·{' '}
                {new Date(item.created_at).toLocaleString('zh-CN')}
                {item.id === detail.head_revision_id ? ' · 当前' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {editing ? (
        <fieldset disabled={busy} className="project-document-editor">
          <label>
            标题
            <input
              aria-label="项目文档标题"
              maxLength={500}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            用途
            <select
              aria-label="项目文档用途"
              value={kind}
              onChange={(e) => setKind(e.target.value as ProjectDocumentKind)}
            >
              {Object.entries(projectDocumentKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div>
            <label>
              关联知识
              <select
                aria-label="项目文档关联知识"
                value=""
                onChange={(e) => {
                  if (
                    e.target.value &&
                    !conceptIds.includes(e.target.value) &&
                    conceptIds.length < 32
                  )
                    setConceptIds((ids) => [...ids, e.target.value])
                }}
              >
                <option value="">选择知识点（最多32项）</option>
                {concepts
                  .filter((item) => !conceptIds.includes(item.id))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="toolbar">
              {conceptIds.map((id) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => setConceptIds((ids) => ids.filter((item) => item !== id))}
                >
                  {concepts.find((item) => item.id === id)?.name ?? '已不可用知识'} ×
                </button>
              ))}
            </div>
          </div>
          {!isNew && (
            <label>
              <input
                type="checkbox"
                checked={replaceBody}
                onChange={(e) => setReplaceBody(e.target.checked)}
              />
              替换整篇正文（重建本版结构，旧版保留）
            </label>
          )}
          {replaceBody ? (
            <div>
              <p className="muted">正文保存为内部条目；保存后可拆分、分类、编排章节并校正公式。</p>
              <MathInput value={body} label="项目文档正文" minHeight={220} onChange={setBody} />
              {body.length > 200_000 && <p role="alert">正文超过20万字符，请拆分后保存。</p>}
            </div>
          ) : (
            <p className="muted">只修改标题、用途和知识关联，正文、配图及条目结构保持原样。</p>
          )}
        </fieldset>
      ) : (
        snapshot && (
          <>
            <div className="toolbar project-document-concepts">
              关联知识：
              {snapshot.concept_ids.length ? (
                snapshot.concept_ids.map((id) => (
                  <Link key={id} to={`/knowledge?concept=${encodeURIComponent(id)}`}>
                    {concepts.find((item) => item.id === id)?.name ?? '知识点已不可用'}
                  </Link>
                ))
              ) : (
                <span className="muted">尚未关联</span>
              )}
            </div>
            {snapshot.origin && (
              <p className="project-document-origin">
                导入来源：{snapshot.origin.title} ·{' '}
                <Link
                  to={`/library?${new URLSearchParams({ material: snapshot.origin.material_id, version: snapshot.origin.version_id, revision: snapshot.origin.revision_id })}`}
                >
                  查看导入时的材料修订
                </Link>
              </p>
            )}
            <div className="project-document-paper">
              {snapshot.state.entries.slice(offset, offset + 100).map((entry, index) => (
                <article id={`project-document-entry-${entry.id}`} key={entry.id} className={`learning-entry learning-${entry.type}${entry.id === targetEntryId ? ' evidence-target' : ''}`}>
                  <div className="learning-entry-header">
                    <span>{learningTypes[entry.type]}</span>
                    <strong>{entry.title}</strong>
                    {!historical && !deleted && (
                      <button
                        disabled={busy}
                        onClick={() => setActiveEntry(activeEntry === entry.id ? '' : entry.id)}
                      >
                        {activeEntry === entry.id ? '收起整理' : '整理条目'}
                      </button>
                    )}
                  </div>
                  <div className="learning-entry-text">
                    <LearningFormulaContent
                      text={entryText(entry, sources)}
                      formulas={entry.formulas ?? []}
                      subjectId={null}
                    />
                  </div>
                  {!!entry.figures?.length && (
                    <LearningEntryFigures figures={entry.figures} assets={snapshot.assets} />
                  )}
                  {activeEntry === entry.id && (
                    <LearningEntryEditor
                      key={`${detail!.revision_id}:${entry.id}`}
                      entry={entry}
                      text={entryText(entry, sources)}
                      state={snapshot.state}
                      first={offset + index === 0}
                      busy={busy}
                      onOperation={(op) => operate(entry.id, op)}
                    />
                  )}
                  <TaskSourceLinks key={`task-source:${detail!.revision_id}:${entry.id}`} source={{ kind: 'project_document', document_id: documentId, revision_id: detail!.revision_id, entry_id: entry.id }} disabled={busy || !!activeEntry} />
                </article>
              ))}
            </div>
            {snapshot.state.entries.length > 100 && (
              <div className="toolbar">
                <button
                  disabled={busy || !offset}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  上一组条目
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 100, snapshot.state.entries.length)} /{' '}
                  {snapshot.state.entries.length}
                </span>
                <button
                  disabled={busy || offset + 100 >= snapshot.state.entries.length}
                  onClick={() => setOffset(offset + 100)}
                >
                  下一组条目
                </button>
              </div>
            )}
            <LearningPdfExport
              key={detail!.revision_id}
              source={{
                kind: 'project_document',
                document_id: documentId,
                revision_id: detail!.revision_id
              }}
              disabled={busy}
              onBusy={setBusy}
            />
          </>
        )
      )}
    </div>
  )
}
