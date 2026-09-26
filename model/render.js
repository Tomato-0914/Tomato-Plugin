import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getConfig, pluginRoot, pluginName } from './config.js'
import { sanitizeHtml } from './sanitize.js'
import { extractWeapon, materialDays } from './weapon.js'
import { buildCard } from './card.js'

const TPL = path.join(pluginRoot, 'resources', 'html', 'entry.html')
const WTPL = path.join(pluginRoot, 'resources', 'html', 'weapon.html')
const CTPL = path.join(pluginRoot, 'resources', 'html', 'card.html')

let renderer = null
async function getRenderer () {
  // Yunzai 自带的渲染器（TRSS / Miao 都有这个兼容入口），不另起浏览器
  if (!renderer) renderer = (await import('../../../lib/puppeteer/puppeteer.js')).default
  return renderer
}

// 同一时间只渲染一张，4G 内存的机器别让 Chromium 开太多页
let queue = Promise.resolve()
function enqueue (fn) {
  const job = queue.then(fn, fn)
  queue = job.catch(() => {})
  return job
}

const inflight = new Map()

const STAR_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }
const ELEMENTS = { 火: '#EF7938', 水: '#4CC2F1', 风: '#72E2C2', 雷: '#D376F0', 草: '#A5C83B', 冰: '#9FD6E3', 岩: '#F0B232' }

/** 从目录标签里挑出星级、元素，其余做成小标签 */
export function headerTags (tags = []) {
  let stars = 0
  let accent = ''
  const chips = []
  for (const { k, v } of Array.isArray(tags) ? tags : []) {
    const star = v.match(/^([一二三四五1-5])\s*星$/)
    if (star && !stars) {
      stars = STAR_WORDS[star[1]] || Number(star[1])
      continue
    }
    const el = v.replace(/元素$/, '')
    if (!accent && ELEMENTS[el] && (k.includes('元素') || v.length <= 3)) {
      accent = ELEMENTS[el]
      chips.push({ text: v, accent: true })
      continue
    }
    if (chips.length < 5) chips.push({ text: v, accent: false })
  }
  return { stars, starText: '★'.repeat(stars), accent, chips }
}

/** 取出要渲染的分段 */
export function pickSections (content, r = {}) {
  let secs = (Array.isArray(content?.contents) ? content.contents : [])
    .filter(s => typeof s?.text === 'string' && s.text.trim())
    .map(s => ({ name: String(s.name ?? '').trim(), text: s.text }))
  if (!secs.length && typeof content?.content === 'string' && content.content.trim()) {
    secs = [{ name: '', text: content.content }]
  }
  const exclude = (r.excludeSections || []).filter(Boolean)
  return secs
    .filter(s => !exclude.some(k => s.name.includes(k)))
    .slice(0, r.maxSections || 12)
    .map(s => ({ name: /^页签\d*$/.test(s.name) ? '' : s.name, html: sanitizeHtml(s.text) }))
}

/** 渲染器可能返回 Buffer、Buffer 数组、segment 或 base64，统一成 Buffer 数组 */
function toBuffers (ret) {
  const out = []
  for (let x of Array.isArray(ret) ? ret : [ret]) {
    if (!x) continue
    if (typeof x === 'object' && !Buffer.isBuffer(x) && !(x instanceof Uint8Array) && 'file' in x) x = x.file
    if (Buffer.isBuffer(x)) out.push(x)
    else if (x instanceof Uint8Array) out.push(Buffer.from(x))
    else if (typeof x === 'string') {
      if (x.startsWith('base64://')) {
        out.push(Buffer.from(x.slice(9), 'base64'))
      } else if (/^file:/i.test(x)) {
        let file = x
        try { file = fileURLToPath(x) } catch { file = x.replace(/^file:\/\//, '') }
        if (fs.existsSync(file)) out.push(fs.readFileSync(file))
      } else {
        if (fs.existsSync(x)) out.push(fs.readFileSync(x))
      }
    }
  }
  return out
}

const WEAPON_DIRS = { 单手剑: 'sword', 双手剑: 'claymore', 长柄武器: 'polearm', 弓: 'bow', 法器: 'catalyst' }

/** 武器立绘：优先用喵喵插件的本地图（透明底），没有再用观测枢的图标兜底 */
export function weaponArt (weapon, dir) {
  const type = WEAPON_DIRS[weapon.type]
  if (dir && type && weapon.name) {
    const file = path.resolve(process.cwd(), dir, type, weapon.name, 'gacha.webp')
    if (fs.existsSync(file)) return { image: pathToFileURL(file).href, local: true, artType: type }
  }
  return { image: weapon.image || '', local: false, artType: type || '' }
}

/** 渲染精度：配置 renderScale（50~300）换算成缩放倍数 */
export function renderScale () {
  const n = Number(getConfig().renderScale)
  return Math.min(300, Math.max(50, Number.isFinite(n) && n > 0 ? n : 100)) / 100
}

async function doRender (gameKey, entry, view, r, tplFile = TPL) {
  const rd = await getRenderer()
  const scale = renderScale()
  const pageCfg = JSON.stringify({
    remove: r.removeSelectors || [],
    imgProcess: String(r.imageProcess || '').replace(/w_(\d+)/, (_, w) => `w_${Math.round(w * Math.max(1, scale))}`),
    imgHosts: r.imageHosts || []
  }).replace(/</g, '\\u003c')

  // 注意：别用 path / resPath 这类字段名，Yunzai 渲染器会拿去当保存路径
  const data = {
    tplFile,
    saveId: `${gameKey}_${entry.id}`,
    imgType: 'jpeg',
    quality: r.quality || 90,
    multiPage: tplFile === TPL,
    multiPageHeight: Math.round((r.pageHeight || 3500) * scale),
    pageGotoParams: { waitUntil: 'networkidle0', timeout: r.timeout || 60000 },
    width: r.width || 760,
    ...view,
    bodyStyle: scale === 1 ? '' : `transform:scale(${scale});transform-origin:0 0`,
    pageCfg
  }

  const started = Date.now()
  let ret
  if (typeof rd.render === 'function') ret = await rd.render(pluginName, data)
  else if (typeof rd.screenshots === 'function') ret = await rd.screenshots(pluginName, data)
  else ret = await rd.screenshot(pluginName, { ...data, multiPage: false })
  const bufs = toBuffers(ret)
  logger.mark(`[${pluginName}] 渲染 ${entry.title} ${bufs.length} 张，用时 ${Date.now() - started}ms`)
  return bufs
}

/** 渲染一个条目，返回图片 Buffer 数组；不缓存图片，每次都重新生成 */
export async function renderEntry (gameKey, entry, content, { onStart, dish, iconOf } = {}) {
  const cfg = getConfig()
  const r = cfg.render || {}
  const weapon = entry.path.includes('武器') ? extractWeapon(content) : null
  const card = weapon ? null : buildCard(entry, content, { dish, iconOf })

  let view
  let tplFile = TPL
  if (weapon) {
    tplFile = WTPL
    const wc = cfg.weapon || {}
    const chars = weapon.characters || []
    view = {
      ...weapon,
      ...weaponArt(weapon, wc.artDir),
      characters: chars.slice(0, 6),
      width: wc.width || 1280,
      height: wc.height || 800,
      stars: Array.from({ length: Math.min(weapon.rate || 0, 5) }, (_, i) => i),
      days: materialDays(weapon.materials, wc.domainDays),
      obtainWide: String(weapon.obtain || '').length > 6,
      blanks: Array.from({ length: Math.max(0, 6 - chars.length) }, (_, i) => i),
      time: '',
      entryId: entry.id
    }
  } else if (card) {
    tplFile = CTPL
    const cc = cfg.card || {}
    view = {
      ...card,
      stars: Array.from({ length: Math.min(card.stars || 0, 5) }, (_, i) => i),
      summary: card.summary || '',
      art: card.art || null,
      bottom: card.bottom || '',
      width: cc.width || 1280,
      height: card.mainHeight ? 0 : cc.height || 800,
      mainHeight: card.mainHeight || 0,
      time: '',
      entryId: entry.id
    }
  } else {
    const sections = pickSections(content, r)
    if (!sections.length) throw new Error('这个条目没有可显示的正文')
    const icon = [entry.icon, content.icon].find(u => typeof u === 'string' && /^https?:\/\//.test(u)) || ''
    view = {
      title: content.title || entry.title,
      summary: typeof content.summary === 'string' ? content.summary.trim() : '',
      crumb: entry.path.filter(p => p !== '图鉴').join(' / '),
      icon,
      ...headerTags(entry.tags),
      sections,
      entryId: entry.id
    }
  }

  view.time = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

  const key = `${gameKey}:${entry.id}:${dish || ''}`
  if (inflight.has(key)) return inflight.get(key)

  const job = (async () => {
    onStart?.()
    const bufs = await enqueue(() => doRender(gameKey, entry, view, r, tplFile))
    if (!bufs.length) throw new Error('渲染器没有返回图片，看一下后台日志')
    return bufs
  })().finally(() => inflight.delete(key))

  inflight.set(key, job)
  return job
}
