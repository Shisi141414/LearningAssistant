import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  applyNodeChanges,
  type Node,
  type NodeProps,
  type NodeChange,
  type ReactFlowInstance,
  type Edge
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ConceptRelation, ConceptRelationInput, KnowledgeGraph } from '@shared/knowledge-graph'
import { conceptRelationLabels, relationKey, relationLabel } from '@shared/knowledge-graph'
import { conceptKey } from '@shared/concept-matcher'
import { useAppStore } from '../stores/app'
import { conceptLayout } from '../utils/concept-layout'
import { ConceptUsage } from '../components/ConceptUsage'
import './knowledge-graph.css'

type KnowledgeNode = Node<{ label: string; subject: string; color: string }, 'concept'>
const colors = ['#8ebaca', '#abb2e0', '#9ec9b3', '#dcb8ca', '#d6c38d', '#a8c9da', '#c1bae2']
function ConceptNode({ data }: NodeProps<KnowledgeNode>) {
  return (
    <div className="knowledge-node" style={{ borderColor: data.color }} title={data.label}>
      <Handle type="target" position={Position.Left} aria-label="关系终点" />
      <strong>{data.label}</strong>
      <small>{data.subject}</small>
      <Handle type="source" position={Position.Right} aria-label="关系起点" />
    </div>
  )
}
const nodeTypes = { concept: ConceptNode }
const emptyRelation = (from = ''): ConceptRelationInput => ({
  from_id: from,
  to_id: '',
  relation: 'prerequisite',
  memo: ''
})
export function KnowledgeGraphPage() {
  const { subjects } = useAppStore(),
    [params, setParams] = useSearchParams()
  const selectedId = params.get('concept') ?? ''
  const [data, setData] = useState<KnowledgeGraph | null>(null),
    [nodes, setNodes] = useState<KnowledgeNode[]>([])
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [query, setQuery] = useState(''),
    [subject, setSubject] = useState('all'),
    [relationFilter, setRelationFilter] = useState('all'),
    [neighbors, setNeighbors] = useState(false)
  const [draft, setDraft] = useState<ConceptRelationInput>(() => emptyRelation(selectedId))
  const api = useRef<ReactFlowInstance<KnowledgeNode, Edge> | null>(null),
    lock = useRef(false),
    alive = useRef(true),
    generation = useRef(0)
  const subjectsRef = useRef(subjects)
  subjectsRef.current = subjects
  const refresh = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    setError('')
    const result = await window.api.concepts.graph()
    if (!alive.current || ticket !== generation.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const graph = result.data,
      saved = new Map(graph.positions.map((item) => [item.concept_id, item]))
    const automatic = conceptLayout(
      graph.concepts.map((item) => item.id),
      graph.relations
    )
    setData(graph)
    setNodes(
      graph.concepts.map((item, index) => {
        const point = saved.get(item.id) ?? automatic[index]
        const discipline = subjectsRef.current.find((s) => s.id === item.subject_id)
        const hash = [...(item.subject_id ?? '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
        return {
          id: item.id,
          type: 'concept',
          position: { x: point.x, y: point.y },
          data: {
            label: item.name,
            subject: discipline?.name ?? '通用概念',
            color: colors[hash % colors.length]
          },
          ariaLabel: `知识点：${item.name}`,
          width: 210,
          height: 82
        }
      })
    )
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      generation.current++
    }
  }, [refresh])
  const concepts = data?.concepts ?? [],
    relations = data?.relations ?? []
  const byId = useMemo(() => new Map(concepts.map((item) => [item.id, item])), [concepts])
  const selected = byId.get(selectedId)
  const cross = useCallback(
    (edge: ConceptRelation) => {
      const a = byId.get(edge.from_id)?.subject_id,
        b = byId.get(edge.to_id)?.subject_id
      return !!a && !!b && a !== b
    },
    [byId]
  )
  const visible = useMemo(() => {
    if (neighbors && selectedId)
      return new Set([
        selectedId,
        ...relations
          .filter((edge) => edge.from_id === selectedId || edge.to_id === selectedId)
          .flatMap((edge) => [edge.from_id, edge.to_id])
      ])
    const needle = conceptKey(query.trim())
    return new Set(
      concepts
        .filter(
          (item) =>
            (subject === 'all' || (item.subject_id ?? 'general') === subject) &&
            [item.name, ...item.aliases, item.summary ?? ''].some((text) =>
              conceptKey(text).includes(needle)
            )
        )
        .map((item) => item.id)
    )
  }, [concepts, relations, neighbors, selectedId, query, subject])
  const visibleNodes = useMemo(
    () =>
      nodes
        .filter((node) => visible.has(node.id))
        .map((node) => ({
          ...node,
          selected: node.id === selectedId,
          data: {
            ...node.data,
            subject:
              subjects.find((subject) => subject.id === byId.get(node.id)?.subject_id)?.name ??
              '通用概念'
          }
        })),
    [nodes, visible, selectedId, subjects, byId]
  )
  const edges = useMemo<Edge[]>(
    () =>
      relations
        .filter(
          (edge) =>
            visible.has(edge.from_id) &&
            visible.has(edge.to_id) &&
            (relationFilter === 'all' ||
              (relationFilter === 'cross' ? cross(edge) : edge.relation === relationFilter))
        )
        .map((edge) => ({
          id: relationKey(edge.from_id, edge.to_id),
          source: edge.from_id,
          target: edge.to_id,
          label: `${relationLabel(edge.relation)}${cross(edge) ? ' · 跨学科' : ''}`,
          type: 'default',
          markerEnd:
            edge.relation === 'related' || edge.relation === 'cross-subject'
              ? undefined
              : { type: MarkerType.ArrowClosed, color: '#7d8ba5' },
          style: {
            stroke: cross(edge) ? '#9b83b8' : '#91a4b9',
            strokeWidth: 2,
            strokeDasharray: cross(edge) ? '6 4' : undefined
          },
          labelStyle: { fill: '#52617b', fontSize: 12 },
          labelBgPadding: [6, 4],
          labelBgBorderRadius: 4
        })),
    [relations, visible, relationFilter, cross]
  )
  const fitted = useMemo(() => JSON.stringify(visibleNodes.map((node) => node.id)), [visibleNodes])
  useEffect(() => {
    if (api.current && visibleNodes.length) {
      const frame = requestAnimationFrame(() => {
        void api.current?.fitView({ padding: 0.2, maxZoom: 1.1 })
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [fitted])
  const choose = (id: string) => {
    setParams(id ? { concept: id } : {})
    setDraft(emptyRelation(id))
    setError('')
  }
  const edit = (edge: ConceptRelation) => {
    setDraft({
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: Object.hasOwn(conceptRelationLabels, edge.relation)
        ? (edge.relation as ConceptRelationInput['relation'])
        : 'related',
      memo: edge.memo,
      expected_revision: edge.revision
    })
    setError('')
  }
  const perform = async (
    action: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>,
    success: string,
    clear = false
  ) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await action()
      if (!alive.current) return
      if (!result.ok) setError(result.error)
      else {
        setMessage(success)
        if (clear) setDraft(emptyRelation(selectedId))
        await refresh()
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  const move = (moved: KnowledgeNode[]) => {
    if (!moved.length || lock.current) return
    void perform(
      () =>
        window.api.concepts.positions(
          moved.map((node) => ({ concept_id: node.id, ...node.position }))
        ),
      '布局已保存'
    )
  }
  const arrange = () => {
    if (lock.current || !data || !visibleNodes.length) return
    const positions = conceptLayout(
        visibleNodes.map((node) => node.id),
        relations
      ),
      points = new Map(positions.map((point) => [point.concept_id, point]))
    setNodes((previous) =>
      previous.map((node) =>
        points.has(node.id)
          ? { ...node, position: { x: points.get(node.id)!.x, y: points.get(node.id)!.y } }
          : node
      )
    )
    void perform(() => window.api.concepts.positions(positions), '当前范围已自动排布并保存')
    requestAnimationFrame(() => {
      void api.current?.fitView({ padding: 0.2, maxZoom: 1.1 })
    })
  }
  const connected = relations.filter(
    (edge) => edge.from_id === selectedId || edge.to_id === selectedId
  )
  return (
    <div className="page knowledge-graph-page">
      <div className="graph-heading">
        <div>
          <h1>知识图谱</h1>
          <p className="muted">从前置知识走向应用，沿关系找到下一步要学的内容。</p>
        </div>
        <Link to={`/knowledge${selectedId ? `?concept=${encodeURIComponent(selectedId)}` : ''}`}>
          返回知识列表
        </Link>
      </div>
      <div className="toolbar graph-filters">
        <input
          aria-label="搜索图谱知识"
          maxLength={500}
          placeholder="名称、别名或释义"
          disabled={neighbors}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="图谱学科"
          disabled={neighbors}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        >
          <option value="all">全部学科</option>
          <option value="general">通用概念</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="图谱关系筛选"
          value={relationFilter}
          onChange={(e) => setRelationFilter(e.target.value)}
        >
          <option value="all">全部关系</option>
          {Object.entries(conceptRelationLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
          <option value="cross">跨学科关系</option>
        </select>
        <button disabled={busy || loading || !visibleNodes.length} onClick={arrange}>
          自动排布当前范围
        </button>
        <button disabled={busy || loading} onClick={() => void refresh()}>
          刷新图谱
        </button>
      </div>
      {error && (
        <p role="alert" className="material-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="graph-workspace">
        <section className="graph-canvas-panel" aria-label="知识关系画布">
          <div className="graph-caption">
            <span>
              {visibleNodes.length} / {concepts.length} 个知识点 · {edges.length} 条关系
            </span>
            <label>
              <input
                type="checkbox"
                checked={neighbors}
                disabled={!selected}
                onChange={(e) => setNeighbors(e.target.checked)}
              />
              仅看所选点与全部邻接知识
            </label>
          </div>
          <div className="graph-canvas" aria-busy={loading}>
            <ReactFlow<KnowledgeNode, Edge>
              nodes={visibleNodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                api.current = instance
              }}
              onNodesChange={(changes: NodeChange<KnowledgeNode>[]) =>
                setNodes((previous) =>
                  applyNodeChanges(
                    changes.filter((change) => change.type !== 'remove'),
                    previous
                  )
                )
              }
              onNodeClick={(_event, node) => choose(node.id)}
              onEdgeClick={(_event, edge) => {
                const relation = relations.find(
                  (item) => relationKey(item.from_id, item.to_id) === edge.id
                )
                if (relation) edit(relation)
              }}
              onNodeDragStop={(_event, node, dragged) => move(dragged.length ? dragged : [node])}
              nodesDraggable={!busy && !loading}
              nodesConnectable={!busy && !loading}
              onConnect={(connection) => {
                if (connection.source && connection.target) {
                  setDraft({ ...emptyRelation(connection.source), to_id: connection.target })
                  setMessage('请确认关系类型与说明，再保存关系')
                }
              }}
              deleteKeyCode={null}
              fitView
              minZoom={0.08}
              maxZoom={2}
              onlyRenderVisibleElements
              proOptions={{ hideAttribution: false }}
              onKeyUp={(event) => {
                if (
                  event.key.startsWith('Arrow') &&
                  (event.target as HTMLElement).closest('.react-flow__node')
                )
                  requestAnimationFrame(() => move(api.current?.getNodes() ?? []))
              }}
              ariaLabelConfig={{
                'controls.zoomIn.ariaLabel': '放大图谱',
                'controls.zoomOut.ariaLabel': '缩小图谱',
                'controls.fitView.ariaLabel': '适应画布',
                'node.a11yDescription.default': '选择知识点查看详情，方向键可移动布局。'
              }}
            >
              <Background color="#d9e1ec" gap={24} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(node) => String(node.data.color)}
                pannable
                zoomable
                ariaLabel="图谱缩略图"
              />
            </ReactFlow>
            {!loading && !visibleNodes.length && (
              <div className="graph-empty">
                {concepts.length ? (
                  '没有匹配知识点，请调整筛选。'
                ) : (
                  <>
                    <p>先登记知识点，再建立学习关系。</p>
                    <Link to="/knowledge">新建知识点</Link>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="muted graph-help">
            拖动画布平移，滚轮缩放；拖动知识点可调整布局。前置箭头从已掌握内容指向后续知识，紫色虚线表示跨学科。拖动右端圆点到另一点左端可草拟关系，保存后生效。
          </p>
        </section>
        <aside className="graph-details" aria-label="图谱知识详情">
          <label>
            定位知识点
            <select
              aria-label="选择图谱知识点"
              value={selectedId}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">请选择知识点</option>
              {concepts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <>
              <h2>{selected.name}</h2>
              <p className="muted">
                {subjects.find((s) => s.id === selected.subject_id)?.name ?? '通用概念'}
              </p>
              {selected.aliases.length > 0 && <p>别名：{selected.aliases.join('、')}</p>}
              <p className="graph-summary">{selected.summary || '尚无释义'}</p>
              <Link to={`/knowledge?concept=${encodeURIComponent(selected.id)}`}>
                编辑知识与查看来源
              </Link>
              <section className="graph-relations" aria-label="所选知识关系">
                <h3>学习关系</h3>
                {connected.length ? (
                  connected.map((edge) => (
                    <button
                      key={relationKey(edge.from_id, edge.to_id)}
                      disabled={busy}
                      onClick={() => edit(edge)}
                    >
                      <span>
                        {byId.get(edge.from_id)?.name} {edge.relation === 'related' ? '—' : '→'}{' '}
                        {byId.get(edge.to_id)?.name}
                      </span>
                      <small>
                        {relationLabel(edge.relation)}
                        {cross(edge) ? ' · 跨学科' : ''}
                        {edge.memo ? `：${edge.memo}` : ''}
                      </small>
                    </button>
                  ))
                ) : (
                  <p className="muted">尚未建立关系，可在下方添加。</p>
                )}
              </section>
              <ConceptUsage key={selected.id} conceptId={selected.id} />
            </>
          ) : (
            <p className="muted">选择知识点，查看前置关系、跨学科联系及相关习题和任务。</p>
          )}
          <form
            className="graph-relation-editor"
            onSubmit={(e) => {
              e.preventDefault()
              void perform(() => window.api.concepts.relationSave(draft), '关系已保存', true)
            }}
          >
            <h3>{draft.expected_revision ? '编辑关系' : '建立关系'}</h3>
            <fieldset disabled={busy || loading}>
              <label>
                起点
                <select
                  aria-label="关系起点知识"
                  disabled={!!draft.expected_revision}
                  value={draft.from_id}
                  onChange={(e) => setDraft({ ...draft, from_id: e.target.value })}
                >
                  <option value="">请选择起点</option>
                  {concepts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                关系
                <select
                  aria-label="知识关系类型"
                  value={draft.relation}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      relation: e.target.value as ConceptRelationInput['relation']
                    })
                  }
                >
                  {Object.entries(conceptRelationLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                终点
                <select
                  aria-label="关系终点知识"
                  disabled={!!draft.expected_revision}
                  value={draft.to_id}
                  onChange={(e) => setDraft({ ...draft, to_id: e.target.value })}
                >
                  <option value="">请选择终点</option>
                  {concepts
                    .filter((item) => item.id !== draft.from_id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className="muted">
                {draft.relation === 'prerequisite'
                  ? '起点是终点的前置知识，先学起点，再学终点。'
                  : draft.relation === 'extends'
                    ? '起点可推广为终点；请在说明中写清适用条件。'
                    : '相关关系不区分先后，不自动推断学习顺序。'}
              </p>
              <label>
                关系说明
                <textarea
                  aria-label="知识关系说明"
                  maxLength={2000}
                  rows={3}
                  value={draft.memo}
                  onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                  placeholder="为什么需要先学，或怎样应用于另一个学科？"
                />
              </label>
              <div className="toolbar">
                <button className="primary" disabled={!draft.from_id || !draft.to_id} type="submit">
                  保存关系
                </button>
                <button type="button" onClick={() => setDraft(emptyRelation(selectedId))}>
                  新建另一关系
                </button>
                {draft.expected_revision && (
                  <button
                    className="danger"
                    type="button"
                    onClick={() => {
                      if (window.confirm('删除这条关系？知识点、教材证据和作答会保留。'))
                        void perform(
                          () =>
                            window.api.concepts.relationRemove({
                              from_id: draft.from_id,
                              to_id: draft.to_id,
                              expected_revision: draft.expected_revision!
                            }),
                          '关系已删除',
                          true
                        )
                    }}
                  >
                    删除关系
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        </aside>
      </div>
    </div>
  )
}
