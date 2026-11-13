import { useEffect, useRef, useState } from 'react'
import type { PlanningState, ScheduleBlock } from '@shared/auto-schedule'
import type { BlockMoveReport } from '@shared/schedule-block-move'

const inputTime = (at: number): string => {
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
const when = (at: number): string =>
  new Date(at).toLocaleString('zh-CN', { hour12: false })
export function ScheduleBlockEditor({
  block,
  title,
  proposed,
  onClose,
  onSaved
}: {
  block: ScheduleBlock
  title: string
  proposed?: { start_at: number; end_at: number }
  onClose: () => void
  onSaved: (state: PlanningState) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [start, setStart] = useState(
      inputTime(proposed?.start_at ?? block.start_at)
    ),
    [end, setEnd] = useState(inputTime(proposed?.end_at ?? block.end_at)),
    [report, setReport] = useState<BlockMoveReport | null>(null),
    [ignore, setIgnore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const close = (): void => {
    if (
      !busy &&
      ((start === inputTime(block.start_at) &&
        end === inputTime(block.end_at)) ||
        window.confirm('放弃未保存的时间块调整？'))
    )
      onClose()
  }
  const change = (field: 'start' | 'end', value: string): void => {
    if (field === 'start') setStart(value)
    else setEnd(value)
    setReport(null)
    setIgnore(false)
    setError('')
  }
  const submit = async (confirm: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const start_at = new Date(start).getTime(),
        end_at = new Date(end).getTime()
      if (
        !start ||
        !end ||
        !Number.isFinite(start_at) ||
        !Number.isFinite(end_at)
      )
        throw Error('请输入正确的起止时间')
      const result = await window.api.calendar.moveBlock({
        id: block.id,
        expected_revision: block.revision,
        start_at,
        end_at,
        ...(confirm && report
          ? {
              confirmation: {
                ignore_conflicts: ignore,
                conflict_fingerprint: report.conflicts.fingerprint
              }
            }
          : {})
      })
      if (!result.ok) throw Error(result.error)
      if (result.data.state) {
        onSaved(result.data.state)
        return
      }
      setReport(result.data.report)
    } catch (e) {
      setReport(null)
      setIgnore(false)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="schedule-block-dialog"
      aria-labelledby="block-editor-title"
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
    >
      <div className="schedule-editor-heading">
        <h2 id="block-editor-title">调整学习时间块</h2>
        <button
          type="button"
          aria-label="关闭时间块调整"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </div>
      <p>
        <strong>{title}</strong>
      </p>
      <p className="muted">
        原安排：{when(block.start_at)} — {when(block.end_at)}
      </p>
      <p className="muted">
        时间按本机时区填写。确认后锁定本块，持续排程保留此位置；任务截止时间和剩余用时不变。可从学习安排中解锁，或从排程记录撤销最近一次调整。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(false)
        }}
      >
        <fieldset disabled={busy}>
          <div className="auto-settings-row">
            <label>
              开始
              <input
                aria-label="时间块开始"
                type="datetime-local"
                required
                value={start}
                onChange={(e) => change('start', e.target.value)}
              />
            </label>
            <label>
              结束
              <input
                aria-label="时间块结束"
                type="datetime-local"
                required
                value={end}
                onChange={(e) => change('end', e.target.value)}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={
              start === inputTime(block.start_at) &&
              end === inputTime(block.end_at)
            }
          >
            检查时间调整
          </button>
          {report && (
            <section
              className="block-move-report"
              aria-label="时间调整检查结果"
            >
              <p>
                待保存：{when(new Date(start).getTime())} —{' '}
                {when(new Date(end).getTime())}
              </p>
              {report.conflicts.items.length ? (
                <>
                  <h3>时间冲突</h3>
                  {report.conflicts.items.map((c, i) => (
                    <p key={i}>
                      {c.other.title} · {when(c.other.start)} —{' '}
                      {when(c.other.end)}
                    </p>
                  ))}
                  {report.conflicts.truncated && <p>仅显示前 200 处冲突。</p>}
                  <label className="block-move-ignore">
                    <input
                      aria-label="忽略时间块冲突"
                      type="checkbox"
                      checked={ignore}
                      onChange={(e) => setIgnore(e.target.checked)}
                    />
                    仍然保留这些重合时间，忽略冲突
                  </label>
                </>
              ) : (
                <p>未发现重合时间。</p>
              )}
              {report.warnings.length > 0 && <h3>请核对</h3>}
              {report.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
              <button
                type="button"
                className="primary"
                disabled={report.conflicts.items.length > 0 && !ignore}
                onClick={() => void submit(true)}
              >
                确认调整并锁定
              </button>
            </section>
          )}
        </fieldset>
      </form>
      {error && <p role="alert">{error}</p>}
    </dialog>
  )
}
