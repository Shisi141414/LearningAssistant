import { Temporal } from '@js-temporal/polyfill'
import { memoTimestamp } from './memo-recognition'
import type { MemoProposal, MemoVersion } from './memos'

/** Validate model dates against explicit source clocks; never use model confidence as authority. */
export function verifyMemoTime(
  source: MemoVersion,
  task: NonNullable<MemoProposal['task']>
): void {
  const text = source.content.normalize('NFKC')
  const temporal =
    /\d{1,2}[:：/]\d{1,2}|[\d零〇一二两三四五六七八九十百几数]+\s*个?[点时号天日年月周]|今天|明天|后天|昨天|前天|今晚|明晚|今早|明早|本周|下周|周末|周[一二三四五六日天]|星期|课前|课后|饭后|会后|之前|以后|稍后|过会|月底|月初|下次|下个|每天|每周|小时|分钟|早上|上午|中午|下午|晚上|傍晚|夜里|凌晨|deadline|tomorrow|today|tonight|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b(?:am|pm|weeks?|days?|hours?|minutes?|soon)\b/i
  if (!temporal.test(text)) {
    if (task.start || task.end || task.due || task.time_text)
      throw new Error('候选时间没有可核对的原文日期')
    return
  }
  if (source.timezone === 'unknown')
    throw new Error('原文时区未知，请手工确认时间')
  if (
    /每[天周月年]|下次|下个|课前|课后|月底|小时|分钟|以后|之后|左右|大概|大约|可能|取消|改期/.test(
      text
    )
  )
    throw new Error('重复、课程、估计或变更时间需手工确认')
  const base = Temporal.Instant.fromEpochMilliseconds(source.created_at)
    .toZonedDateTimeISO(source.timezone)
    .toPlainDate()
  const dates = [
    ...text.matchAll(
      /(?<!\d)(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})(?:日|号)?|今天|明天|后天|(?:本周|下周)(?:周)?[一二三四五六日天]/g
    )
  ]
  if (dates.length !== 1)
    throw new Error('日期不明确或包含多个日期，请手工确认')
  const d = dates[0]
  let date: Temporal.PlainDate
  if (d[1])
    date = Temporal.PlainDate.from(
      { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) },
      { overflow: 'reject' }
    )
  else if (['今天', '明天', '后天'].includes(d[0]))
    date = base.add({ days: ['今天', '明天', '后天'].indexOf(d[0]) })
  else {
    const weekday =
      '一二三四五六日'.indexOf(d[0].slice(-1).replace('天', '日')) + 1
    date = base.add({
      days: weekday - base.dayOfWeek + (d[0].startsWith('下周') ? 7 : 0)
    })
  }
  const remaining = text.slice(0, d.index) + text.slice(d.index! + d[0].length)
  if (
    /今天|明天|后天|今晚|明晚|周[一二三四五六日天]|星期|\d+[年月日号]|\b(?:am|pm)\b/i.test(
      remaining
    )
  )
    throw new Error('还有未确认的时间表达')
  const clocks = [
    ...remaining.matchAll(
      /(?<!\d)(?:(上午|下午|晚上|中午|凌晨|早上)\s*)?(\d{1,2})(?::(\d{2})|[点时](?:(\d{1,2})分?)?)(?!\d)/g
    )
  ]
  if (!clocks.length || clocks.length > 2)
    throw new Error('缺少明确钟点或包含多个时段')
  if (
    clocks.length === 2 &&
    !/^\s*[-—–~～至到]\s*$/.test(
      remaining.slice(clocks[0].index! + clocks[0][0].length, clocks[1].index)
    )
  )
    throw new Error('起止时间没有明确的区间关系')
  const times = clocks.map((c) => {
    let hour = Number(c[2])
    const minute = Number(c[3] ?? c[4] ?? 0)
    if (c[1] && ['下午', '晚上', '中午'].includes(c[1]) && hour < 12) hour += 12
    if (c[1] && ['凌晨', '上午', '早上'].includes(c[1]) && hour === 12) hour = 0
    return date
      .toPlainDateTime(
        Temporal.PlainTime.from({ hour, minute }, { overflow: 'reject' })
      )
      .toZonedDateTime(source.timezone, { disambiguation: 'reject' })
      .epochMilliseconds
  })
  const actual = [task.start, task.end, task.due]
    .filter((v): v is string => v !== null)
    .map((v) => memoTimestamp(v)!)
  const expected = task.start
    ? task.due
      ? []
      : times
    : task.due && times.length === 1
      ? times
      : []
  if (
    !actual.length ||
    actual.length !== expected.length ||
    actual.some((v, i) => v !== expected[i])
  )
    throw new Error('模型时间与原文日期、钟点不一致，请手工确认')
  // All clock expressions must be fully covered (e.g. reject “九点半”, “9点半”, seconds, or bare range endpoints).
  const tail = clocks.reduceRight(
    (s, c) => s.slice(0, c.index) + s.slice(c.index! + c[0].length),
    remaining
  )
  if (
    /\d|半|刻|秒|上午|下午|晚上|中午|凌晨|早上/.test(
      tail.replace(/\$[^$]*\$/g, '')
    )
  )
    throw new Error('时间表达尚未完全核对，请手工确认')
}
