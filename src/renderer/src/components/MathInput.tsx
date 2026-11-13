/** Plain text and editable, rendered formulas in one input surface. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { Slice } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HardBreak from '@tiptap/extension-hard-break'
import { UndoRedo } from '@tiptap/extensions/undo-redo'
import { Placeholder } from '@tiptap/extensions/placeholder'
import { MathfieldElement } from 'mathlive'
import { MATH_PALETTES } from '@shared/mathPalette'
import { mathEditorDocument, mathEditorText } from '@shared/math-editor'
import { VisualMath } from './VisualMath'

export function MathInput({
  value,
  onChange,
  placeholder,
  label,
  multiline = true,
  minHeight,
  className,
  onKeyDown,
  autoFocus
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label?: string
  multiline?: boolean
  minHeight?: number
  className?: string
  onKeyDown?: (e: KeyboardEvent) => void
  autoFocus?: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(MATH_PALETTES[0].key)
  const [placement, setPlacement] = useState({ below: false, height: 300 })
  const latest = useRef({ onChange, onKeyDown })
  latest.current = { onChange, onKeyDown }
  const emitted = useRef(value)
  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      UndoRedo,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      VisualMath
    ],
    content: mathEditorDocument(value),
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': label ?? placeholder ?? '数学文本输入',
        'aria-multiline': String(multiline),
        class: `math-editor ${className ?? ''}`
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false
        latest.current.onKeyDown?.(event)
        if (!multiline && event.key === 'Enter') {
          event.preventDefault()
          return true
        }
        return event.defaultPrevented
      },
      handlePaste: (_view, event) => {
        const formula = event.clipboardData?.getData('application/x-latex')
        const text = formula ? '$' + formula + '$' : event.clipboardData?.getData('text/plain')
        event.preventDefault()
        if (text === undefined || (!formula && !event.clipboardData?.types.includes('text/plain')))
          return true
        const parsed = _view.state.schema.nodeFromJSON(
          mathEditorDocument(multiline ? text : text.replace(/\r?\n/g, ' '))
        )
        _view.dispatch(
          closeHistory(_view.state.tr)
            .replaceSelection(new Slice(parsed.content, 1, 1))
            .scrollIntoView()
        )
        return true
      },
      clipboardTextSerializer: (slice) =>
        mathEditorText({ type: 'doc', content: slice.content.toJSON() })
    },
    onUpdate: ({ editor: updated }) => {
      emitted.current = mathEditorText(updated.getJSON())
      latest.current.onChange(emitted.current)
    }
  })
  useEffect(() => {
    if (editor && value !== emitted.current) {
      editor.commands.setContent(mathEditorDocument(value), { emitUpdate: false })
      emitted.current = value
    }
  }, [editor, value])

  // 点击面板外部关闭
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const bounds = wrapRef.current?.getBoundingClientRect()
      if (!bounds) return
      const above = bounds.top,
        below = window.innerHeight - bounds.bottom
      const down = above < 280 && below > above
      setPlacement({ below: down, height: Math.max(100, (down ? below : above) - 12) })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, group, value])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const insert = (latex: string, brace?: boolean): void => {
    if (latex.trim() === String.raw`\sqrt` || latex.trim() === String.raw`\mathbf`) {
      latex = latex.trim() + '{}'
      brace = true
    }
    const focused = document.activeElement
    if (focused instanceof MathfieldElement && wrapRef.current?.contains(focused)) {
      focused.insert(latex.replace(/\{\}/g, '{#?}'), {
        selectionMode: brace ? 'placeholder' : 'after'
      })
      return
    }
    if (!editor) return
    const template = brace ? latex.replace(/\{\}/g, '{\\placeholder{}}') : latex.trim()
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'visualMath',
        attrs: { latex: template, display: false, source: null }
      })
      .run()
    const position = editor.state.selection.from - 1
    requestAnimationFrame(() => {
      const dom = editor.view.nodeDOM(position) as HTMLElement | null
      const field = dom?.querySelector('math-field') as MathfieldElement | null
      field?.focus()
      if (brace && field) {
        field.position = 0
        field.executeCommand('moveToNextPlaceholder')
      }
    })
  }

  const active = MATH_PALETTES.find((gp) => gp.key === group) ?? MATH_PALETTES[0]

  return (
    <div className={`math-input-wrap ${multiline ? '' : 'math-input-inline'}`} ref={wrapRef}>
      <div className="math-input-row">
        <EditorContent
          editor={editor}
          className="math-editor-container"
          style={minHeight ? { minHeight } : undefined}
        />
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
        <div
          className={`math-palette${placement.below ? ' math-palette-below' : ''}`}
          style={{ maxHeight: placement.height, overflowY: 'auto' }}
        >
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
    </div>
  )
}
