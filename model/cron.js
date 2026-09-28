/**
 * cron 表达式转换：锅巴的 Cron 选择器（EasyCron）生成的是 Quartz 风格的 7 段表达式
 *   秒 分 时 日 月 周 年，如 0 0 4 ? * 4 *（每周三凌晨 4 点）
 * 而 Yunzai 自带的 node-schedule 只认 Linux 风格的 5/6 段，且有几处写法不一样：
 *   - 没有「年」这一段
 *   - 不认「?」（Quartz 里表示“日”和“周”二选一时不指定的那个），换成 *
 *   - 周的编号不同：Quartz 周日=1、周一=2 … 周六=7；node-schedule 周日=0、周一=1 … 周六=6
 * 这里统一转成 node-schedule 能用的 6 段；年份单独拿出来，触发时自己判断。
 * 5/6 段且不带 ? 的当作 Linux 风格原样使用，所以手写配置文件的老写法照样能用。
 */

/** Quartz 的周编号（1~7，周日=1）换成 node-schedule 的（0~6，周日=0）；英文缩写（MON 等）两边一样，不动 */
function quartzWeek (field) {
  return field.split(',').map(part => {
    const [range, step] = part.split('/')
    // 只改开头的数字部分：4、2-6、6#3（第 3 个周五）、6L（最后一个周五）
    const shifted = range.replace(/^(\d+)(?:-(\d+))?/, (_, a, b) => b ? `${a - 1}-${b - 1}` : `${a - 1}`)
    return step === undefined ? shifted : `${shifted}/${step}`
  }).join(',')
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

/**
 * 给锅巴 Cron 选择器用的写法。选择器打开前会用 cron-parser 的 parseString 校验，而 parseString 是按 crontab 文件解析的：
 * 它会在前面补一个「0 」当秒，于是 7 段表达式整体错位一格，「日」落到了「月」的位置——日写 ? 就报「Cron表达式不正确」，
 * 连选择器自己生成的按周执行（0 0 4 ? * 4 *）都打不开。
 * 这里在指定了周的情况下把日的 ? 换成 *：两种写法意思一样（都是只按周执行），插件转换结果也一样，但能通过选择器的校验。
 */
export function pickerCron (expr) {
  const text = String(expr ?? '').trim()
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length !== 7) return text
  if (parts[3] === '?' && parts[5] !== '?' && parts[5] !== '*') parts[3] = '*'
  return parts.join(' ')
}

/** 返回 { cron, year }：cron 是给 node-schedule 用的表达式，year 是年份段（没有则为 '*'） */
export function normalizeCron (expr) {
  const parts = String(expr ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  const quartz = parts.length === 7 || parts.includes('?')
  if (!quartz) return { cron: parts.join(' '), year: '*' }
  const [sec, min, hour, day, month, week, year = '*'] = parts
  const q = s => s === '?' ? '*' : s
  return { cron: [sec, min, hour, q(day), month, week === '?' ? '*' : quartzWeek(week)].join(' '), year }
}
