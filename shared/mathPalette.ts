/**
 * shared/mathPalette.ts —— 数学符号面板数据（GeoGebra 风格）
 *
 * label：按钮上显示的内容（Unicode 直显或短文字）
 * latex：插入的 LaTeX 片段
 * brace：true 表示插入后光标移到第一个 {} 内（模板类）
 */

export interface MathSymbol {
  label: string
  latex: string
  /** 插入后光标移到第一个 {} 内 */
  brace?: boolean
  title?: string
}

export interface MathPaletteGroup {
  key: string
  label: string
  symbols: MathSymbol[]
}

const g = (label: string, latex: string): MathSymbol => ({ label, latex: `${latex} ` })
const tpl = (label: string, latex: string, title: string): MathSymbol => ({ label, latex, brace: true, title })

// One pair per key: Shift changes the symbol without dropping or moving keys.
// Unicode capitals also cover letters without a traditional TeX command (e.g. Α, Β).
const greekKeys = [
  ['α', '\\alpha', 'Α'], ['β', '\\beta', 'Β'], ['γ', '\\gamma', 'Γ'], ['δ', '\\delta', 'Δ'],
  ['ε', '\\epsilon', 'Ε'], ['ζ', '\\zeta', 'Ζ'], ['η', '\\eta', 'Η'], ['θ', '\\theta', 'Θ'],
  ['ι', '\\iota', 'Ι'], ['κ', '\\kappa', 'Κ'], ['λ', '\\lambda', 'Λ'], ['μ', '\\mu', 'Μ'],
  ['ν', '\\nu', 'Ν'], ['ξ', '\\xi', 'Ξ'], ['π', '\\pi', 'Π'], ['ρ', '\\rho', 'Ρ'],
  ['σ', '\\sigma', 'Σ'], ['τ', '\\tau', 'Τ'], ['υ', '\\upsilon', 'Υ'], ['φ', '\\phi', 'Φ'],
  ['χ', '\\chi', 'Χ'], ['ψ', '\\psi', 'Ψ'], ['ω', '\\omega', 'Ω'], ['ϕ', '\\varphi', 'Φ']
]

export const MATH_PALETTES: MathPaletteGroup[] = [
  {
    key: 'ops',
    label: '运算',
    symbols: [
      g('±', '\\pm'), g('∓', '\\mp'), g('×', '\\times'), g('·', '\\cdot'), g('÷', '\\div'),
      g('√', '\\sqrt'), tpl('x²', 'x^{2}', '平方（可改底数）'), tpl('xⁿ', 'x^{}', '上标'), tpl('aᵢ', 'x_{}', '下标'),
      g('∘', '\\circ'), g('⊕', '\\oplus'), g('⊗', '\\otimes'), g('∂', '\\partial'), g('∇', '\\nabla'), g('∞', '\\infty')
    ]
  },
  {
    key: 'tpl',
    label: '模板',
    symbols: [
      tpl('a/b', '\\frac{}{}', '分式'), tpl('ⁿ√', '\\sqrt[]{}', 'n 次根'), tpl('∑', '\\sum_{}^{}', '求和'),
      tpl('∏', '\\prod_{}^{}', '连乘'), tpl('∫', '\\int_{}^{}', '积分'), tpl('∮', '\\oint_{}^{}', '环路积分'),
      tpl('lim', '\\lim_{}', '极限'), g('d/dx', '\\frac{d}{dx}'), tpl('x̂', '\\hat{}', '帽子'),
      tpl('x̄', '\\bar{}', '横杠'), tpl('x⃗', '\\vec{}', '向量'), tpl('x̃', '\\tilde{}', '波浪'), tpl('x̄²', '\\overline{}', '上划线')
    ]
  },
  {
    key: 'rel',
    label: '关系',
    symbols: [
      g('≠', '\\neq'), g('≤', '\\leq'), g('≥', '\\geq'), g('≈', '\\approx'), g('≡', '\\equiv'),
      g('∼', '\\sim'), g('∝', '\\propto'), g('≪', '\\ll'), g('≫', '\\gg'), g('∈', '\\in'),
      g('∉', '\\notin'), g('⊂', '\\subset'), g('⊆', '\\subseteq'), g('∪', '\\cup'), g('∩', '\\cap'), g('∅', '\\emptyset')
    ]
  },
  {
    key: 'logic',
    label: '逻辑',
    symbols: [
      g('⇒', '\\Rightarrow'), g('⇐', '\\Leftarrow'), g('⇔', '\\Leftrightarrow'), g('→', '\\to'),
      g('↦', '\\mapsto'), g('∀', '\\forall'), g('∃', '\\exists'), g('¬', '\\neg'),
      g('∧', '\\wedge'), g('∨', '\\vee'), g('∴', '\\therefore'), g('∵', '\\because')
    ]
  },
  {
    key: 'greek-lower',
    label: '希腊小写',
    symbols: greekKeys.map(([lower, latex]) => g(lower, latex))
  },
  {
    key: 'greek-upper',
    label: '希腊大写',
    symbols: greekKeys.map(([, , upper]) => g(upper, upper))
  },
  {
    key: 'misc',
    label: '力学常用',
    symbols: [
      g('ℓ', '\\ell'), g('ℏ', '\\hbar'), g('°', '^\\circ'), g('′', '\\prime'),
      g('⋅', '\\mathbf'), g('‖', '\\|'), g('⌊⌋', '\\lfloor\\rfloor'),
      tpl('sin', '\\sin{}', '正弦'), tpl('cos', '\\cos{}', '余弦'), tpl('exp', '\\exp{}', '指数'),
      tpl('ln', '\\ln{}', '自然对数'), tpl('log', '\\log_{}', '对数'), g('d x', '\\,dx'), g('~', '\\,'),
      tpl('【矩阵', '\\begin{pmatrix} \\\\ \\end{pmatrix}', '2 行矩阵，可增行'), tpl('cases', '\\begin{cases} \\\\ \\end{cases}', '分段函数')
    ]
  }
]
