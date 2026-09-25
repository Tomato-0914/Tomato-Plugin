import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getConfig, pluginRoot, pluginName, dataRoot, ensureDir } from './config.js'
import { sanitizeHtml } from './sanitize.js'
import { extractWeapon } from './weapon.js'

const TPL = path.join(pluginRoot, 'resources', 'html', 'entry.html')
const WTPL = path.join(pluginRoot, 'resources', 'html', 'weapon.html')
const md5 = s => crypto.createHash('md5').update(s).digest('hex')

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

function readRendered (dir, hash) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(`${hash}_`) && f.endsWith('.jpg'))
    .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]))
    .map(f => fs.readFileSync(path.join(dir, f)))
}

function saveRendered (dir, hash, bufs) {
  fs.rmSync(dir, { recursive: true, force: true })
  ensureDir(dir)
  bufs.forEach((buf, i) => fs.writeFileSync(path.join(dir, `${hash}_${i}.jpg`), buf))
}

export function clearRendered (gameKey) {
  fs.rmSync(path.join(dataRoot, gameKey, 'render'), { recursive: true, force: true })
}

async function doRender (gameKey, entry, view, r, tplFile = TPL) {
  const rd = await getRenderer()
  const pageCfg = JSON.stringify({
    remove: r.removeSelectors || [],
    imgProcess: r.imageProcess || '',
    imgHosts: r.imageHosts || []
  }).replace(/</g, '\\u003c')

  // 注意：别用 path / resPath 这类字段名，Yunzai 渲染器会拿去当保存路径
  const data = {
    tplFile,
    saveId: `${gameKey}_${entry.id}`,
    imgType: 'jpeg',
    quality: r.quality || 90,
    multiPage: tplFile === TPL,
    multiPageHeight: r.pageHeight || 3500,
    pageGotoParams: { waitUntil: 'networkidle0', timeout: r.timeout || 60000 },
    width: r.width || 760,
    ...view,
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

/**
 * 渲染一个条目，返回图片 Buffer 数组。
 * 缓存键 = 正文内容 + 模板 + 渲染配置 的哈希，观测枢一更新就自动重渲染。
 */
export async function renderEntry (gameKey, entry, content, { force = false, onMiss } = {}) {
  const r = getConfig().render || {}
  const weapon = entry.path.includes('武器') ? extractWeapon(content) : null

  let view
  let tplFile = TPL
  if (weapon) {
    tplFile = WTPL
    view = {
      ...weapon,
      starText: '★'.repeat(weapon.rate || 0),
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

  const tpl = fs.readFileSync(tplFile, 'utf8')
  const hash = md5(JSON.stringify([tpl, r, view])).slice(0, 12)
  view.time = new Date().toLocaleString('zh-CN', { hour12: false })
  const dir = path.join(dataRoot, gameKey, 'render', entry.id)

  if (!force) {
    const cached = readRendered(dir, hash)
    if (cached.length) return cached
  }

  const key = `${gameKey}:${entry.id}:${hash}`
  if (inflight.has(key)) return inflight.get(key)

  const job = (async () => {
    onMiss?.()
    const bufs = await enqueue(() => doRender(gameKey, entry, view, r, tplFile))
    if (!bufs.length) throw new Error('渲染器没有返回图片，看一下后台日志')
    saveRendered(dir, hash, bufs)
    return bufs
  })().finally(() => inflight.delete(key))

  inflight.set(key, job)
  return job
}
