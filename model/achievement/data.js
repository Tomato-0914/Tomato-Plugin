import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, ensureDir, pluginName } from '../config.js'

/**
 * 成就数据：整理自 genshin-db（https://github.com/theBowja/genshin-db ，MIT License，Copyright (c) 2020 theBowja）。
 *
 * 为什么不用观测枢：观测枢的「成就」分类在 excludeCategories 里默认整个不收录（图鉴查询、目录、缓存都不碰它），
 * 而且观测枢的成就条目没有游戏内的成就 id，椰羊、胡桃工具箱等导出的 UIAF 文件都是按 id 记录的，对不上。
 * genshin-db 的成就带游戏内 id、所属特辑、原石奖励、是否隐藏、上线版本，和椰羊导出的表格逐条对得上。
 * 所以成就功能和图鉴的观测枢目录完全分开：excludeCategories 里的「成就」只影响图鉴，不影响这里。
 *
 * genshin-db 每个成就一个文件（1600 多个），第一次同步要逐个下载，之后只下载新增的和版本号变了的，结果存在
 * data/<插件名>/gs/achievement/data.json，运行时生成、不进 git。
 */

const MIRRORS = [
  p => `https://raw.githubusercontent.com/theBowja/genshin-db/main/src/data/${p}`,
  p => `https://cdn.jsdelivr.net/gh/theBowja/genshin-db@main/src/data/${p}`
]
const LANG = 'ChineseSimplified'
const CONCURRENCY = 8

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fetchJson (relPath) {
  let lastErr
  for (const mirror of MIRRORS) {
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(mirror(relPath), { signal: AbortSignal.timeout(15000) })
        if (res.status === 404) throw Object.assign(new Error('HTTP 404'), { notFound: true })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
      } catch (err) {
        lastErr = err
        if (err.notFound) break
        if (i === 0) await sleep(500)
      }
    }
  }
  throw lastErr
}

/** 并发跑 tasks（返回 Promise 的函数），返回 [{ ok, value | error }] */
async function pool (tasks, n = CONCURRENCY) {
  const out = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      try {
        out[i] = { ok: true, value: await tasks[i]() }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return out
}

export const achievementDir = game => path.join(dataRoot, game, 'achievement')
const dataFile = game => path.join(achievementDir(game), 'data.json')

const cache = new Map()

function readRaw (game) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(game), 'utf8'))
  } catch {
    return null
  }
}

/** genshin-db 的一个成就文件（可能有多个阶段，每个阶段一个游戏内 id）摊平成每个 id 一条 */
function flattenItem (key, item, ver) {
  const out = []
  const ids = [].concat(item?.id ?? [])
  const stages = Number(item?.stages) || ids.length || 1
  for (let s = 1; s <= stages; s++) {
    const st = item[`stage${s}`]
    const id = Number(ids[s - 1])
    if (!st || !Number.isFinite(id)) continue
    out.push({
      id,
      key,
      title: String(st.title || item.name || '').trim(),
      desc: String(st.description || '').trim(),
      primo: Number(st.reward?.count) || 0,
      stage: s,
      stages,
      hidden: !!item.isHidden,
      groupId: Number(item.achievementGroupId) || 0,
      group: String(item.achievementGroupName || ''),
      order: Number(item.sortOrder) || 0,
      version: ver ? String(ver) : ''
    })
  }
  return out
}

/** 把磁盘上的原始数据整理成查询用的结构 */
function build (raw) {
  const groups = Object.values(raw?.groups || {})
    .map(g => ({ id: Number(g.id) || 0, name: String(g.name || ''), order: Number(g.sortOrder) || 0, reward: g.reward?.name || '', version: g.version || '' }))
    .filter(g => g.name)
  const list = []
  for (const [key, { ver, data }] of Object.entries(raw?.items || {})) list.push(...flattenItem(key, data, ver))

  // 特辑顺序按游戏里的排序；genshin-db 没收录的特辑（理论上不会出现）放最后
  const gOrder = new Map(groups.map(g => [g.id, g.order]))
  for (const a of list) {
    if (!gOrder.has(a.groupId)) {
      gOrder.set(a.groupId, 9999 + a.groupId)
      groups.push({ id: a.groupId, name: a.group, order: 9999 + a.groupId, reward: '', version: '' })
    }
  }
  groups.sort((a, b) => a.order - b.order)
  list.sort((a, b) => gOrder.get(a.groupId) - gOrder.get(b.groupId) || a.order - b.order || a.stage - b.stage || a.id - b.id)

  const groupStats = new Map(groups.map(g => [g.id, { total: 0, primo: 0 }]))
  for (const a of list) {
    const s = groupStats.get(a.groupId)
    s.total++
    s.primo += a.primo
  }
  for (const g of groups) Object.assign(g, groupStats.get(g.id))

  return {
    syncedAt: raw?.syncedAt || 0,
    groups: groups.filter(g => g.total),
    list,
    byId: new Map(list.map(a => [a.id, a]))
  }
}

/** 成就数据（没同步过返回 null）；文件有变化自动重新读 */
export function getAchievements (game) {
  let mt = 0
  try {
    mt = fs.statSync(dataFile(game)).mtimeMs
  } catch {
    cache.delete(game)
    return null
  }
  const hit = cache.get(game)
  if (hit?.mt === mt) return hit.data
  const raw = readRaw(game)
  const data = raw ? build(raw) : null
  cache.set(game, { mt, data })
  return data?.list.length ? data : null
}

const jobs = new Map()

/**
 * 从 genshin-db 同步成就数据。只下载新增的、版本号变了的、上次下载失败的成就；force 时全部重新下载。
 * 返回 { total, added, updated, removed, failed }；同一时间只跑一个同步任务，重复调用拿到同一个结果。
 */
export function syncAchievements (game, { force = false } = {}) {
  if (jobs.has(game)) return jobs.get(game)
  const job = doSync(game, force).finally(() => jobs.delete(game))
  jobs.set(game, job)
  return job
}

export const syncing = game => jobs.has(game)

async function doSync (game, force) {
  const [achIdx, achVer, grpIdx, grpVer] = await Promise.all([
    fetchJson(`index/${LANG}/achievements.json`),
    fetchJson('version/achievements.json').catch(() => ({})),
    fetchJson(`index/${LANG}/achievementgroups.json`),
    fetchJson('version/achievementgroups.json').catch(() => ({}))
  ])
  const keys = Object.keys(achIdx?.namemap || {})
  const gKeys = Object.keys(grpIdx?.namemap || {})
  if (!keys.length || !gKeys.length) throw new Error('genshin-db 成就目录为空，数据结构可能变了')

  const prev = (!force && readRaw(game)) || { groups: {}, items: {} }
  const items = {}
  const todo = []
  for (const key of keys) {
    const ver = achVer?.[key] ? String(achVer[key]) : ''
    const old = prev.items?.[key]
    if (old?.data && old.ver === ver) items[key] = old
    else todo.push({ key, ver, isNew: !old })
  }
  const groups = {}
  const gTodo = []
  for (const key of gKeys) {
    const old = prev.groups?.[key]
    const ver = grpVer?.[key] ? String(grpVer[key]) : ''
    if (old && old.version === ver) groups[key] = old
    else gTodo.push({ key, ver })
  }

  if (todo.length > 50) logger.mark(`[${pluginName}] 开始同步成就数据，需要下载 ${todo.length} 条，首次同步要一两分钟`)

  const gRes = await pool(gTodo.map(t => () => fetchJson(`${LANG}/achievementgroups/${t.key}.json`)))
  gRes.forEach((r, i) => {
    const { key, ver } = gTodo[i]
    if (r.ok) groups[key] = { ...r.value, version: ver }
    else if (prev.groups?.[key]) groups[key] = prev.groups[key]
  })

  let added = 0
  let updated = 0
  let failed = 0
  const res = await pool(todo.map(t => () => fetchJson(`${LANG}/achievements/${t.key}.json`)))
  res.forEach((r, i) => {
    const { key, ver, isNew } = todo[i]
    if (r.ok && r.value) {
      items[key] = { ver, data: r.value }
      if (isNew) added += flattenItem(key, r.value, ver).length
      else updated++
    } else {
      failed++
      // 下载失败的先留着旧数据（版本号记成空，下次同步会再试）
      if (prev.items?.[key]?.data) items[key] = { ver: '', data: prev.items[key].data }
    }
  })
  const removed = Object.keys(prev.items || {}).filter(k => !(k in items)).length

  const changed = force || todo.length || gTodo.length || removed
  if (changed) {
    ensureDir(achievementDir(game))
    const file = dataFile(game)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ syncedAt: Date.now(), groups, items }))
    fs.renameSync(`${file}.tmp`, file)
  }
  const data = getAchievements(game)
  return { total: data?.list.length || 0, added, updated, removed, failed, changed: !!changed }
}

export function formatSync (r) {
  const lines = [`成就数据共 ${r.total} 条`]
  if (!r.changed) lines.push('genshin-db 没有新内容')
  if (r.added) lines.push(`新增 ${r.added} 条`)
  if (r.updated) lines.push(`更新 ${r.updated} 个`)
  if (r.removed) lines.push(`移除 ${r.removed} 个`)
  if (r.failed) lines.push(`${r.failed} 个下载失败，下次同步时重试`)
  return lines.join('，')
}

/** 启动后（没有数据时 20 秒、有数据时 2 分钟）先同步一次，之后每天凌晨 hour 点检查一次 */
export function scheduleAchievementSync (game, hour = 0) {
  const check = () => syncAchievements(game)
    .then(r => { if (r.changed) logger.mark(`[${pluginName}] ${formatSync(r)}`) })
    .catch(err => logger.warn(`[${pluginName}] 成就数据同步失败（不影响其他功能）：${err.message}`))

  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 10, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  setTimeout(() => {
    check()
    setInterval(check, 86400000).unref()
  }, next - now).unref()
  setTimeout(check, getAchievements(game) ? 120000 : 20000).unref()
}
