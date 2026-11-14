import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MemoAutoSettings, MemoAutoState } from '@shared/memos'
import type { ModelInfo, Provider } from '@shared/types'
import { useAppStore } from '../stores/app'

const labels = {
  pending: '等待补处理',
  running: '正在识别',
  review: '需要确认',
  routed: '已自动归档',
  cancelled: '已停止'
}
export function MemoAutomation({
  models,
  providers,
  disabled,
  onDirty,
  onChanged
}: {
  models: ModelInfo[]
  providers: Provider[]
  disabled: boolean
  onDirty: (v: boolean) => void
  onChanged: () => void
}) {
  const { subjects, showToast } = useAppStore()
  const [state, setState] = useState<MemoAutoState | null>(null),
    [draft, setDraft] = useState<MemoAutoSettings | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const dirty =
    !!draft &&
    !!state &&
    JSON.stringify(draft) !== JSON.stringify(state.settings)
  const changed = useRef(onChanged),
    stamp = useRef('')
  changed.current = onChanged
  useEffect(() => {
    onDirty(dirty)
    return () => onDirty(false)
  }, [dirty, onDirty])
  useEffect(() => {
    let alive = true
    const poll = async () => {
      const r = await window.api.memos.autoState()
      if (!alive) return
      if (r.ok) {
        setState(r.data)
        setDraft((d) => d ?? r.data.settings)
        const next = JSON.stringify(r.data.jobs)
        if (stamp.current && stamp.current !== next) changed.current()
        stamp.current = next
      } else setError(r.error)
    }
    void poll()
    const timer = setInterval(() => void poll(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      changed.current()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!draft || !state) return null
  const patch = (p: Partial<MemoAutoSettings>) => setDraft({ ...draft, ...p })
  return (
    <details className="memo-automation">
      <summary>
        自动整理 · {state.settings.enabled ? '已启用' : '未启用'}
      </summary>
      <p className="muted">
        启用后，所选范围内的新备忘原文会发送给所选模型。清楚的知识和待办自动归档；时间含糊、冲突或疑似重复的条目留待确认。原文始终保留。
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy || disabled}>
        <label className="memo-check">
          <input
            type="checkbox"
            aria-label="启用备忘自动整理"
            checked={draft.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          启用自动整理
        </label>
        <label>
          使用模型
          <select
            aria-label="自动整理模型"
            value={draft.model_db_id ?? ''}
            onChange={(e) => patch({ model_db_id: e.target.value || null })}
          >
            <option value="">请选择模型</option>
            {models
              .filter((m) =>
                providers.some((p) => p.id === m.provider_id && p.enabled)
              )
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {providers.find((p) => p.id === m.provider_id)?.name} ·{' '}
                  {m.display_name || m.model_id}
                </option>
              ))}
          </select>
        </label>
        <p>允许处理的学科</p>
        <div className="memo-auto-options">
          {subjects.map((s) => (
            <label className="memo-check" key={s.id}>
              <input
                type="checkbox"
                aria-label={'自动整理学科 ' + s.name}
                checked={draft.subject_ids.includes(s.id)}
                onChange={(e) =>
                  patch({
                    subject_ids: e.target.checked
                      ? [...draft.subject_ids, s.id]
                      : draft.subject_ids.filter((id) => id !== s.id)
                  })
                }
              />
              {s.name}
            </label>
          ))}
        </div>
        <label className="memo-check">
          <input
            type="checkbox"
            aria-label="自动整理未分类备忘"
            checked={draft.include_unassigned}
            onChange={(e) => patch({ include_unassigned: e.target.checked })}
          />
          也处理未分类备忘（知识需先选学科）
        </label>
        <div className="memo-auto-options">
          <label className="memo-check">
            <input
              type="checkbox"
              aria-label="允许自动归档知识"
              checked={draft.knowledge}
              onChange={(e) => patch({ knowledge: e.target.checked })}
            />
            知识库
          </label>
          <label className="memo-check">
            <input
              type="checkbox"
              aria-label="允许自动归档待办"
              checked={draft.tasks}
              onChange={(e) => patch({ tasks: e.target.checked })}
            />
            待办与日程
          </label>
        </div>
        <div className="memo-actions">
          <button
            className="primary"
            disabled={!dirty}
            onClick={() =>
              void run(async () => {
                const { since: _, ...input } = draft
                const r = await window.api.memos.autoSave(input)
                if (!r.ok) throw new Error(r.error)
                setState(r.data)
                setDraft(r.data.settings)
                showToast('自动整理规则已保存')
              })
            }
          >
            保存自动整理规则
          </button>
          <button disabled={!dirty} onClick={() => setDraft(state.settings)}>
            重新载入规则
          </button>
          <button
            disabled={!state.settings.enabled || dirty}
            onClick={() =>
              void run(async () => {
                if (
                  !window.confirm(
                    '将当前规则范围内已有的待整理备忘加入自动处理？每次最多 100 条。'
                  )
                )
                  return
                const r = await window.api.memos.autoBacklog()
                if (!r.ok) throw new Error(r.error)
                showToast(`已加入 ${r.data} 条备忘`)
              })
            }
          >
            处理已有待整理
          </button>
        </div>
        {dirty && (
          <p className="muted">
            规则尚未保存。修改并保存规则会停止旧规则正在处理的条目；需要时可按新规则重试。
          </p>
        )}
      </fieldset>
      <p className="muted">
        断网或请求失败最多自动尝试 3
        次，之后留待确认。彻底退出时停止处理，下次打开按已保存规则恢复。
      </p>
      {!!state.jobs.length && (
        <details>
          <summary>最近处理记录（最多 50 条）</summary>
          <ul className="memo-auto-jobs">
            {state.jobs.map((j) => (
              <li key={j.id}>
                <Link
                  to={
                    '/memos?memo=' +
                    encodeURIComponent(j.memo_id) +
                    '&revision=' +
                    encodeURIComponent(j.revision)
                  }
                >
                  {j.excerpt || '查看备忘'}
                </Link>
                <span>
                  {labels[j.status]} · {j.attempts}/3
                </span>
                <p>{j.reason || '等待处理'}</p>
                {j.status === 'pending' && (
                  <small>
                    下次检查：{new Date(j.next_at).toLocaleString()}
                  </small>
                )}
                {j.status !== 'routed' && (
                  <button
                    disabled={
                      busy ||
                      disabled ||
                      (!state.settings.enabled &&
                        !['pending', 'running'].includes(j.status))
                    }
                    onClick={() =>
                      void run(async () => {
                        const r = await window.api.memos.autoAction({
                          id: j.id,
                          action: ['pending', 'running'].includes(j.status)
                            ? 'cancel'
                            : 'retry'
                        })
                        if (!r.ok) throw new Error(r.error)
                        setState(r.data)
                      })
                    }
                  >
                    {['pending', 'running'].includes(j.status)
                      ? '停止此条'
                      : '按当前规则重试'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  )
}
