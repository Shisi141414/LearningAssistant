/**
 * shared/diagSamples.ts —— 功能自检的固定测试资产
 * （样例文本 + 内嵌 64×64 红色 PNG，识别测试应返回"红色/方块"类描述）
 */

/** 笔记整理测试样例：含同音错字（科西→柯西）、口语化表达 */
export const DIAG_ORGANIZE_SAMPLE =
  '好那我们今天讲科西中值定理啊，这个科西中值定理呢，它是拉格朗日中值定理的一个推广形式，就是说设函数f和g在闭区间a b上连续，在开区间a b内可导，并且呢g一撇在开区间内不为零，那么呢就存在一点ξ属于开区间a b，使得f一撇ξ比上g一撇ξ等于f b减f a除以g b减g a，这个就是这个定理的内容'

/** 文件切分测试样例：模拟教材结构（两级标题 + 长短段落混合） */
export const DIAG_CHUNK_SAMPLE = `# 第二章 极限与连续

极限是分析学的基础概念，描述函数在自变量变化过程中的趋势行为。

## §2.1 数列的极限

设 {a_n} 是一个数列，若存在常数 a，对于任意给定的正数 ε，总存在正整数 N，使得当 n > N 时，不等式 |a_n - a| < ε 成立，则称常数 a 为数列 {a_n} 的极限，记作 lim a_n = a (n→∞)。

这个定义的核心是"任意小、总能到"：ε 刻画接近程度，N 刻画"足够晚之后"。几何上，落在 (a-ε, a+ε) 之外至多只有有限项。

## §2.2 函数的极限

函数极限与数列极限思想一致，但自变量趋近方式更多：x→x₀、x→x₀⁺、x→x₀⁻、x→∞ 等。左右极限存在且相等是 x→x₀ 极限存在的充要条件。

例：讨论符号函数 sgn(x) 在 x=0 处的极限。左极限为 -1，右极限为 1，不相等，故极限不存在。

## §2.3 无穷小与无穷大

无穷小是极限为零的变量。有限个无穷小之和仍为无穷小；有界函数与无穷小的乘积仍为无穷小。注意：无穷多个无穷小之和不一定是无穷小。`

/**
 * 识图测试内嵌图片：64×64 纯红 (#dc2626) PNG，178 字节。
 * 预期 vision 模型回答"红色/纯色/方块"。
 */
export const DIAG_VISION_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwKqpf0ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWt125G4EPHrsLDgAAAABJRU5ErkJggg=='
