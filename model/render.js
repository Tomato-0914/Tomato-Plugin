import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getConfig, pluginRoot, pluginName } from './config.js'
import { sanitizeHtml } from './sanitize.js'
import { extractWeapon, materialDays } from './weapon.js'
import { extractCharacter } from './character.js'
import { buildCard } from './card.js'

const TPL = path.join(pluginRoot, 'resources', 'html', 'entry.html')
const WTPL = path.join(pluginRoot, 'resources', 'html', 'weapon.html')
const CTPL = path.join(pluginRoot, 'resources', 'html', 'card.html')
const ChTPL = path.join(pluginRoot, 'resources', 'html', 'character.html')
const HTPL = path.join(pluginRoot, 'resources', 'html', 'help.html')

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

/** 固定出图尺寸（像素），模板按这个尺寸排版，不开放配置 */
const SIZE = { weapon: [1280, 800], card: [1280, 800], entry: 760, character: 800 }

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

/** 圣遗物部件槽位 → 喵喵插件图片文件名（1~5 固定对应生之花/死之羽/时之沙/空之杯/理之冠） */
const ARTIFACT_SLOT_IDX = { 生之花: 1, 死之羽: 2, 时之沙: 3, 空之杯: 4, 理之冠: 5 }

const pieceIndexCache = new Map()
/** 喵喵插件的圣遗物数据（imgs 目录的上一级 data.json）：部件名 → { set, idx } */
function artifactPieceIndex (dir) {
  if (pieceIndexCache.has(dir)) return pieceIndexCache.get(dir)
  const map = new Map()
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), dir, '..', 'data.json'), 'utf8'))
    for (const set of Object.values(data || {})) {
      for (const [idx, piece] of Object.entries(set?.idxs || {})) {
        if (piece?.name && set?.name) map.set(piece.name, { set: set.name, idx })
      }
    }
  } catch {}
  pieceIndexCache.set(dir, map)
  return map
}

/**
 * 圣遗物部件立绘：优先用喵喵插件的本地图（透明底，imgs/<套装名>/1~5.webp），没有再用观测枢的图标兜底。
 * 依次按「部位名」「部件名（查喵喵的 data.json）」「部件顺序（花羽沙杯冠）」找，观测枢个别套装的部位名写法不标准时也能对上
 */
export function artifactPieceArt (setName, slot, dir, pieceName = '', order = -1) {
  if (!dir) return ''
  const fileOf = (set, idx) => {
    if (!set || !idx) return ''
    const file = path.resolve(process.cwd(), dir, set, `${idx}.webp`)
    return fs.existsSync(file) ? pathToFileURL(file).href : ''
  }
  const bySlot = Object.entries(ARTIFACT_SLOT_IDX).find(([k]) => String(slot || '').includes(k))?.[1]
  const byName = artifactPieceIndex(dir).get(pieceName)
  return fileOf(setName, bySlot) ||
    (byName ? fileOf(byName.set, byName.idx) : '') ||
    (order >= 0 && order < 5 ? fileOf(setName, order + 1) : '')
}

/**
 * 角色立绘：优先用观测枢自己的图（每个角色都有，覆盖最全），没有时才退回喵喵插件的本地图兜底。
 * 观测枢的图构图不固定（常是大幅场景插画），完整显示不裁剪；喵喵的本地图统一是竖长的半身/全身立绘，
 * 裁剪铺满展示框效果最好，所以标记 local 让模板按来源分别处理（观测枢完整显示，本地裁剪铺满）
 */
export function characterArt (name, image, dir) {
  if (image) return { image, local: false }
  if (dir && name) {
    const file = path.resolve(process.cwd(), dir, name, 'imgs', 'gacha.webp')
    if (fs.existsSync(file)) return { image: pathToFileURL(file).href, local: true }
  }
  return { image: '', local: false }
}

/** 命之座图标：优先用喵喵插件本地图（cons-1.webp ~ cons-6.webp），没有再用观测枢的图标兜底 */
export function characterConsArt (name, level, dir) {
  if (dir && name && level) {
    const file = path.resolve(process.cwd(), dir, name, 'icons', `cons-${level}.webp`)
    if (fs.existsSync(file)) return pathToFileURL(file).href
  }
  return ''
}

const materialIndexCache = new Map()

/** 扫一遍喵喵插件材料图标目录（boss/gem/monster/normal/specialty/talent/weapon/weekly 等子目录），建立 名称 → 本地文件路径 的索引；每个进程只扫一次 */
function materialIndex (dir) {
  if (materialIndexCache.has(dir)) return materialIndexCache.get(dir)
  const map = new Map()
  try {
    const root = path.resolve(process.cwd(), dir)
    for (const sub of fs.readdirSync(root, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue
      const subDir = path.join(root, sub.name)
      for (const file of fs.readdirSync(subDir)) {
        if (file.endsWith('.webp')) map.set(file.slice(0, -5), path.join(subDir, file))
      }
    }
  } catch {}
  materialIndexCache.set(dir, map)
  return map
}

/**
 * 材料 / 掉落物图标：优先用喵喵插件的本地透明图（武器突破材料、地区特产、怪物掉落等），没有再用观测枢自己的图标兜底。
 * 喵喵插件没有食物材料图，食物走这条路查不到，照常用观测枢的图。
 */
export function materialIcon (name, dir) {
  if (!dir || !name) return ''
  const file = materialIndex(dir).get(name)
  return file ? pathToFileURL(file).href : ''
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
    width: SIZE.entry,
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
  const character = !weapon && entry.path.includes('角色') ? extractCharacter(content) : null
  const pieceArt = (setName, slot, name, order) => artifactPieceArt(setName, slot, cfg.artifact?.artDir, name, order)
  const matIcon = name => materialIcon(name, cfg.material?.artDir)
  const card = (weapon || character) ? null : buildCard(entry, content, { dish, iconOf, pieceArt, matIcon })

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
      width: SIZE.weapon[0],
      height: SIZE.weapon[1],
      stars: Array.from({ length: Math.min(weapon.rate || 0, 5) }, (_, i) => i),
      materials: (weapon.materials || []).map(m => ({ ...m, img: matIcon(m.name) || m.img })),
      days: materialDays(weapon.materials, wc.domainDays),
      obtainWide: String(weapon.obtain || '').length > 6,
      blanks: Array.from({ length: Math.max(0, 6 - chars.length) }, (_, i) => i),
      time: '',
      entryId: entry.id
    }
  } else if (character) {
    tplFile = ChTPL
    const cc = cfg.character || {}
    const charMat = m => {
      const local = matIcon(m.name)
      return { ...m, img: local || m.img, local: !!local }
    }
    view = {
      ...character,
      element: character.element || (entry.tags || []).find(t => t.k === '元素')?.v || '',
      ...characterArt(character.name, character.image, cc.artDir),
      // 天赋材料和突破材料一样优先用喵喵的透明底图标；喵喵没有的（如智识之冕）才用观测枢的，
      // 观测枢的是自带品质底色和星级的卡片图，模板里不加内边距直接铺满方块（local=false），不然就成了框里套框
      materials: character.materials.map(charMat),
      talentMaterials: (character.talentMaterials || []).map(charMat),
      constellations: character.constellations.map(c => ({ ...c, icon: characterConsArt(character.name, c.level, cc.artDir) || c.icon })),
      stars: Array.from({ length: Math.min(character.star || 0, 5) }, (_, i) => i),
      width: SIZE.character,
      height: 0,
      time: '',
      entryId: entry.id
    }
    // 一张长图在手机上缩下来字太小，拆成几张窄图：概览 / 天赋 / 命之座+推荐装备，没内容的页不出
    view.pages = [
      'overview',
      view.talents.length && 'talents',
      (view.constellations.length || view.recommendWeapons.length || view.recommendArtifacts.length) && 'cons'
    ].filter(Boolean)
  } else if (card) {
    tplFile = CTPL
    view = {
      ...card,
      stars: Array.from({ length: Math.min(card.stars || 0, 5) }, (_, i) => i),
      summary: card.summary || '',
      art: card.art || null,
      bottom: card.bottom || '',
      width: SIZE.card[0],
      height: card.mainHeight ? 0 : SIZE.card[1],
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
    const bufs = []
    if (view.pages) {
      // 分页逐张排队渲染，不一次占住渲染器太久
      for (const [i, page] of view.pages.entries()) {
        const pv = { ...view, page, pageNo: i + 1, pageCount: view.pages.length }
        bufs.push(...await enqueue(() => doRender(gameKey, { ...entry, id: `${entry.id}_${page}`, title: `${entry.title}·${i + 1}` }, pv, r, tplFile)))
      }
    } else {
      bufs.push(...await enqueue(() => doRender(gameKey, entry, view, r, tplFile)))
    }
    if (!bufs.length) throw new Error('渲染器没有返回图片，看一下后台日志')
    return bufs
  })().finally(() => inflight.delete(key))

  inflight.set(key, job)
  return job
}

/** 渲染帮助页（网页排版，不是纯文字）；调用方自己接住失败情况，退回纯文字帮助 */
export async function renderHelp (gameKey, view) {
  const cfg = getConfig()
  const r = cfg.render || {}
  const data = {
    ...view,
    width: 1280,
    height: 0,
    time: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  }
  const bufs = await enqueue(() => doRender(gameKey, { id: 'help', title: '帮助' }, data, r, HTPL))
  if (!bufs.length) throw new Error('渲染器没有返回图片，看一下后台日志')
  return bufs
}
