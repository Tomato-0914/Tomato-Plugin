import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, mtime, readYaml } from './config.js'
import { versionsFile } from './versionSync.js'

export const norm = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/[\s#·・「」『』《》\u201c\u201d\u2018\u2019\-—_]/g, '')
  .toLowerCase()

const aliasCache = new Map()

/** 别名表：resources/alias/<game>.yaml（自带）+ config/alias/<game>.yaml（你自己加的）；以 # 开头的是弱别名 */
export function getAliases (game) {
  return loadAliases(game).map
}

/** 弱别名的规范化键：只在消息带 # 或「图鉴」时生效 */
export function getWeakAliases (game) {
  return loadAliases(game).weak
}

function loadAliases (game) {
  const files = [
    path.join(pluginRoot, 'resources', 'alias', `${game}.yaml`),
    path.join(pluginRoot, 'config', 'alias', `${game}.yaml`)
  ]
  const sig = files.map(mtime).join('|')
  const hit = aliasCache.get(game)
  if (hit?.sig === sig) return hit

  const map = new Map()
  const weak = new Set()
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    for (const [title, list] of Object.entries(readYaml(file))) {
      for (const alias of [].concat(list ?? [])) {
        if (alias === null || alias === '') continue
        const k = norm(alias)
        map.set(k, String(title))
        if (String(alias).startsWith('#')) weak.add(k)
        else weak.delete(k)
      }
    }
  }
  const res = { sig, map, weak }
  aliasCache.set(game, res)
  return res
}

const versionCache = new Map()

/**
 * 版本表，返回 { 分类: Map(规范化名称 → 版本号) }，按优先级从低到高：
 * resources/version/<game>.yaml（插件自带） → data/<插件名>/<game>/versions.json（后台自动从 genshin-db 同步的） → config/version/<game>.yaml（你自己加的）
 */
export function getVersions (game) {
  const files = [
    path.join(pluginRoot, 'resources', 'version', `${game}.yaml`),
    versionsFile(game),
    path.join(pluginRoot, 'config', 'version', `${game}.yaml`)
  ]
  const sig = files.map(mtime).join('|')
  const hit = versionCache.get(game)
  if (hit?.sig === sig) return hit.data

  const data = {}
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    for (const [cat, list] of Object.entries(readYaml(file))) {
      const map = data[cat] || (data[cat] = new Map())
      for (const [name, ver] of Object.entries(list || {})) if (ver != null && ver !== '') map.set(norm(name), String(ver))
    }
  }
  versionCache.set(game, { sig, data })
  return data
}

/** 条目上线版本：按条目所属分类查版本表，查不到返回空字符串 */
export function versionOf (entry, versions) {
  const t = norm(entry.title)
  for (const [cat, map] of Object.entries(versions || {})) {
    if (entry.path.includes(cat) && map.has(t)) return map.get(t)
  }
  return ''
}

/** 版本号比较：新版本在前，没有版本的排最前（多半是版本表还没收录的新条目） */
export function compareVersion (a, b) {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0)
  const [x1, y1] = a.split('.').map(Number)
  const [x2, y2] = b.split('.').map(Number)
  return x2 - x1 || (y2 || 0) - (y1 || 0)
}

function similarity (a, b) {
  if (!a || !b) return 0
  const pool = [...b]
  let hit = 0
  for (const ch of a) {
    const i = pool.indexOf(ch)
    if (i >= 0) {
      hit++
      pool.splice(i, 1)
    }
  }
  return hit / Math.max(a.length, b.length)
}

function uniqueByTitle (list) {
  const seen = new Set()
  return list.filter(e => !seen.has(e.title) && seen.add(e.title))
}

/**
 * 返回：
 *   { type: 'hit', entry, via: 'alias' | 'exact' | 'partial' }
 *   { type: 'multi', list }
 *   { type: 'none', suggest }
 */
export function matchEntry (query, index, { aliases = new Map(), priority = [] } = {}) {
  const q = norm(query)
  if (!q) return { type: 'none', suggest: [] }

  const rank = e => {
    const i = priority.findIndex(p => e.path.includes(p))
    return i < 0 ? priority.length : i
  }
  const byRank = (a, b) => rank(a) - rank(b) || a.title.length - b.title.length

  const target = aliases.get(q)
  if (target) {
    const t = norm(target)
    const hits = index.filter(e => norm(e.title) === t)
    if (hits.length) return { type: 'hit', entry: hits.sort(byRank)[0], via: 'alias' }
  }

  const exact = index.filter(e => norm(e.title) === q)
  if (exact.length) return { type: 'hit', entry: exact.sort(byRank)[0], via: 'exact' }

  // 模糊匹配：命中多个时按分类优先级（角色>武器>圣遗物…）排，再按标题长度
  const partialAll = index.filter(e => norm(e.title).includes(q))
  const partial = uniqueByTitle(partialAll.sort(byRank))
  if (partial.length === 1) return { type: 'hit', entry: partial[0], via: 'partial' }
  if (partial.length > 1) return { type: 'multi', list: partial.slice(0, 12) }

  const suggest = index
    .map(e => ({ e, s: similarity(q, norm(e.title)) }))
    .filter(x => x.s >= 0.5)
    .sort((a, b) => b.s - a.s || byRank(a.e, b.e))
    .map(x => x.e)
  return { type: 'none', suggest: uniqueByTitle(suggest).slice(0, 5) }
}

const STAR_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }

/** 条目星级：取目录标签里最高的「X星」（圣遗物同时有四星、五星），没有返回 0 */
export function starOf (entry) {
  let star = 0
  for (const { v } of entry.tags || []) {
    const m = String(v).match(/^([一二三四五1-5])\s*星$/)
    if (m) star = Math.max(star, STAR_WORDS[m[1]] || Number(m[1]))
  }
  return star
}

/** 条目排序：星级从高到低，同星级按上线版本从新到旧；每项为 { entry, star, ver } */
function sortEntries (list, versions) {
  return uniqueByTitle(list)
    .map(entry => ({ entry, star: starOf(entry), ver: versionOf(entry, versions) }))
    .sort((a, b) => b.star - a.star || compareVersion(a.ver, b.ver))
}

/** 查询词正好是某个分类名（如“武器”）时，返回该分类下排好序的条目 */
export function listCategory (query, index, versions = {}) {
  const q = norm(query)
  const list = index.filter(e => e.path.some(p => norm(p) === q))
  return list.length ? sortEntries(list, versions) : null
}

/** 背包条目的道具类型（目录标签「道具类型/xx」），没有返回空字符串 */
export function itemType (entry) {
  return (entry.tags || []).find(t => t.k === '道具类型')?.v || ''
}

/** 游戏背包页签 → 观测枢道具类型；“xx地区特产”都归材料，没列到的新类型单独成组 */
export const BAG_TABS = {
  养成道具: ['角色培养素材', '角色与武器培养素材', '角色天赋素材', '角色突破素材', '角色经验素材', '武器突破素材', '武器强化材料', '武器精炼材料', '圣遗物强化素材'],
  材料: ['素材', '食材', '鱼饵', '锻造用矿石', '武器制作素材', '炼金素材', '道具锻造素材', '家园摆设制作素材'],
  贵重道具: ['贵重道具', '消耗品'],
  任务: ['任务道具'],
  小道具: ['小道具']
}

/** 背包条目所属的游戏页签；没有道具类型返回空字符串 */
export function itemTab (entry) {
  const type = itemType(entry)
  if (!type) return ''
  const tab = Object.keys(BAG_TABS).find(k => BAG_TABS[k].includes(type))
  return tab || (type.endsWith('地区特产') ? '材料' : type)
}

/** 查询词是背包页签（如“养成道具”“任务”）或观测枢道具类型（如“角色天赋素材”，可只写开头，需唯一）时，返回 { type, list }；否则 null */
export function listItemType (query, index, versions = {}) {
  const q = norm(query)
  if (!q) return null
  const pick = (names, of) => {
    const starts = names.filter(t => norm(t).startsWith(q))
    const name = names.find(t => norm(t) === q) || (starts.length === 1 ? starts[0] : '')
    return name ? { type: name, list: sortEntries(index.filter(e => of(e) === name), versions) } : null
  }
  return pick([...new Set(index.map(itemTab).filter(Boolean))], itemTab) ||
    pick([...new Set(index.map(itemType).filter(Boolean))], itemType)
}
