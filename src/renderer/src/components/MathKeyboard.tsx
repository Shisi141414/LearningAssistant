import { useMemo, useState } from 'react'
import katex from 'katex'
import { MATH_PALETTES, type MathSymbol } from '@shared/mathPalette'

export type MathKeyboardCommand = 'backspace' | 'left' | 'right' | 'next' | 'exit'
type Key = MathSymbol & { preview?: string; command?: MathKeyboardCommand }
const symbol = (latex: string, title = latex, preview = latex): Key => ({
  label: title,
  latex,
  title,
  preview
})
const template = (latex: string, title: string, preview: string): Key => ({
  ...symbol(latex, title, preview),
  brace: true
})
const action = (command: MathKeyboardCommand, label: string, title: string): Key => ({
  command,
  label,
  title,
  latex: ''
})
const backspace = action('backspace', '⌫', '退格')
const left = action('left', '‹', '向左移动')
const right = action('right', '›', '向右移动')
const exit = action('exit', '↵', '回到正文或换行')
const next = action('next', '⇥', '下一占位格')
const fraction = template('\\frac{}{}', '分式', '\\frac{\\square}{\\square}')
const power = template('#@^{}', '乘方', '\\square^{\\square}')
const root = template('\\sqrt{}', '平方根', '\\sqrt{\\square}')
const subscript = template('#@_{}', '下标', '\\square_{\\square}')

const numericLeft: Key[][] = [
  [symbol('x'), symbol('y'), symbol('\\pi', 'π'), symbol('e')],
  [
    symbol('#@^{2}', '平方', '\\square^2'),
    power,
    root,
    template('\\left|{}\\right|', '绝对值', '|\\square|')
  ],
  [symbol('<'), symbol('>'), fraction, subscript],
  [symbol('\\infty', '∞'), symbol(','), symbol('('), symbol(')')]
]
const numericRight: Key[][] = [
  [symbol('7'), symbol('8'), symbol('9'), symbol('\\times', '×'), symbol('\\div', '÷')],
  [symbol('4'), symbol('5'), symbol('6'), symbol('+'), symbol('-', '−')],
  [symbol('1'), symbol('2'), symbol('3'), symbol('='), backspace],
  [symbol('0'), symbol('.'), left, right, exit]
]
const functionsLeft: Key[][] = [
  ['sin', 'cos', 'tan'].map((f) => template(`\\${f}\\left({}\\right)`, f, `\\${f}`)),
  ['sin', 'cos', 'tan'].map((f) => template(`\\arc${f}\\left({}\\right)`, `反${f}`, `\\${f}^{-1}`)),
  [
    template('\\ln\\left({}\\right)', '自然对数', '\\ln'),
    template('\\log_{10}\\left({}\\right)', '常用对数', '\\log_{10}'),
    template('\\log_{}\\left({}\\right)', '对数', '\\log_{\\square}')
  ],
  [
    template('e^{}', 'e 的乘方', 'e^{\\square}'),
    template('10^{}', '10 的乘方', '10^{\\square}'),
    template('\\sqrt[]{}', 'n 次根', '\\sqrt[\\square]{\\square}')
  ]
]
const functionsRight: Key[][] = [
  [
    symbol('\\%', '%'),
    symbol('!'),
    symbol('^{\\circ}', '角度', '{}^{\\circ}'),
    symbol('\\partial', '∂')
  ],
  [symbol('\\{', '{'), symbol('\\}', '}'), symbol('\\leq', '≤'), symbol('\\geq', '≥')],
  [
    symbol('\\frac{d}{dx}', '导数'),
    template('\\int_{}^{}', '积分', '\\int_{\\square}^{\\square}'),
    symbol('i'),
    backspace
  ],
  [subscript, left, right, exit]
]

const tabs = [
  { key: 'numeric', label: '123', title: '常用数学' },
  { key: 'functions', label: 'f(x)', title: '函数' },
  { key: 'letters', label: 'ABC', title: '字母' },
  { key: 'greek', label: 'αβγ', title: '希腊字母' },
  { key: 'symbols', label: '#&¬', title: '符号' },
  { key: 'more', label: '更多', title: '更多数学符号与模板' }
]

// Static, trusted key labels only; the existing KaTeX engine draws the template slots.
function KeyLabel({ keycap }: { keycap: Key }): React.ReactNode {
  const preview = keycap.preview
  const html = useMemo(() => {
    if (!preview) return null
    try {
      return katex.renderToString(preview, { throwOnError: true, strict: 'ignore', output: 'html' })
    } catch {
      return null
    }
  }, [preview])
  return html ? (
    <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    keycap.label
  )
}

export function MathKeyboard({
  onInsert,
  onCommand,
  onClose
}: {
  onInsert: (latex: string, brace?: boolean) => void
  onCommand: (command: MathKeyboardCommand) => void
  onClose: () => void
}): React.ReactNode {
  const [tab, setTab] = useState('numeric')
  const [upper, setUpper] = useState(false)
  const [group, setGroup] = useState('tpl')
  const renderKey = (keycap: Key, index: number): React.ReactNode => (
    <button
      key={index}
      type="button"
      title={keycap.title ?? keycap.label}
      aria-label={keycap.title ?? keycap.label}
      className={`math-key${keycap.command ? ' math-key-action' : ''}${keycap.command === 'exit' ? ' math-key-return' : ''}`}
      onClick={() =>
        keycap.command ? onCommand(keycap.command) : onInsert(keycap.latex, keycap.brace)
      }
    >
      <KeyLabel keycap={keycap} />
    </button>
  )
  const zone = (rows: Key[][]): React.ReactNode => (
    <div
      className="math-key-zone"
      style={{ gridTemplateColumns: `repeat(${rows[0].length}, minmax(0, 1fr))` }}
    >
      {rows.flat().map(renderKey)}
    </div>
  )
  const symbols =
    tab === 'greek'
      ? MATH_PALETTES.find((g) => g.key === (upper ? 'greek-upper' : 'greek-lower'))!.symbols
      : tab === 'symbols'
        ? [
            ...MATH_PALETTES.find((g) => g.key === 'rel')!.symbols,
            ...MATH_PALETTES.find((g) => g.key === 'logic')!.symbols
          ]
        : MATH_PALETTES.find((g) => g.key === group)!.symbols

  return (
    <div
      className="math-keyboard"
      role="group"
      aria-label="数学键盘"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="math-keyboard-header">
        <div className="math-palette-tabs" role="tablist" aria-label="数学键盘分类">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              title={item.title}
              className={tab === item.key ? 'active' : ''}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="math-keyboard-close"
          aria-label="收起数学键盘"
          title="收起数学键盘"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {tab === 'numeric' || tab === 'functions' ? (
        <div
          className={`math-keyboard-split ${tab === 'functions' ? 'math-keyboard-functions' : ''}`}
        >
          {zone(tab === 'numeric' ? numericLeft : functionsLeft)}
          {zone(tab === 'numeric' ? numericRight : functionsRight)}
        </div>
      ) : tab === 'letters' ? (
        <div className="math-letter-rows">
          {['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row) => (
            <div className="math-letter-row" key={row}>
              {[...(upper ? row.toUpperCase() : row)].map((letter, index) =>
                renderKey(symbol(letter), index)
              )}
            </div>
          ))}
          <div className="math-letter-actions">
            <button
              type="button"
              className="math-key math-key-action"
              aria-label="切换大小写"
              aria-pressed={upper}
              onClick={() => setUpper(!upper)}
            >
              ⇧
            </button>
            {renderKey(symbol('\\,', '空格', '\\text{空格}'), 0)}
            {[left, right, backspace, exit].map(renderKey)}
          </div>
        </div>
      ) : (
        <>
          {tab === 'more' && (
            <div className="math-keyboard-groups">
              {MATH_PALETTES.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={group === g.key}
                  className={group === g.key ? 'active' : ''}
                  onClick={() => setGroup(g.key)}
                >
                  {g.label}
                </button>
              ))}
            </div>
          )}
          <div className="math-palette-grid">
            {symbols.map((s, i) =>
              renderKey(
                {
                  ...s,
                  preview: s.latex
                    .trim()
                    .replace(/^(\\sqrt|\\mathbf)$/, '$1{\\square}')
                    .replace(/\{\}/g, '{\\square}')
                    .replace(/\[\]/g, '[\\square]')
                },
                i
              )
            )}
          </div>
          <div className="math-letter-actions">
            {tab === 'greek' && (
              <button
                type="button"
                className="math-key math-key-action"
                aria-label="切换希腊字母大小写"
                aria-pressed={upper}
                onClick={() => setUpper(!upper)}
              >
                ⇧
              </button>
            )}
            {[next, left, right, backspace, exit].map(renderKey)}
          </div>
        </>
      )}
    </div>
  )
}
