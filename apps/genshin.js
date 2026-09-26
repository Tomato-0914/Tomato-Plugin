import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName } from '../model/config.js'
import { ObcSource } from '../model/obc.js'
import { matchEntry, listCategory, getAliases, norm } from '../model/match.js'
import { renderEntry } from '../model/render.js'
import { dishNames } from '../model/card.js'

const GAME = 'gs'
const source = new ObcSource(GAME)

/** 启动后在后台补全特色料理索引（只抓还没记录过的食物） */
const prefetchDishes = () => source.getIndex()
  .then(index => source.prefetchDishes(index, dishNames))
  .catch(err => logger.warn(`[${pluginName}] 特色料理索引补全失败：${err.message}`))
setTimeout(prefetchDishes, 15000)

/** 目录派生的查找表（id → 条目、规范化标题 → 条目），按目录对象缓存，避免每条消息都遍历全部标题 */
const indexCache = new WeakMap()
function indexMaps (index) {
  let m = indexCache.get(index)
  if (!m) {
    m = { byId: new Map(index.map(e => [e.id, e])), byTitle: new Map(index.map(e => [norm(e.title), e])) }
    indexCache.set(index, m)
  }
  return m
}

/** 特色料理等品质名 → { 所属食物标题, 料理名 }；和目录里已有条目同名的不收 */
function dishAliases (index) {
  const { byId, byTitle } = indexMaps(index)
  const out = new Map()
  for (const [name, id] of Object.entries(source.loadDishes().names)) {
    const k = norm(name)
    const e = byId.get(id)
    if (k && e && !byTitle.has(k)) out.set(k, { title: e.title, name })
  }
  return out
}

/** 按目录给材料补图标：先按词条链接里的 content id，再按名称 */
function iconResolver (index) {
  const { byId, byTitle } = indexMaps(index)
  return (name, url) => byId.get(String(url ?? '').match(/content\/(\d+)/)?.[1])?.icon || byTitle.get(norm(name))?.icon || ''
}

/** 不带「图鉴」的消息先粗筛：只有精确标题、别名、料理名才值得走完整匹配 */
function mayHit (q, index) {
  const k = norm(q)
  return !!k && (indexMaps(index).byTitle.has(k) || getAliases(GAME).has(k) || dishAliases(index).has(k))
}

/** Atlas 等插件自己的「图鉴」管理指令，不当作查询 */
const FOREIGN = /^[#/]*((github)?(原神|星铁|绝区零|洛克|rc)?图鉴(插件)?(强行)?(强制)?升级|(强制)?更新图鉴)$/

/** 在目录里查找条目：自带别名 + 用户别名 + 特色料理别名；按料理名命中时带上 dish */
function lookup (q, index) {
  const game = getConfig().games[GAME]
  const dishes = dishAliases(index)
  const user = getAliases(GAME)
  const aliases = new Map([...[...dishes].map(([k, v]) => [k, v.title]), ...user])
  const res = matchEntry(q, index, { aliases, priority: game.categoryPriority || [] })
  const k = norm(q)
  if (res.type === 'hit' && res.via === 'alias' && dishes.has(k) && !user.has(k)) res.dish = dishes.get(k).name
  return res
}

/** 清理旧版本留下的图片缓存目录 */
fs.rmSync(path.join(dataRoot, GAME, 'render'), { recursive: true, force: true })

const HELP = [
  '【观测枢图鉴 · 原神】',
  '#护摩之杖图鉴 或 #图鉴护摩之杖：查询条目（角色请用喵喵插件）',
  '#武器图鉴：列出某个分类下的全部条目',
  '#图鉴分类：看看有哪些分类',
  '#图鉴更新：重新拉取目录（主人）',
  '#图鉴强制更新：清空全部数据缓存（主人）',
  '#图鉴清除缓存：清空全部条目详情缓存（主人）',
  '#图鉴清除缓存护摩之杖：重新拉取该条目并生成（主人）',
  '#图鉴调试护摩之杖：导出原始数据（主人）'
].join('\n')

async function sendMany (e, msgs, title = '') {
  if (msgs.length <= (getConfig().forwardThreshold ?? 2)) return e.reply(msgs.length === 1 ? msgs[0] : msgs)
  try {
    if (typeof Bot !== 'undefined' && typeof Bot.makeForwardArray === 'function') return await e.reply(await Bot.makeForwardArray(msgs))
    const { default: common } = await import('../../../lib/common/common.js')
    return await e.reply(await common.makeForwardMsg(e, msgs, title))
  } catch (err) {
    logger.warn(`[${pluginName}] 合并转发失败，改为逐条发送：${err.message}`)
  }
  for (const m of msgs) await e.reply(m)
  return true
}

/** 属于 skipCategories 的条目不响应，交给其他插件 */
const skipped = entry => (getConfig().skipCategories || []).some(c => entry.path.includes(c))

/** 把本地文件发到当前会话：优先 segment.file，其次群文件 / 好友文件接口；都不支持返回 false */
async function sendFile (e, file) {
  const name = path.basename(file)
  try {
    if (typeof segment !== 'undefined' && typeof segment.file === 'function') {
      await e.reply(segment.file(file, name))
      return true
    }
    if (e.isGroup && typeof e.group?.sendFile === 'function') {
      await e.group.sendFile(file)
      return true
    }
    if (e.isGroup && typeof e.group?.fs?.upload === 'function') {
      await e.group.fs.upload(file)
      return true
    }
    if (typeof e.friend?.sendFile === 'function') {
      await e.friend.sendFile(file)
      return true
    }
  } catch (err) {
    logger.warn(`[${pluginName}] 发送文件失败：${err.message}`)
  }
  return false
}

function chunkText (text, size = 800) {
  const out = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf && buf.length + line.length + 1 > size) {
      out.push(buf)
      buf = ''
    }
    buf += (buf ? '\n' : '') + line
  }
  if (buf) out.push(buf)
  return out
}

export class ObcGenshin extends plugin {
  constructor () {
    const cfg = getConfig()
    const rule = [
      { reg: '^[#/](原神)?图鉴(帮助|help|菜单|功能)?$', fnc: 'help' },
      { reg: '^#(原神)?图鉴(强制)?更新$', fnc: 'update', permission: 'master' },
      { reg: '^#(原神)?图鉴调试\\s*\\S.*$', fnc: 'debug', permission: 'master' },
      { reg: '^#(原神)?图鉴清除缓存.*$', fnc: 'clearCache', permission: 'master' },
      { reg: '^#(原神)?图鉴(分类|目录)$', fnc: 'categories' },
      { reg: '^[#/](原神)?图鉴\\s*\\S.*$', fnc: 'queryPrefix' },
      { reg: '^[#/]?.+图鉴$', fnc: 'querySuffix' }
    ]
    if (cfg.bareMatch) rule.push({ reg: '^[#/]?[^#/\\s]{1,20}$', fnc: 'queryBare' })
    super({
      name: '观测枢图鉴·原神',
      dsc: '实时拉取米游社观测枢数据渲染图鉴',
      event: 'message',
      priority: cfg.priority ?? 100,
      rule
    })
  }

  async help () {
    return this.reply(HELP)
  }

  async queryPrefix () {
    if (FOREIGN.test(this.e.msg)) return false
    return this.query(this.e.msg.replace(/^[#/](原神)?图鉴\s*/, ''))
  }

  /** #名称图鉴 列分类 / 多条候选；不带 # 的 名称图鉴 只在命中条目时回复 */
  async querySuffix () {
    if (FOREIGN.test(this.e.msg)) return false
    const q = this.e.msg.replace(/^[#/]?(原神)?/, '').replace(/\s*图鉴$/, '')
    return /^[#/]/.test(this.e.msg) ? this.query(q, { loose: true }) : this.query(q, { bare: true, partial: true })
  }

  async queryBare () {
    return this.query(this.e.msg.replace(/^[#/]/, ''), { bare: true })
  }

  /** bare：只在命中条目时回复（partial 允许名称的一部分）；loose：没命中时放行。两者都不提示“没找到” */
  async query (q, { bare = false, loose = false, partial = false } = {}) {
    q = String(q).trim()
    if (!q || q.length > 30) return false

    let index
    try {
      index = await source.getIndex()
    } catch (err) {
      logger.error(err)
      return bare ? false : this.reply(`观测枢目录拉取失败：${err.message}`)
    }

    if (bare && !partial && !mayHit(q, index)) return false
    const res = lookup(q, index)

    if (res.type === 'hit' && skipped(res.entry)) return false
    if (bare) return res.type === 'hit' && (partial || res.via !== 'partial') ? this.sendEntry(res.entry, false, res.dish) : false
    if (res.type === 'hit') return this.sendEntry(res.entry, false, res.dish)

    const cat = listCategory(q, index.filter(e => !skipped(e)))
    if (cat) {
      const text = `「${q}」共 ${cat.length} 条，发送 #名称图鉴 查看：\n${cat.join('、')}`
      return sendMany(this.e, chunkText(text), q)
    }

    if (res.type === 'multi') {
      res.list = res.list.filter(e => !skipped(e))
      if (!res.list.length) return false
      if (res.list.length === 1) return this.sendEntry(res.list[0])
      return this.reply(`「${q}」对应多个条目，写完整一点：\n${res.list.map(x => x.title).join('、')}`)
    }
    if (loose) return false
    res.suggest = res.suggest.filter(e => !skipped(e))
    if (res.suggest.length) {
      return this.reply(`没找到「${q}」，你要找的是不是：${res.suggest.map(x => x.title).join('、')}`)
    }
    return this.reply(`没找到「${q}」。发送 #图鉴分类 可以看有哪些分类`)
  }

  async sendEntry (entry, force = false, dish = '') {
    if (skipped(entry)) return false
    const label = (dish || entry.title).replace(/^「(.+)」$/, '$1')
    let content
    try {
      content = await source.getDetail(entry.id, force)
    } catch (err) {
      logger.error(err)
      return this.reply(`获取「${entry.title}」失败：${err.message}`)
    }
    if (entry.path.includes('食物')) source.recordDishes(entry.id, dishNames(content).filter(n => n !== entry.title))

    let imgs
    try {
      imgs = await renderEntry(GAME, entry, content, {
        dish,
        iconOf: iconResolver(await source.getIndex().catch(() => [])),
        onStart: () => getConfig().renderTip && this.reply(`正在生成「${label}」，请稍候…`)
      })
    } catch (err) {
      logger.error(err)
      return this.reply(`「${label}」渲染失败：${err.message}`)
    }
    return sendMany(this.e, imgs.map(buf => segment.image(buf)), label)
  }

  async update () {
    const force = this.e.msg.includes('强制')
    if (force) source.clearDetails()
    try {
      const index = await source.getIndex(true)
      prefetchDishes()
      return this.reply(`目录已更新，共 ${index.length} 条${force ? '；详情缓存已清空' : ''}`)
    } catch (err) {
      return this.reply(`更新失败：${err.message}`)
    }
  }

  /** 不带名称清空全部详情缓存；带名称重新拉取该条目并生成 */
  async clearCache () {
    const q = this.e.msg.replace(/^#(原神)?图鉴清除缓存\s*/, '').trim()
    if (!q) {
      source.clearDetails()
      return this.reply('已清空全部详情缓存，下次查询时重新拉取')
    }
    let index
    try {
      index = await source.getIndex()
    } catch (err) {
      return this.reply(`目录拉取失败：${err.message}`)
    }
    const res = lookup(q, index)
    if (res.type !== 'hit') return this.reply(`没找到唯一条目「${q}」`)
    source.clearDetails(res.entry.id)
    return this.sendEntry(res.entry, true, res.dish)
  }

  async categories () {
    let index
    try {
      index = await source.getIndex()
    } catch (err) {
      return this.reply(`观测枢目录拉取失败：${err.message}`)
    }
    const counts = new Map()
    for (const e of index) {
      const key = e.path.join(' / ') || '（未分类）'
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    const lines = [...counts].map(([k, n]) => `${k}：${n}`)
    return sendMany(this.e, chunkText(`观测枢目录共 ${index.length} 条\n${lines.join('\n')}`), '图鉴分类')
  }

  /** 导出原始数据，方便对照接口结构写解析器 */
  async debug () {
    const q = this.e.msg.replace(/^#(原神)?图鉴调试\s*/, '').trim()
    let index, content
    try {
      index = await source.getIndex()
    } catch (err) {
      return this.reply(`目录拉取失败：${err.message}`)
    }
    const res = lookup(q, index)
    if (res.type !== 'hit') return this.reply(`没找到唯一条目「${q}」`)
    try {
      content = await source.getDetail(res.entry.id, true)
    } catch (err) {
      return this.reply(`详情拉取失败：${err.message}`)
    }

    const file = path.join(ensureDir(path.join(dataRoot, GAME, 'debug')), `${res.entry.id}.json`)
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
    const raws = []
    for (const [api, suffix, label] of [['new', '.raw.json', '新接口'], ['old', '.old.raw.json', '旧接口']]) {
      const rawFile = file.replace(/\.json$/, suffix)
      try {
        fs.writeFileSync(rawFile, JSON.stringify(await source.getRawDetail(res.entry.id, api), null, 2))
        raws.push({ label, file: rawFile })
      } catch (err) {
        raws.push({ label, error: err.message })
      }
    }

    const secs = Array.isArray(content.contents) ? content.contents : []
    const html = secs.map(s => s?.text || '').join('') || content.content || ''
    const classCount = new Map()
    for (const m of String(html).matchAll(/class="([^"]+)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c) classCount.set(c, (classCount.get(c) || 0) + 1)
    }
    const topClasses = [...classCount].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => `${c}(${n})`)

    const lines = [
      `「${content.title}」content_id=${res.entry.id}`,
      `分类：${res.entry.path.join(' / ')}`,
      `字段：${Object.keys(content).join(', ')}`,
      secs.length
        ? `分段 ${secs.length} 个：\n${secs.map(s => `- ${s?.name || '（无名）'}：${(s?.text || '').length} 字符`).join('\n')}`
        : `没有 contents 分段，content 长度 ${String(content.content || '').length}`,
      `常见 class：${topClasses.join(' ') || '无'}`,
      `解析结果：${path.relative(process.cwd(), file)}`,
      ...raws.map(r => r.file ? `${r.label}原始数据：${path.relative(process.cwd(), r.file)}` : `${r.label}没有数据：${r.error}`)
    ]
    await sendMany(this.e, chunkText(lines.join('\n')), '图鉴调试')
    const files = raws.filter(r => r.file).map(r => r.file)
    let sent = true
    for (const f of files.length ? files : [file]) sent = await sendFile(this.e, f) && sent
    if (!sent) await this.reply('当前适配器不支持发送文件，请到上面的路径手动下载')
    return true
  }
}
