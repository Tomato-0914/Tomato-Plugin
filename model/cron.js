/**
 * cron 表达式转换。
 *
 * 锅巴的 Cron 选择器（EasyCron）是 Quartz 风格：周日=1、周一=2 … 周六=7，「日」和「周」只能设置其中一个，另一个写 ?。
 * 我们给它开了 hideSecond（不要秒，也就没有年），生成的是 5 段：分 时 日 月 周，如 0 4 ? * 4（每周三凌晨 4 点）。
 * 不开 hideSecond 时选择器是 7 段（秒 分 时 日 月 周 年），但它打开前的校验会把表达式错位一格，
 * 0 点、按周、按日期这些常用值全都报「Cron表达式不正确」打不开；5 段时校验是对齐的，都能正常打开。
 *
 * Yunzai 自带的 node-schedule 是 Linux 风格：周日=0、周一=1 … 周六=6，不认 ?，也没有年。
 * 下面把两种写法互相转换：
 *   - normalizeCron：配置 → node-schedule 能用的 6 段（秒 分 时 日 月 周）+ 年份段（有的话触发时自己判断）
 *   - pickerCron：配置 → 锅巴选择器能正确显示的 5 段
 * 带 ? 或者 7 段的当作 Quartz 风格；5/6 段且不带 ? 的当作 Linux 风格（手写配置文件的老写法照样能用）。
 */

/** 周字段的数字整体偏移：Quartz → Linux 用 -1，Linux → Quartz 用 +1；英文缩写（MON 等）两边一样，不动 */
function shiftWeek (field, delta) {
  const fix = n => {
    const v = Number(n) + delta
    return String(delta > 0 ? (v - 1) % 7 + 1 : v) // Linux 的 7 也是周日，转过去是 1
  }
  return field.split(',').map(part => {
    const [range, step] = part.split('/')
    // 只改开头的数字部分：4、2-6、6#3（第 3 个周五）、6L（最后一个周五）
    const shifted = range.replace(/^(\d+)(?:-(\d+))?/, (_, a, b) => b ? `${fix(a)}-${fix(b)}` : fix(a))
    return step === undefined ? shifted : `${shifted}/${step}`
  }).join(',')
}

/** 拆成统一的 { sec, min, hour, day, month, week, year, quartz }；空表达式返回 null */
function parse (expr) {
  const parts = String(expr ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const quartz = parts.length === 7 || parts.includes('?')
  const [sec, min, hour, day, month, week, year = '*'] = parts.length === 5 ? ['0', ...parts] : parts
  return { sec, min, hour, day, month, week: week ?? '*', year, quartz }
}

/** 年份段是否匹配：支持 *、2026、2026,2027、2026-2030、2026/2、2026-2030/2 */
export function yearMatches (field, year) {
  if (!field || field === '*' || field === '?') return true
  return field.split(',').some(part => {
    const [range, step] = part.split('/')
    const [from, to] = range === '*' ? [0, Infinity] : range.split('-').map(Number)
    const end = to ?? (step ? Infinity : from)
    if (!(year >= from && year <= end)) return false
    return !step || (year - (from || 0)) % Number(step) === 0
  })
}

/** 返回 { cron, year }：cron 是给 node-schedule 用的 6 段表达式，year 是年份段（没有则为 '*'） */
export function normalizeCron (expr) {
  const c = parse(expr)
  if (!c) return null
  const q = s => s === '?' ? '*' : s
  const week = c.quartz ? (c.week === '?' ? '*' : shiftWeek(c.week, -1)) : c.week
  return { cron: [c.sec, c.min, c.hour, q(c.day), c.month, week].join(' '), year: c.year }
}

/** 转成锅巴选择器（hideSecond）用的 5 段：分 时 日 月 周；日和周只保留一个，另一个写 ? */
export function pickerCron (expr) {
  const c = parse(expr)
  if (!c) return ''
  let week = c.quartz ? c.week : shiftWeek(c.week, 1)
  let day = c.day
  if (week !== '?' && week !== '*') day = '?'
  else week = '?'
  if (day === '?' && week === '?') day = '*'
  return [c.min, c.hour, day, c.month, week].join(' ')
}
