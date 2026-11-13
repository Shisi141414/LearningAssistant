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
import { mathEditorDocument, mathEditorText } from '@shared/math-editor'
import { VisualMath } from './VisualMath'
import { MathKeyboard, type MathKeyboardCommand } from './MathKeyboard'

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
  const [placement, setPlacement] = useState({ below: false, height: 300 })
  const latest = useRef({ onChange, onKeyDown })
  latest.current = { onChange, onKeyDown }
  const emitted = useRef(value)
  const lastField = useRef<MathfieldElement | null>(null)
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
  }, [open, value])
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
    const focused = focusedField()
    if (focused) {
      HTMLElement.prototype.focus.call(focused, { preventScroll: true })
      focused.focus()
      focused.insert(latex.replace(/\{\}/g, '{#?}').replace(/\[\]/g, '[#?]'), {
        selectionMode: brace ? 'placeholder' : 'after'
      })
      return
    }
    if (!editor) return
    const template = (
      brace
        ? latex.replace(/\{\}/g, '{\\placeholder{}}').replace(/\[\]/g, '[\\placeholder{}]')
        : latex.trim()
    ).replace(/#@/g, '\\placeholder{}')
    editor.view.focus()
    editor
      .chain()
      .insertContent({
        type: 'visualMath',
        attrs: { latex: template, display: false, source: null }
      })
      .run()
    const position = editor.state.selection.from - 1
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return
      const dom = editor.view.nodeDOM(position) as HTMLElement | null
      const field = dom?.querySelector('math-field') as MathfieldElement | null
      // Do not let a pending insertion steal focus after the user switches inputs/pages.
      if (document.activeElement !== editor.view.dom && document.activeElement !== field) return
      if (field) HTMLElement.prototype.focus.call(field, { preventScroll: true })
      field?.focus()
      if ((brace || latex.includes('#@')) && field) {
        field.position = 0
        field.executeCommand('moveToNextPlaceholder')
      }
    })
  }

  const focusedField = (): MathfieldElement | null => {
    const active = document.activeElement
    if (active instanceof MathfieldElement && wrapRef.current?.contains(active)) return active
    if (
      active instanceof HTMLElement &&
      active.closest('.math-palette') &&
      lastField.current?.isConnected
    )
      return lastField.current
    return null
  }

  const runKeyboard = (command: MathKeyboardCommand): void => {
    if (!editor) return
    const field = focusedField()
    if (field) {
      HTMLElement.prototype.focus.call(field, { preventScroll: true })
      field.focus()
      if (command === 'exit' || (command === 'backspace' && !field.value)) {
        field.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: command === 'exit' ? 'Enter' : 'Backspace',
            bubbles: true,
            cancelable: true
          })
        )
      } else {
        const commands = {
          backspace: 'deleteBackward',
          left: 'moveToPreviousChar',
          right: 'moveToNextChar',
          next: 'moveToNextPlaceholder'
        } as const
        field.executeCommand(commands[command])
      }
      return
    }
    const { view } = editor
    view.focus()
    if (command === 'backspace') {
      const event = new KeyboardEvent('keydown', {
        key: 'Backspace',
        bubbles: true,
        cancelable: true
      })
      if (view.someProp('handleKeyDown', (handler) => handler(view, event))) return
      const { selection } = view.state
      if (selection.empty && selection.$from.nodeBefore?.isText) {
        const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset)
        const segment = [
          ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(before)
        ].at(-1)
        if (segment)
          editor.commands.deleteRange({
            from: selection.from - segment.segment.length,
            to: selection.from
          })
      }
    } else if (command === 'left' || command === 'right') {
      // Chromium moves by grapheme and respects paragraph/inline-node boundaries.
      view.dom.ownerDocument
        .getSelection()
        ?.modify('move', command === 'left' ? 'backward' : 'forward', 'character')
    } else if (command === 'exit' && multiline) {
      editor.commands.setHardBreak()
    }
  }

  return (
    <div
      className={`math-input-wrap ${multiline ? '' : 'math-input-inline'}`}
      ref={wrapRef}
      onFocusCapture={(event) => {
        if (event.target instanceof MathfieldElement) lastField.current = event.target
        else if (
          event.target instanceof HTMLElement &&
          event.target.classList.contains('math-editor')
        )
          lastField.current = null
      }}
    >
      <div className="math-input-row">
        <EditorContent
          editor={editor}
          className="math-editor-container"
          style={minHeight ? { minHeight } : undefined}
        />
        <button
          type="button"
          className={`math-toggle${open ? ' active' : ''}`}
          title="数学键盘"
          aria-label="数学键盘"
          aria-expanded={open}
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
          <MathKeyboard onInsert={insert} onCommand={runKeyboard} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
