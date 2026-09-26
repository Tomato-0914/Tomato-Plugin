import fs from 'node:fs'
import path from 'node:path'
import { dataRoot, pluginName, ensureDir } from './config.js'

/** genshin-db（MIT License, Copyright (c) 2020 theBowja）的分类目录名 → 版本表里的中文分类名 */
const SOURCES = { weapons: '武器', artifacts: '圣遗物', foods: '食物' }

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
 * 拉取失败（离线、被墙）只记日志，不影响插件正常查询——查询时照样能用上一次同步到的数据，或退回插件自带的版本表。
 */
export async function syncVersions (game) {
  const data = {}
  for (const [dir, label] of Object.entries(SOURCES)) data[label] = await loadCategory(dir)

  const file = versionsFile(game)
  const next = JSON.stringify(data)
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (next === prev) return { changed: false, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Object.keys(v).length])) }

  ensureDir(path.dirname(file))
  fs.writeFileSync(file, next)
  return { changed: true, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Object.keys(v).length])) }
}

/** 每天固定时间自动检查一次；启动后先等一会再查一次，不用等到当天零点 */
export function scheduleVersionSync (game, hour = 0) {
  const check = () => syncVersions(game)
    .then(({ changed }) => { if (changed) logger.mark(`[${pluginName}] 版本表已从 genshin-db 更新`) })
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
