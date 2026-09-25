import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, mtime, readYaml } from './config.js'

export const norm = s => String(s ?? '')
  .normalize('NFKC')
  .replace(/[\s#·・「」『』《》\u201c\u201d\u2018\u2019\-—_]/g, '')
  .toLowerCase()

const aliasCache = new Map()

/** 别名表：resources/alias/<game>.yaml（自带）+ config/alias/<game>.yaml（你自己加的） */
export function getAliases (game) {
  const files = [
    path.join(pluginRoot, 'resources', 'alias', `${game}.yaml`),
    path.join(pluginRoot, 'config', 'alias', `${game}.yaml`)
  ]
  const sig = files.map(mtime).join('|')
  const hit = aliasCache.get(game)
  if (hit?.sig === sig) return hit.map

  const map = new Map()
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    for (const [title, list] of Object.entries(readYaml(file))) {
      for (const alias of [].concat(list ?? [])) {
        if (alias !== null && alias !== '') map.set(norm(alias), String(title))
      }
    }
  }
  aliasCache.set(game, { sig, map })
  return map
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

/** 查询词正好是某个分类名（如“武器”）时，返回该分类下的全部标题 */
export function listCategory (query, index) {
  const q = norm(query)
  const titles = index.filter(e => e.path.some(p => norm(p) === q)).map(e => e.title)
  return titles.length ? [...new Set(titles)] : null
}
