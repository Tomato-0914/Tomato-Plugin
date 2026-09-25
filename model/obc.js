import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName } from './config.js'
import { modulesToContents } from './wiki.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** 详情缓存结构版本，解析结果的结构变了就加一，旧缓存会自动重新拉取 */
const DETAIL_VERSION = 2

/**
 * 目录条目的 ext 里带筛选标签，形如
 * {"c_25":{"filter":{"text":"[\"星级/五星\",\"元素/火\"]"}}}
 * 解析成 [{ k: '星级', v: '五星' }, ...]；格式不对就返回空数组，不影响查询
 */
export function parseTags (ext) {
  let obj = ext
  if (typeof ext === 'string') {
    try { obj = JSON.parse(ext) } catch { return [] }
  }
  const out = []
  const seen = new Set()
  for (const val of Object.values(obj && typeof obj === 'object' ? obj : {})) {
    let list = val?.filter?.text
    if (typeof list === 'string') {
      try { list = JSON.parse(list) } catch { continue }
    }
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const [k, ...rest] = String(raw).split('/')
      const v = rest.join('/').trim()
      if (!v || seen.has(`${k}/${v}`)) continue
      seen.add(`${k}/${v}`)
      out.push({ k: k.trim(), v })
    }
  }
  return out
}

/** 把目录树摊平成 [{ id, title, path, icon, tags }] */
export function buildIndex (roots) {
  const out = []
  const seen = new Set()
  const walk = (nodes, trail) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      const here = node.name ? [...trail, String(node.name)] : trail
      for (const item of Array.isArray(node.list) ? node.list : []) {
        const id = item?.content_id
        const title = typeof item?.title === 'string' ? item.title.trim() : ''
        if (!id || !title || seen.has(String(id))) continue
        seen.add(String(id))
        out.push({
          id: String(id),
          title,
          path: here,
          icon: typeof item.icon === 'string' ? item.icon : '',
          tags: parseTags(item.ext)
        })
      }
      walk(node.children, here)
    }
  }
  walk(roots, [])
  return out
}

/** 一个游戏的观测枢数据源（原神 = gs，后面加星铁只需要再 new 一个） */
export class ObcSource {
  constructor (key) {
    this.key = key
    this.dir = path.join(dataRoot, key)
    this.index = null
    this.indexAt = 0
    this.indexJob = null
  }

  get game () {
    const game = getConfig().games?.[this.key]
    if (!game) throw new Error(`配置里没有游戏 ${this.key}`)
    return game
  }

  async request (url) {
    const timeout = getConfig().api?.timeout || 15000
    let lastErr
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Referer: 'https://baike.mihoyo.com/', Accept: 'application/json' },
          signal: AbortSignal.timeout(timeout)
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (json?.retcode !== 0) throw new Error(`retcode=${json?.retcode} ${json?.message || ''}`.trim())
        return json.data
      } catch (err) {
        lastErr = err
        if (i === 0) await sleep(1000)
      }
    }
    throw lastErr
  }

  readCache (file, ttlSec) {
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), fresh: age < ttlSec * 1000 }
    } catch {
      return null
    }
  }

  writeCache (file, data) {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify(data))
  }

  /** 目录：内存 → 磁盘缓存 → 接口；接口挂了就用旧缓存顶上 */
  async getIndex (force = false) {
    const ttl = getConfig().api?.indexTTL ?? 21600
    if (!force && this.index && Date.now() - this.indexAt < ttl * 1000) return this.index
    if (!this.indexJob) {
      this.indexJob = this.loadIndex(force, ttl).finally(() => { this.indexJob = null })
    }
    return this.indexJob
  }

  async loadIndex (force, ttl) {
    const file = path.join(this.dir, 'index.json')
    const cache = this.readCache(file, ttl)
    if (!force && cache?.fresh && cache.data?.length) return this.setIndex(cache.data)
    try {
      const { base, appSn, channelId, name } = this.game
      const data = await this.request(`${base}/home/content/list?app_sn=${appSn}&channel_id=${channelId}`)
      const entries = buildIndex(data?.list)
      if (!entries.length) throw new Error('目录为空，接口结构可能变了')
      this.writeCache(file, entries)
      logger.mark(`[${pluginName}] ${name}目录已更新，共 ${entries.length} 条`)
      return this.setIndex(entries)
    } catch (err) {
      if (!cache?.data?.length) throw err
      logger.warn(`[${pluginName}] 目录拉取失败，先用本地缓存：${err.message}`)
      this.setIndex(cache.data)
      this.indexAt = Date.now() - Math.max(ttl - 600, 0) * 1000 // 10 分钟后再试
      return this.index
    }
  }

  setIndex (entries) {
    this.index = entries
    this.indexAt = Date.now()
    return entries
  }

  /** 详情：磁盘缓存 → 接口（旧/新接口自动分流）；接口挂了就用旧缓存顶上 */
  async getDetail (id, force = false) {
    const ttl = getConfig().api?.detailTTL ?? 43200
    const file = path.join(this.dir, 'detail', `${id}.json`)
    const cache = this.readCache(file, ttl)
    if (!force && cache?.fresh && cache.data?.ver === DETAIL_VERSION) return cache.data
    try {
      const content = { ...await this.fetchDetail(id), ver: DETAIL_VERSION }
      this.writeCache(file, content)
      return content
    } catch (err) {
      if (!cache?.data) throw err
      logger.warn(`[${pluginName}] 详情 ${id} 拉取失败，先用本地缓存：${err.message}`)
      return cache.data
    }
  }

  /**
   * 观测枢内容有两套接口：旧条目（id < 500000）走 blackboard 的
   * content/info，新条目（id >= 500000）走 hoyowiki 的 entry_page。
   * 按 id 分段选主接口；主接口报「内容不存在」时换另一套再试一次，
   * 这样即使将来 id 分段变化也不会挂。
   */
  async fetchDetail (id) {
    const split = getConfig().api?.detailIdSplit ?? 500000
    const primaryNew = Number(id) >= split
    try {
      return primaryNew ? await this.getWikiDetail(id) : await this.getObsDetail(id)
    } catch (err) {
      if (String(err.message).includes('-2010')) {
        return primaryNew ? this.getObsDetail(id) : this.getWikiDetail(id)
      }
      throw err
    }
  }

  /** 接口原始返回（调试用，不做解析和缓存） */
  async getRawDetail (id) {
    const split = getConfig().api?.detailIdSplit ?? 500000
    const { base, appSn } = this.game
    const newBase = this.game.newBase || 'https://api-takumi.mihoyo.com/hoyowiki/genshin/wapi'
    return Number(id) >= split
      ? this.request(`${newBase}/entry_page?app_sn=${appSn}&lang=zh-cn&entry_page_id=${encodeURIComponent(id)}`)
      : this.request(`${base}/content/info?app_sn=${appSn}&content_id=${encodeURIComponent(id)}`)
  }

  /** 旧版（blackboard）详情，返回的 data.content 已经是规范结构 */
  async getObsDetail (id) {
    const { base, appSn } = this.game
    const data = await this.request(`${base}/content/info?app_sn=${appSn}&content_id=${encodeURIComponent(id)}`)
    if (!data?.content) throw new Error('详情为空')
    return data.content
  }

  /** 新版（hoyowiki）详情，解析后转成和旧版一样的规范结构 */
  async getWikiDetail (id) {
    const { appSn } = this.game
    const base = getConfig().games?.[this.key]?.newBase || 'https://api-takumi.mihoyo.com/hoyowiki/genshin/wapi'
    const data = await this.request(`${base}/entry_page?app_sn=${appSn}&lang=zh-cn&entry_page_id=${encodeURIComponent(id)}`)
    if (!data?.page) throw new Error('词条为空')
    return modulesToContents(data.page)
  }

  /** 清除详情缓存：传 id 只清该条目，否则全部清空 */
  clearDetails (id) {
    fs.rmSync(id ? path.join(this.dir, 'detail', `${id}.json`) : path.join(this.dir, 'detail'), { recursive: true, force: true })
  }
}
