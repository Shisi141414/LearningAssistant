import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ApiResult, Material, MaterialDetail } from '@shared/types'
import type {
  ExerciseSetPreview,
  ExerciseSetResult
} from '@shared/exercise-set'
import { useAppStore } from '../stores/app'
import { MarkdownSegment } from './MarkdownSegment'
import { MaterialOcrPanel } from './MaterialOcrPanel'
import { OfficeConverterPanel } from './OfficeConverterPanel'

const checked = <T,>(result: ApiResult<T>): T => {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function ExerciseSetImport({
  onImported,
  onClose
}: {
  onImported: () => void
  onClose: () => void
}) {
  const { subjects, currentSubjectId } = useAppStore()
  const [subject, setSubject] = useState(
    currentSubjectId ?? subjects[0]?.id ?? ''
  )
  const [materials, setMaterials] = useState<Material[]>([])
  const [materialId, setMaterialId] = useState(''),
    [versionId, setVersionId] = useState('')
  const [detail, setDetail] = useState<MaterialDetail | null>(null)
  const [preview, setPreview] = useState<ExerciseSetPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false),
    [preparing, setPreparing] = useState(false)
  const [error, setError] = useState(''),
    [result, setResult] = useState<ExerciseSetResult | null>(null)
  const [refresh, setRefresh] = useState(0),
    [offset, setOffset] = useState(0)
  const version = detail?.versions.find(
    (v) => v.id === (versionId || detail.material.current_version_id)
  )
  const activeVersionId = version?.id ?? '',
    activeStatus = version?.status
  const locked = busy || preparing
  useEffect(() => {
    let alive = true
    void window.api.materials.list().then((r) => {
      if (alive) {
        if (r.ok) setMaterials(r.data)
        else setError(r.error)
      }
    })
    return () => {
      alive = false
    }
  }, [refresh])
  useEffect(
    () => () => {
      void window.api.exerciseSets.discard()
    },
    []
  )
  useEffect(() => {
    setDetail(null)
    if (!materialId) return
    let alive = true,
      timer: ReturnType<typeof setTimeout>
    const load = async () => {
      const r = await window.api.materials.get(materialId)
      if (!alive) return
      if (!r.ok) {
        setError(r.error)
        return
      }
      setDetail(r.data)
      // Parsing continues in the existing worker queue; leaving this panel keeps the original.
      timer = setTimeout(() => {
        void load()
      }, 1500)
    }
    void load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [materialId, refresh])
  useEffect(() => {
    setPreview(null)
    setSelected(new Set())
    setOffset(0)
    setResult(null)
    if (!activeVersionId || activeStatus !== 'ready') {
      setPreparing(false)
      return
    }
    let alive = true
    setPreparing(true)
    setError('')
    void window.api.exerciseSets.preview(activeVersionId).then((r) => {
      if (!alive) return
      setPreparing(false)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setPreview(r.data)
      setSelected(
        new Set(
          r.data.candidates.filter((c) => !c.existing_id).map((c) => c.id)
        )
      )
    })
    return () => {
      alive = false
    }
  }, [activeVersionId, activeStatus, refresh])
  const chooseFile = async () => {
    setBusy(true)
    setError('')
    try {
      const material = checked(
        await window.api.materials.import({
          subject_id: subject,
          kind: 'supplement'
        })
      )
      if (material) {
        setVersionId('')
        setMaterialId(material.id)
        setRefresh((value) => value + 1)
      }
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  const convert = async () => {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      const saved = checked(
        await window.api.exerciseSets.import({
          token: preview.token,
          entry_ids: [...selected]
        })
      )
      setResult(saved)
      setSelected(new Set())
      setPreview(null)
      onImported()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="exercise-set-import" aria-label="导入习题集">
      <div className="exercise-import-heading">
        <h2>导入习题集</h2>
        <button
          type="button"
          aria-label="关闭习题集导入"
          title="关闭习题集导入"
          disabled={locked}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="muted">
        保留原文件，自动按题号、思路和解答标记切分。核对后转换为习题库条目；已有答案不会被覆盖。
      </p>
      <div className="exercise-import-controls">
        <label>
          导入到学科
          <select
            aria-label="习题集导入学科"
            value={subject}
            disabled={locked}
            onChange={(e) => setSubject(e.target.value)}
          >
            <option value="">请选择学科</option>
            {subjects.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={locked || !subject}
          onClick={() => void chooseFile()}
        >
          选择习题集文件
        </button>
        <span className="muted">PDF / Word / PPT · 最大 50 MiB</span>
      </div>
      <div className="exercise-import-controls">
        <label>
          或从已有材料选择
          <select
            aria-label="已有习题集材料"
            disabled={locked}
            value={materialId}
            onChange={(e) => {
              setVersionId('')
              setMaterialId(e.target.value)
              setError('')
            }}
          >
            <option value="">选择材料</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} ·{' '}
                {subjects.find((s) => s.id === m.subject_id)?.name ?? '未分科'}
              </option>
            ))}
          </select>
        </label>
        {detail && (
          <label>
            材料版本
            <select
              aria-label="习题集材料版本"
              disabled={locked}
              value={activeVersionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {detail.versions.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.file_name} ·{' '}
                  {v.derivation === 'original' ? '原件' : v.derivation} ·{' '}
                  {new Date(v.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {detail && (
        <p className="muted">
          归属：
          {subjects.find((s) => s.id === detail.material.subject_id)?.name ??
            '未分科'}{' '}
          ·{' '}
          <Link
            to={`/library?material=${detail.material.id}${activeVersionId ? `&version=${activeVersionId}` : ''}`}
          >
            对照原件、修正切分或关联配图
          </Link>
        </p>
      )}
      {version && (activeStatus === 'queued' || activeStatus === 'parsing') && (
        <p role="status">
          正在解析习题集 {version.progress}%… 完成后自动切分。
        </p>
      )}
      {version &&
        (activeStatus === 'failed' || activeStatus === 'cancelled') && (
          <div role="alert">
            <p>{version.error || '解析已取消'}</p>
            <button
              disabled={locked}
              onClick={async () => {
                setBusy(true)
                try {
                  checked(await window.api.materials.retry(version.id))
                  setRefresh((v) => v + 1)
                } catch (e) {
                  setError(message(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              重新解析习题集
            </button>
          </div>
        )}
      {preparing && <p role="status">正在整理来源并切分题目…</p>}
      {error && (
        <p role="alert" className="exercise-import-error">
          {error}
        </p>
      )}
      {version?.status === 'ready' && (
        <button disabled={locked} onClick={() => setRefresh((v) => v + 1)}>
          重新预览切分
        </button>
      )}
      {preview && (
        <>
          <p role="status">
            识别到 {preview.candidates.length} 道题，已选择 {selected.size}{' '}
            道。导入后均为“未完成”，用户答案留空。
          </p>
          <details className="exercise-import-warnings">
            <summary>切分说明与需核对内容</summary>
            <ul>
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
          <div className="toolbar">
            <button
              disabled={locked}
              onClick={() =>
                setSelected(
                  new Set(
                    preview.candidates
                      .filter((c) => !c.existing_id)
                      .map((c) => c.id)
                  )
                )
              }
            >
              选择全部未导入题目
            </button>
            <button disabled={locked} onClick={() => setSelected(new Set())}>
              取消选择
            </button>
            <button
              className="primary"
              disabled={locked || !selected.size}
              onClick={() => void convert()}
            >
              确认转换所选习题（{selected.size}）
            </button>
          </div>
          <div className="exercise-import-candidates">
            {preview.candidates.slice(offset, offset + 25).map((c) => (
              <article key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`导入题目：${c.title}`}
                    disabled={locked || !!c.existing_id}
                    checked={selected.has(c.id)}
                    onChange={(e) =>
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (e.target.checked) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }
                  />
                  <div className="exercise-import-title">
                    <MarkdownSegment text={c.title} plain />
                  </div>
                </label>
                <p className="muted">
                  {c.location}
                  {c.existing_id && (
                    <>
                      {' '}
                      ·{' '}
                      <Link to={`/exercises/${c.existing_id}`}>
                        {c.in_trash
                          ? '已在回收站，可恢复；不会重复添加'
                          : '已导入，不会覆盖'}
                      </Link>
                    </>
                  )}
                </p>
                <details>
                  <summary>查看题面与答案</summary>
                  <h4>题面</h4>
                  <MarkdownSegment text={c.statement} plain />
                  {c.approach && (
                    <>
                      <h4>解题思路</h4>
                      <MarkdownSegment text={c.approach} plain />
                    </>
                  )}
                  {c.answer && (
                    <>
                      <h4>标准答案（来自原文）</h4>
                      <MarkdownSegment text={c.answer} plain />
                    </>
                  )}
                  {!c.answer && (
                    <p className="muted">未发现明确关联的答案，留空待补充。</p>
                  )}
                </details>
              </article>
            ))}
          </div>
          {preview.candidates.length > 25 && (
            <div className="toolbar">
              <button
                disabled={!offset || locked}
                onClick={() => setOffset((v) => v - 25)}
              >
                上一组题目
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 25, preview.candidates.length)}{' '}
                / {preview.candidates.length}
              </span>
              <button
                disabled={offset + 25 >= preview.candidates.length || locked}
                onClick={() => setOffset((v) => v + 25)}
              >
                下一组题目
              </button>
            </div>
          )}
        </>
      )}
      {result && (
        <p role="status" className="exercise-import-result">
          已转换 {result.added} 道，跳过 {result.skipped} 道已有题目
          {result.in_trash ? `（其中 ${result.in_trash} 道在回收站）` : ''}。
          {result.ids[0] && (
            <Link to={`/exercises/${result.ids[0]}`}>查看习题</Link>
          )}
        </p>
      )}
      {version?.format === 'pdf' && (
        <MaterialOcrPanel
          key={version.id}
          version={version}
          onVersion={async (id) => {
            setVersionId(id)
            setRefresh((v) => v + 1)
          }}
        />
      )}
      <OfficeConverterPanel />
    </section>
  )
}
