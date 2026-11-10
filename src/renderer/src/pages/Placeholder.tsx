/**
 * pages/Placeholder.tsx —— 后续里程碑页面的占位
 */
export function Placeholder({ title, stage, desc }: { title: string; stage: string; desc: string }) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🚧</div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          {title} · 计划在 {stage} 里程碑实现
        </div>
        <div className="muted">{desc}</div>
      </div>
    </div>
  )
}
