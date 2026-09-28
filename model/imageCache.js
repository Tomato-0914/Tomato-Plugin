import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { getConfig, dataRoot, pluginRoot, pluginName } from './config.js'
import { itemTab } from './match.js'

/**
 * 图片缓存：渲染好的图存在 data/<插件名>/<game>/Atlas/<分类>/<图鉴名>/1.jpg、2.jpg…，旁边一个 meta.json。
 * 分类用观测枢的分类名（角色、武器、圣遗物、食物、敌人…），背包道具按游戏背包页签（养成道具、材料、小道具…）；
 * 特色料理跟着所属的食物放在「食物」下。
 * 下次查同一个条目直接发本地图，不再拉详情、不再渲染。
 * 缓存不会自己过期，只在下面几种情况失效：手动清理、渲染精度/图片质量改了、插件更新后模板或解析代码有变化。
 */

const META = 'meta.json'

export const cacheRoot = game => path.join(dataRoot, game, 'Atlas')

export const cacheEnabled = () => getConfig().imageCache !== false

/** 文件夹名：去掉文件系统不允许的字符 */
const safeName = s => String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || '_'

let codeSig = ''
/** 模板和解析代码的指纹：插件更新改了排版或数据解析，旧图自动作废；进程内只算一次（改代码本来就要重启） */
function codeVersion () {
  if (codeSig) return codeSig
  const hash = crypto.createHash('sha1')
  for (const dir of ['resources/html', 'model']) {
    const abs = path.join(pluginRoot, dir)
    let files = []
    try {
      files = fs.readdirSync(abs).filter(f => /\.(html|js)$/.test(f)).sort()
    } catch {}
    for (const f of files) {
      hash.update(f)
      try {
        hash.update(fs.readFileSync(path.join(abs, f)))
      } catch {}
    }
  }
  codeSig = hash.digest('hex').slice(0, 12)
  return codeSig
}

/** 缓存签名：代码指纹 + 影响出图效果的配置 */
function signature () {
  const cfg = getConfig()
  const r = cfg.render || {}
  return [codeVersion(), cfg.renderScale ?? 100, r.quality ?? 90, r.imageProcess ?? ''].join('|')
}

function readMeta (dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'))
  } catch {
    return null
  }
}

const sameKey = (meta, entry, dish) => meta && String(meta.id) === String(entry.id) && (meta.dish || '') === (dish || '')

/** 分类文件夹：背包道具用背包页签，其余用观测枢分类名 */
function category (entry) {
  const top = (entry.path || []).filter(p => p !== '图鉴')[0] || '其他'
  return safeName(top === '背包' ? itemTab(entry) || top : top)
}

/** 同一分类里重名的条目，后来的放到「名字_id」文件夹 */
function candidates (game, entry, label) {
  cleanLegacy(game)
  const dir = path.join(cacheRoot(game), category(entry))
  const name = safeName(label)
  return [path.join(dir, name), path.join(dir, `${name}_${entry.id}`)]
}

function subDirs (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name))
  } catch {
    return []
  }
}

const legacyDone = new Set()
/** 最早一版没有分类层，图直接放在 Atlas/<图鉴名>/ 下；这种旧文件夹直接删掉，下次查询按新结构重新生成 */
function cleanLegacy (game) {
  if (legacyDone.has(game)) return
  legacyDone.add(game)
  for (const d of subDirs(cacheRoot(game))) {
    if (fs.existsSync(path.join(d, META))) fs.rmSync(d, { recursive: true, force: true })
  }
}

/** 读缓存：命中返回 Buffer 数组，没有或已失效返回 null */
export function loadImages (game, entry, dish, label) {
  if (!cacheEnabled()) return null
  const sig = signature()
  for (const dir of candidates(game, entry, label)) {
    const meta = readMeta(dir)
    if (!sameKey(meta, entry, dish)) continue
    if (meta.sig !== sig || !(meta.count > 0)) return null
    try {
      return Array.from({ length: meta.count }, (_, i) => fs.readFileSync(path.join(dir, `${i + 1}.jpg`)))
    } catch {
      return null
    }
  }
  return null
}

/** 写缓存：先写图片再写 meta，中途失败不会留下能被命中的半截缓存 */
export function saveImages (game, entry, dish, label, bufs) {
  if (!cacheEnabled() || !bufs?.length) return
  try {
    const [primary, alt] = candidates(game, entry, label)
    const meta = readMeta(primary)
    const dir = !meta || sameKey(meta, entry, dish) ? primary : alt
    fs.mkdirSync(dir, { recursive: true })
    fs.rmSync(path.join(dir, META), { force: true })
    for (const f of fs.readdirSync(dir)) if (/^\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f), { force: true })
    bufs.forEach((buf, i) => fs.writeFileSync(path.join(dir, `${i + 1}.jpg`), buf))
    fs.writeFileSync(path.join(dir, META), JSON.stringify({
      id: entry.id,
      title: entry.title,
      dish: dish || '',
      count: bufs.length,
      sig: signature(),
      time: new Date().toISOString()
    }, null, 2))
  } catch (err) {
    logger.warn(`[${pluginName}] 图片缓存写入失败「${label}」：${err.message}`)
  }
}

let clearJob = null
/**
 * 按配置 imageCacheCron 定时清空图片缓存；留空不定时清理。启动时和锅巴保存配置后各调用一次，重复调用会先取消旧的定时任务。
 * 用 Yunzai 自带的 node-schedule，支持「秒 分 时 日 月 周」6 段和「分 时 日 月 周」5 段两种写法
 */
export async function scheduleImageClear (game) {
  clearJob?.cancel()
  clearJob = null
  const cron = String(getConfig().imageCacheCron ?? '').trim()
  if (!cron) return
  let schedule
  try {
    schedule = (await import('node-schedule')).default
  } catch (err) {
    logger.warn(`[${pluginName}] 找不到 node-schedule，图片缓存定时清理不生效：${err.message}`)
    return
  }
  clearJob = schedule.scheduleJob(cron, () => {
    const n = clearImages(game)
    logger.mark(`[${pluginName}] 定时清理图片缓存：清掉 ${n} 条，下次查询时重新生成`)
  })
  if (!clearJob) logger.warn(`[${pluginName}] 图片缓存定时清理的 cron 表达式无效：${cron}`)
}

/** 清图片缓存：传 id 只清这个条目（食物连同它名下的特色料理），否则全部清空；返回清掉的文件夹数 */
export function clearImages (game, id) {
  cleanLegacy(game)
  if (id === undefined) {
    const n = subDirs(cacheRoot(game)).reduce((sum, c) => sum + subDirs(c).length, 0)
    fs.rmSync(cacheRoot(game), { recursive: true, force: true })
    return n
  }
  let n = 0
  for (const c of subDirs(cacheRoot(game))) {
    for (const d of subDirs(c)) {
      if (String(readMeta(d)?.id) !== String(id)) continue
      fs.rmSync(d, { recursive: true, force: true })
      n++
    }
    if (!subDirs(c).length) fs.rmSync(c, { recursive: true, force: true })
  }
  return n
}
