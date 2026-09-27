import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, pluginName, ensureDir, readYaml } from './config.js'

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

/**
 * 存放同步结果的位置：resources/version/<game>.yaml。这个路径特意加进了 .gitignore，不受 git 管，
 * #更新图鉴/#强制更新图鉴（git pull / reset --hard）不会碰它，也不会因为它本地有改动就更新失败。
 */
export function versionsFile (game) {
  return path.join(pluginRoot, 'resources', 'version', `${game}.yaml`)
}

/** 名称: 版本号 按版本号从小到大排序拼成一段 yaml；名字带引号/冒号/#这类字符的加个引号，避免解析出错 */
function block (label, map) {
  const vkey = v => String(v).split('.').map(Number)
  const lines = Object.entries(map)
    .sort(([, a], [, b]) => vkey(a)[0] - vkey(b)[0] || (vkey(a)[1] || 0) - (vkey(b)[1] || 0))
    .map(([name, ver]) => `  ${/^[「[{]/.test(name) || /[:#]/.test(name) ? JSON.stringify(name) : name}: '${ver}'`)
  return `${label}:\n${lines.join('\n')}`
}

/** data（{ 分类: {名称: 版本号} }）拼成带说明注释的完整 yaml 文本 */
function render (data) {
  const header = [
    '# 条目上线版本：分类列表按版本分组、排序用',
    '# 整理自 genshin-db（https://github.com/theBowja/genshin-db ，MIT License，Copyright (c) 2020 theBowja）',
    '# 这个文件是插件运行时自动生成/同步的（#图鉴更新 / #更新图鉴目录，或者每天自动同步），不要手改，改了也会被覆盖；',
    '# 自己要补充或修正的写到 config/version/gs.yaml，格式一样，不会被这个文件覆盖'
  ].join('\n')
  const blocks = Object.entries(data).map(([label, map]) => block(label, map))
  return `${header}\n\n${blocks.join('\n')}\n`
}

/**
 * 联网检查 genshin-db 有没有更新，有变化才重写本地文件；
 * 拉取失败（离线、被墙）只记日志，不影响插件正常查询——查询时照样能用上一次同步到的数据；一次都没同步成功过的话，
 * 分类列表里的版本分组会先显示成「未收录版本」，不影响条目本身的查询。
 * 返回 { changed, added: { 分类: 新增条数 }, totalAdded }：added 只统计新出现的名称，已有名称改了版本号不算在内。
 */
export async function syncVersions (game) {
  const data = {}
  for (const [dir, label] of Object.entries(SOURCES)) data[label] = await loadCategory(dir)

  const file = versionsFile(game)
  const prev = readYaml(file)

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

  const next = render(data)
  const prevRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
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
