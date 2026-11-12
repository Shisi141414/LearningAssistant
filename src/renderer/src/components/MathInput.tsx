/**
 * components/MathInput.tsx —— GeoGebra 风格数学输入
 *
 * - 输入框 + [∑] 符号面板按钮：分类网格，点击在光标处插入 LaTeX
 *   （模板类插入后光标自动落到第一个 {} 内）
 * - 多行模式带 KaTeX 实时预览（复用 MarkdownSegment 的 $/$$ 渲染）
 * - multiline=false 时渲染单行 input（快捷栏等紧凑场景，无预览浮层占位）
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { MATH_PALETTES } from '@shared/mathPalette'
import { MarkdownSegment } from './MarkdownSegment'

export function MathInput({
  value,
  onChange,
  placeholder,
  multiline = true,
  minHeight,
  className,
  onKeyDown,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  multiline?: boolean
  minHeight?: number
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  autoFocus?: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(MATH_PALETTES[0].key)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  // 点击面板外部关闭
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const insert = (latex: string, brace?: boolean): void => {
    const ta = ref.current
    const start = ta?.selectionStart ?? value.length
    const end = ta?.selectionEnd ?? start
    const next = value.slice(0, start) + latex + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      if (!ref.current) return
      let pos = start + latex.length
      if (brace) {
        const i = latex.indexOf('{}')
        if (i >= 0) pos = start + i + 1
      }
      ref.current.focus()
      ref.current.setSelectionRange(pos, pos)
    })
  }

  const active = MATH_PALETTES.find((gp) => gp.key === group) ?? MATH_PALETTES[0]
  const showPreview = multiline && /\$[^$]+\$/.test(value)

  return (
    <div className={`math-input-wrap ${multiline ? '' : 'math-input-inline'}`} ref={wrapRef}>
      <div className="math-input-row">
        {multiline ? (
          <textarea
            ref={ref as React.RefObject<HTMLTextAreaElement>}
            value={value}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
            onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLTextAreaElement>}
            className={className}
            style={minHeight ? { minHeight } : undefined}
          />
        ) : (
          <input
            ref={ref as React.RefObject<HTMLInputElement>}
            value={value}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLInputElement>}
            className={className}
          />
        )}
        <button
          type="button"
          className={`math-toggle${open ? ' active' : ''}`}
          title="数学符号面板"
          onMouseDown={(e) => e.preventDefault()} // 保持输入框焦点
          onClick={() => setOpen((v) => !v)}
        >
          ∑
        </button>
      </div>

      {open && (
        <div className="math-palette">
          <div className="math-palette-tabs">
            {MATH_PALETTES.map((gp) => (
              <button
                type="button"
                key={gp.key}
                className={gp.key === group ? 'active' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setGroup(gp.key)}
              >
                {gp.label}
              </button>
            ))}
          </div>
          <div className="math-palette-grid">
            {active.symbols.map((sym, i) => (
              <button
                type="button"
                key={`${active.key}-${i}`}
                title={sym.title ?? `插入 ${sym.latex}`}
                onMouseDown={(e) => e.preventDefault()} // 插入后焦点/光标不丢
                onClick={() => insert(sym.latex, sym.brace)}
              >
                {sym.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {showPreview && (
        <div className="math-preview">
          <span className="math-preview-label">预览</span>
          <MarkdownSegment text={value} plain />
        </div>
      )}
    </div>
  )
}
