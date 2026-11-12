import { useMemo, useState } from 'react'
import type { NoteLearningDocument, NoteLearningSyncPreview } from '@shared/types'
import { learningTypes } from '@shared/learning-document'

export function NoteLearningSync({ document, preview, busy, onCancel, onConfirm }: { document: NoteLearningDocument; preview: NoteLearningSyncPreview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [offset, setOffset] = useState(0)
  const changes = useMemo(() => {
    const oldBySegment = new Map(document.sources.map(source => [document.origins[source.id].segment_id, source]))
    const nextBySegment = new Map(preview.sources.map(source => [preview.origins[source.id].segment_id, source]))
    const affected = new Set(preview.summary.affected_entry_ids)
    const affectedSources = new Set(document.state.entries.filter(entry => affected.has(entry.id)).flatMap(entry => entry.sources.map(ref => ref.source_id)))
    return [...new Set([...nextBySegment.keys(), ...oldBySegment.keys()])].map(id => ({ id, before: oldBySegment.get(id), after: nextBySegment.get(id) }))
      .filter(row => row.before?.id !== row.after?.id || row.before && affectedSources.has(row.before.id))
  }, [document, preview])
  const summary = preview.summary
  return <section className="learning-sync-preview" aria-label="笔记来源同步预览">
    <h3>核对来源变化，再发布新修订</h3>
    <p>新增 {summary.added_segments} 段、更新 {summary.changed_segments} 段、移除 {summary.removed_segments} 段。保留 {summary.retained_entries} 个条目，重新建立 {summary.recreated_entries} 个条目；解除 {summary.removed_relations} 个证明/解答关联，移除 {summary.removed_formulas} 个公式校正，调整 {summary.reparented_entries} 个已有条目的章节归属。</p>
    <p className="muted">受影响范围的拆分、类型、标题和公式校正需要重新核对；其余结构保留。旧修订及原始转写不改写。关闭预览不会同步。</p>
    {changes.slice(offset, offset + 100).map(row => <details key={row.id}><summary>{row.before ? row.after ? '更新或重新整理' : '移除' : '新增'} · {row.before ? `原第 ${row.before.ordinal + 1}` : `新第 ${row.after!.ordinal + 1}`} 段</summary>
      <div className="learning-sync-comparison">
        <div><h4>原修订</h4><p className="learning-entry-text">{row.before?.raw_text ?? '（无）'}</p>{row.before && <p className="muted">条目：{document.state.entries.filter(entry => entry.sources.some(ref => ref.source_id === row.before!.id)).map(entry => `${learningTypes[entry.type]} ${entry.title}`).join('；')}</p>}</div>
        <div><h4>同步后</h4><p className="learning-entry-text">{row.after?.raw_text ?? '（已移除）'}</p>{row.after && <p className="muted">条目：{preview.state.entries.filter(entry => entry.sources.some(ref => ref.source_id === row.after!.id)).map(entry => `${learningTypes[entry.type]} ${entry.title}`).join('；')}</p>}</div>
      </div>
      {row.after && <details><summary>新的原始转写</summary><p className="learning-entry-text">{preview.origins[row.after.id].raw_text || '（为空）'}</p></details>}
    </details>)}
    {summary.removed_relations > 0 && <details><summary>将解除的归属关系</summary>{document.state.relations.filter(relation => !preview.state.relations.some(next => next.from === relation.from && next.to === relation.to)).map(relation => <p key={relation.from}>{document.state.entries.find(entry => entry.id === relation.from)?.title || '未命名证明/解答'} → {document.state.entries.find(entry => entry.id === relation.to)?.title || '未命名对象'}</p>)}</details>}
    {summary.removed_formulas > 0 && <details><summary>需要重新校正的公式 · 可复制原 LaTeX</summary>{document.state.entries.filter(entry => summary.affected_entry_ids.includes(entry.id)).flatMap(entry => (entry.formulas ?? []).map(formula => <p key={`${entry.id}:${formula.range.join(':')}`}>{entry.title || learningTypes[entry.type]}：<code>{formula.latex}</code></p>))}</details>}
    {changes.length > 100 && <div className="toolbar"><button disabled={busy || !offset} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一组变化</button><span>{offset + 1}–{Math.min(offset + 100, changes.length)} / {changes.length}</span><button disabled={busy || offset + 100 >= changes.length} onClick={() => setOffset(value => value + 100)}>下一组变化</button></div>}
    <div className="toolbar"><button disabled={busy} onClick={onCancel}>关闭同步预览</button><button className="primary" disabled={busy} onClick={onConfirm}>确认同步并保存新修订</button></div>
  </section>
}
