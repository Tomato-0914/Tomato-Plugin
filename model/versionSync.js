import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, pluginName, ensureDir } from './config.js'

/**
 * genshin-db（MIT License, Copyright (c) 2020 theBowja）的分类目录名 → 版本表里的中文分类名。
 * genshin-db 的 domains 只收录了「炼武秘境」这类挑战关卡（如“炼武秘境：云垢 I”），
 * 名字对不上观测枢秘境条目（如“云叅林”），加了也是白搭，所以没收。
 */
const SOURCES = { weapons: '武器', artifacts: '圣遗物', foods: '食物', enemies: '敌人', materials: '背包' }

/** 两个镜像轮流试，国内直连 GitHub 不稳的话走 jsdelivr */
const MIRRORS = [
  p => `https://raw.githubusercontent.com/theBowja/genshin-db/main/src/data/${p}`,
  p => `https://cdn.jsdelivr.net/gh/theBowja/genshin-db@main/src/data/${p}`
]

async function fetchJson (relPath) {
  let lastErr
  for (const mirror of MIRRORS) {
    try {
      const res = await fetch(mirror(relPath), { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

async function loadCategory (dir) {
  const [idx, ver] = await Promise.all([
    fetchJson(`index/ChineseSimplified/${dir}.json`),
    fetchJson(`version/${dir}.json`)
  ])
  const out = {}
  for (const [key, version] of Object.entries(ver)) {
    const name = idx.namemap?.[key]
    if (name && version) out[name] = String(version)
  }
  return out
}

/** 存放同步结果的位置：data/<插件名>/<game>/versions.json，不进 git，不会和 #更新图鉴 的 git pull 冲突 */
export function versionsFile (game) {
  return path.join(dataRoot, game, 'versions.json')
}

/**
 * 联网检查 genshin-db 有没有更新，有变化才重写本地缓存；
 * 拉取失败（离线、被墙）只记日志，不影响插件正常查询——查询时照样能用上一次同步到的数据；一次都没同步成功过的话，
 * 分类列表里的版本分组会先显示成「未收录版本」，不影响条目本身的查询。
 * 返回 { changed, added: { 分类: 新增条数 }, totalAdded }：added 只统计新出现的名称，已有名称改了版本号不算在内。
 */
export async function syncVersions (game) {
  const data = {}
  for (const [dir, label] of Object.entries(SOURCES)) data[label] = await loadCategory(dir)

  const file = versionsFile(game)
  const prevRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  let prev = {}
  try { prev = prevRaw ? JSON.parse(prevRaw) : {} } catch { prev = {} }

  const added = {}
  let totalAdded = 0
  for (const [label, map] of Object.entries(data)) {
    const prevNames = prev[label] || {}
    const n = Object.keys(map).filter(name => !(name in prevNames)).length
    if (n) {
      added[label] = n
      totalAdded += n
    }
  }

  const next = JSON.stringify(data)
  if (next === prevRaw) return { changed: false, added: {}, totalAdded: 0 }

  ensureDir(path.dirname(file))
  fs.writeFileSync(file, next)
  return { changed: true, added, totalAdded }
}

/** 同步结果拼成文字：先总览一行，再每个有新增的分类一行 */
export function formatSyncResult ({ changed, added, totalAdded }) {
  if (!changed) return ['没有从观测枢获取到新内容']
  if (!totalAdded) return ['版本表数据有更新（没有新条目，可能是修正了已有的版本号）']
  const lines = Object.entries(added).map(([label, n]) => `「${label}」图鉴目录：新增 ${n} 条`)
  return [`版本表已更新，本次新增 ${totalAdded} 条`, ...lines]
}

/** 每天固定时间自动检查一次；启动后先等一会再查一次，不用等到当天零点 */
export function scheduleVersionSync (game, hour = 0) {
  const check = () => syncVersions(game)
    .then(r => { if (r.changed) logger.mark(`[${pluginName}] ${formatSyncResult(r).join('\n')}`) })
    .catch(err => logger.warn(`[${pluginName}] 版本表同步失败（不影响正常使用）：${err.message}`))

  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  // unref：这几个定时器不该单独撑着进程不退出，Yunzai 本身的消息监听会让进程正常常驻
  setTimeout(() => {
    check()
    setInterval(check, 86400000).unref()
  }, next - now).unref()

  setTimeout(check, 60000).unref()
}
