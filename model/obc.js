import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName } from './config.js'
import { modulesToContents } from './wiki.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/** 详情缓存结构版本，解析结果的结构变了就加一，旧缓存会自动重新拉取 */
const DETAIL_VERSION = 4

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
    this.indexFail = null
    this.onRefresh = null
    this.dishes = null
    this.dishJob = null
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
        if (json?.retcode !== 0) throw Object.assign(new Error(`retcode=${json?.retcode} ${json?.message || ''}`.trim()), { retcode: json?.retcode })
        return json.data
      } catch (err) {
        if (err.retcode !== undefined) throw err
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

  /** 目录：内存 → 磁盘缓存 → 接口；接口挂了就用旧缓存顶上；没有缓存时失败后 5 分钟内不再请求 */
  async getIndex (force = false) {
    const ttl = getConfig().api?.indexTTL ?? 21600
    if (!force && this.index && Date.now() - this.indexAt < ttl * 1000) return this.index
    if (!force && !this.index && this.indexFail && Date.now() - this.indexFail.at < 300000) throw this.indexFail.err
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
      this.indexFail = null
      this.setIndex(entries)
      this.onRefresh?.(entries)
      return entries
    } catch (err) {
      if (!cache?.data?.length) {
        this.indexFail = { at: Date.now(), err }
        throw err
      }
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

  /** 不发请求，只看当前已知的目录（内存优先，其次磁盘缓存，不管新不新鲜）；拿不到返回 null */
  peekIndex () {
    if (this.index) return this.index
    return this.readCache(path.join(this.dir, 'index.json'), Infinity)?.data || null
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
   * 观测枢内容有两套接口：hoyowiki 的 entry_page（新）和 blackboard 的 content/info（旧）。
   * id 大于等于 detailIdSplit 的条目先走新接口（默认 0，即全部先走新接口）；
   * 新接口报「内容不存在」或没有组件数据时换旧接口，旧接口报「内容不存在」时换新接口。
   */
  async fetchDetail (id) {
    const split = getConfig().api?.detailIdSplit ?? 0
    const missing = err => String(err?.message).includes('-2010')
    if (Number(id) < split) {
      try {
        return await this.getObsDetail(id)
      } catch (err) {
        if (missing(err)) return this.getWikiDetail(id)
        throw err
      }
    }
    let fresh
    try {
      fresh = await this.getWikiDetail(id)
      if (fresh.widgets?.length) return fresh
    } catch (err) {
      if (!missing(err)) throw err
    }
    try {
      return await this.getObsDetail(id)
    } catch (err) {
      if (fresh) return fresh
      throw err
    }
  }

  /** 接口原始返回（调试用，不做解析和缓存）：api 为 'new'（hoyowiki）或 'old'（blackboard） */
  async getRawDetail (id, api = 'new') {
    const { base, appSn } = this.game
    const newBase = this.game.newBase || 'https://api-takumi.mihoyo.com/hoyowiki/genshin/wapi'
    return api === 'new'
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

  /** 特色料理索引：料理名 → 所属食物条目 id，done 记录已经抓过的食物；持久化在 dishes.json */
  loadDishes () {
    if (!this.dishes) {
      const data = this.readCache(path.join(this.dir, 'dishes.json'), Infinity)?.data
      this.dishes = { done: new Set(data?.done || []), names: data?.names || {} }
    }
    return this.dishes
  }

  recordDishes (id, names) {
    const d = this.loadDishes()
    d.done.add(String(id))
    for (const n of names) d.names[n] = String(id)
    this.writeCache(path.join(this.dir, 'dishes.json'), { done: [...d.done], names: d.names })
  }

  /** 后台逐条抓取「会产出特色料理」且还没记录过的食物，补全特色料理索引 */
  prefetchDishes (index, namesOf) {
    if (this.dishJob) return this.dishJob
    const d = this.loadDishes()
    const todo = index.filter(e => e.path.includes('食物') && !d.done.has(e.id) &&
      e.tags.some(t => t.k === '是否产出特殊料理' && t.v === '是'))
    if (!todo.length) return Promise.resolve()
    logger.mark(`[${pluginName}] 开始补全特色料理索引，共 ${todo.length} 条`)
    this.dishJob = (async () => {
      let ok = 0
      for (const e of todo) {
        try {
          this.recordDishes(e.id, namesOf(await this.getDetail(e.id)).filter(n => n !== e.title))
          ok++
        } catch (err) {
          logger.warn(`[${pluginName}] 特色料理索引跳过 ${e.title}：${err.message}`)
        }
        await sleep(800)
      }
      logger.mark(`[${pluginName}] 特色料理索引补全完成，成功 ${ok} 条`)
    })().finally(() => { this.dishJob = null })
    return this.dishJob
  }

  /** 清除详情缓存：传 id 只清该条目，否则全部清空 */
  clearDetails (id) {
    fs.rmSync(id ? path.join(this.dir, 'detail', `${id}.json`) : path.join(this.dir, 'detail'), { recursive: true, force: true })
  }
}
