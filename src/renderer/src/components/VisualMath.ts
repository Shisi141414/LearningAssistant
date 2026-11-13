import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { MathfieldElement } from 'mathlive'
import 'mathlive/fonts.css'
import { mathTokens } from '@shared/math-editor'

MathfieldElement.fontsDirectory = null // Vite bundles the imported CSS/fonts locally.
MathfieldElement.soundsDirectory = null

export const VisualMath = Node.create({
  name: 'visualMath',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return { latex: { default: '' }, display: { default: false }, source: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'span[data-visual-math]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-visual-math': '' })]
  },
  addInputRules() {
    return [
      new InputRule({
        find: /(\$\$[^$]+\$\$|\$[^$\n]+\$)$/,
        handler: ({ state, range, match }) => {
          const prefix = state.doc.textBetween(0, range.from, '\n', '\ufffc')
          if (
            (prefix.match(/```/g)?.length ?? 0) % 2 ||
            (prefix.split('\n').at(-1)?.match(/`/g)?.length ?? 0) % 2 ||
            (prefix.match(/\\+$/)?.[0].length ?? 0) % 2
          )
            return null
          const token = mathTokens(match[0])[0]
          if (token?.type !== 'formula' || token.text !== match[0]) return null
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex: token.latex, display: token.display, source: token.text })
          )
        }
      })
    ]
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('span')
      dom.className = 'visual-math-node' + (node.attrs.display ? ' visual-math-display' : '')
      dom.contentEditable = 'false'
      const field = new MathfieldElement()
      field.setAttribute('aria-label', '编辑数学公式')
      field.mathVirtualKeyboardPolicy = 'manual'
      field.value = node.attrs.latex
      field.addEventListener('input', () => {
        const position = getPos()
        if (typeof position !== 'number') return
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(position, undefined, {
            ...current.attrs,
            latex: field.value,
            source: null
          })
        )
      })
      field.addEventListener('move-out', (event) => {
        const position = getPos()
        if (typeof position !== 'number') return
        event.preventDefault()
        const backward = ['backward', 'upward'].includes(event.detail.direction)
        editor.commands.setTextSelection(backward ? position : position + current.nodeSize)
        editor.commands.focus()
      })
      // Enter exits the formula before invoking the surrounding message/record shortcut.
      field.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Enter' && !event.isComposing) {
            const position = getPos()
            if (typeof position === 'number')
              editor.commands.setTextSelection(position + current.nodeSize)
            event.preventDefault()
            event.stopImmediatePropagation()
            requestAnimationFrame(() => editor.commands.focus())
          }
        },
        true
      )
      dom.append(field)
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        update(updated) {
          if (updated.type !== current.type) return false
          current = updated
          if (field.value !== updated.attrs.latex)
            field.setValue(updated.attrs.latex, { silenceNotifications: true })
          dom.classList.toggle('visual-math-display', !!updated.attrs.display)
          return true
        }
      }
    }
  }
})
