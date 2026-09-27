import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName } from '../model/config.js'
import { ObcSource } from '../model/obc.js'
import { matchEntry, listCategory, listItemType, itemTab, BAG_TABS, getAliases, getWeakAliases, getVersions, norm } from '../model/match.js'
import { renderEntry } from '../model/render.js'
import { dishNames } from '../model/card.js'
import { syncVersions, scheduleVersionSync, formatSyncResult } from '../model/versionSync.js'

const GAME = 'gs'
const source = new ObcSource(GAME)

/** 启动后及每次目录从接口刷新后，在后台补全特色料理索引（只抓还没记录过的食物） */
const prefetchDishes = index => Promise.resolve(index || source.getIndex())
  .then(list => source.prefetchDishes(list, dishNames))
  .catch(err => logger.warn(`[${pluginName}] 特色料理索引补全失败：${err.message}`))
source.onRefresh = prefetchDishes
setTimeout(prefetchDishes, 15000)

/** 每天后台自动从 genshin-db 同步一次武器/圣遗物/食物的上线版本；启动后也会先跑一次，日志打到控制台 */
scheduleVersionSync(GAME)

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

/** 可用的别名：去掉与标题同名的；plain（消息既不带 # 也不带「图鉴」）时再去掉弱别名 */
function userAliases (index, plain) {
  const { byTitle } = indexMaps(index)
  const weak = plain ? getWeakAliases(GAME) : new Set()
  return new Map([...getAliases(GAME)].filter(([k]) => !byTitle.has(k) && !weak.has(k)))
}

/** 不带「图鉴」的消息先粗筛：只有精确标题、别名、料理名才值得走完整匹配 */
function mayHit (q, index, plain) {
  const k = norm(q)
  if (!k) return false
  if (indexMaps(index).byTitle.has(k) || dishAliases(index).has(k)) return true
  return getAliases(GAME).has(k) && !(plain && getWeakAliases(GAME).has(k))
}

/** Atlas 等插件自己的「图鉴」管理指令，不当作查询 */
const FOREIGN = /^[#/]*((github)?(原神|星铁|绝区零|洛克|rc)?图鉴(插件)?(强行)?(强制)?升级|(强制)?更新图鉴)$/

/** 在目录里查找条目：自带别名 + 用户别名 + 特色料理别名；按料理名命中时带上 dish */
function lookup (q, index, plain = false) {
  const game = getConfig().games[GAME]
  const dishes = dishAliases(index)
  const user = userAliases(index, plain)
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
  '#护摩之杖图鉴 或 #图鉴护摩之杖：查询条目，角色（如 #刻晴图鉴）也支持',
  '护摩之杖、#护摩、苍白套：武器、圣遗物、食物、敌人、秘境可直接发名称或别名',
  '#苍白、月光图鉴：闲聊常用的简称要带 # 或“图鉴”',
  '#原石图鉴：道具和苹果、鸟蛋等常用名词只认这种写法',
  '#武器图鉴：分类总览；#五星武器图鉴 / #金色武器图鉴：该品质按版本分组列出',
  '#背包图鉴：按游戏背包页签查看；#养成道具图鉴、#紫色贵重道具图鉴 等',
  '#图鉴分类：看看有哪些分类',
  '#图鉴更新：重新拉取目录，顺带同步一次版本表（主人）',
  '#图鉴强制更新：清空全部数据缓存后同上（主人）',
  '#更新图鉴目录：只同步版本表，不刷新目录（主人）',
  '#图鉴清除缓存：清空全部条目详情缓存（主人）',
  '#图鉴清除缓存护摩之杖：只清这一条的详情缓存（主人）',
  '#图鉴调试护摩之杖：导出原始数据（主人）'
].join('\n')

/** 多条消息：超过 forwardThreshold 或 forward 为 true 时合并转发 */
async function sendMany (e, msgs, title = '', forward = false) {
  if (!forward && msgs.length <= (getConfig().forwardThreshold ?? 2)) return e.reply(msgs.length === 1 ? msgs[0] : msgs)
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

const STAR_NAMES = ['', '一星', '二星', '三星', '四星', '五星']
const STAR_COLORS = ['', '白色', '绿色', '蓝色', '紫色', '金色']
const STAR_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 白: 1, 绿: 2, 蓝: 3, 紫: 4, 金: 5 }

/** 名称逐行排列，超过 100 个拆成多条，后续条目标题加“（续）” */
function lineMsgs (head, lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 100) {
    const tag = head && i ? `${head.replace(/（.*$/, '')}（续）` : head
    out.push([tag, ...lines.slice(i, i + 100)].filter(Boolean).join('\n'))
  }
  return out
}

/** 分类总览：byType 且带道具类型的（背包）先按游戏背包页签列出；有星级的按 金 紫 蓝 绿 白 列出条数和对应指令；都没有的直接逐行列出名称 */
function categoryMsgs (name, list, byType = true) {
  if (byType && list.some(x => itemTab(x.entry))) {
    const counts = new Map()
    for (const x of list) {
      const t = itemTab(x.entry)
      if (t) counts.set(t, (counts.get(t) || 0) + 1)
    }
    const order = Object.keys(BAG_TABS)
    const rank = t => order.includes(t) ? order.indexOf(t) : order.length
    const types = [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    const rest = list.filter(x => !itemTab(x.entry)).map(x => x.entry.title)
    return [
      `「${name}」共 ${list.length} 条，按背包页签查看：\n${types.map(([t, n]) => `#${t}图鉴（${n} 条）`).join('\n')}`,
      ...lineMsgs(rest.length ? `未标类型（${rest.length} 条）` : '', rest)
    ]
  }
  const stars = [5, 4, 3, 2, 1].map(s => [s, list.filter(x => x.star === s).length]).filter(([, n]) => n)
  const rest = list.filter(x => !x.star)
  // 没有星级的分类（比如敌人）没法先按品质分组，直接按版本分组展示
  if (!stars.length) return [`「${name}」共 ${list.length} 条，发送 #名称图鉴 查看`, ...versionGroups('', list)]
  const lines = stars.map(([s, n]) => `${'★'.repeat(s)} ${STAR_COLORS[s]} #${STAR_NAMES[s]}${name}图鉴（${n} 条）`)
  return [
    `「${name}」共 ${list.length} 条，按品质查看（也可以发 #金色${name}图鉴 这种）：\n${lines.join('\n')}`,
    ...versionGroups(rest.length ? '未标星级' : '', rest)
  ]
}

/** 按大版本分组（新版本在前）：完全没有版本数据就退化成纯名称列表；head 是每组前面加的标签（比如“未标星级”），可以为空 */
function versionGroups (head, list) {
  if (!list.length) return []
  if (!list.some(x => x.ver)) return lineMsgs(head, list.map(x => x.entry.title))
  const groups = new Map()
  for (const x of list) {
    const key = x.ver ? x.ver.split('.')[0] : ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(x)
  }
  const msgs = []
  for (const [major, items] of groups) {
    const vers = items.map(x => x.ver)
    const span = vers[0] === vers[vers.length - 1] ? vers[0] : `${vers[vers.length - 1]}~${vers[0]}`
    const sub = major ? `${span} 版本（${items.length} 条）` : `未收录版本（${items.length} 条）`
    msgs.push(...lineMsgs(head ? `${head}·${sub}` : sub, items.map(x => x.ver ? `${x.entry.title}（${x.ver}）` : x.entry.title)))
  }
  return msgs
}

/** 单一星级列表：按大版本分组（新版本在前），每行“名称（版本）” */
function starMsgs (name, star, list) {
  const title = `${'★'.repeat(star)} ${STAR_COLORS[star]}${name} 共 ${list.length} 条，发送 #名称图鉴 查看`
  return [title, ...versionGroups('', list)]
}

/** 分类指令：武器 / 小道具 → 总览；五星武器 / 金色小道具 → 该品质按版本分组的列表；不是分类或道具类型返回 null */
function categoryReply (q, index) {
  const pool = index.filter(e => !skipped(e))
  const versions = getVersions(GAME)
  const find = n => {
    const list = listCategory(n, pool, versions)
    if (list) return { name: n, list }
    const t = listItemType(n, pool, versions)
    return t && { name: t.type, list: t.list, isType: true }
  }
  let m = q.match(/^(?:([一二三四五1-5])星|([金紫蓝绿白])色?)(.+)$/)
  let hit = m && find(m[3])
  if (!hit) {
    m = null
    hit = find(q)
  }
  if (!hit) return null
  const { name, list, isType } = hit
  if (!m) return categoryMsgs(name, list, !isType)
  const star = STAR_NUM[m[1] || m[2]] || Number(m[1])
  const picked = list.filter(x => x.star === star)
  return picked.length ? starMsgs(name, star, picked) : [`「${name}」没有${STAR_COLORS[star]}（${STAR_NAMES[star]}）条目`]
}

/** 属于 skipCategories 的条目不响应，交给其他插件 */
const skipped = entry => (getConfig().skipCategories || []).some(c => entry.path.includes(c))

/** 能否直接发名称查询：分类在 bareCategories 内，且不在 strictTitles 里 */
function bareAllowed (entry) {
  const cfg = getConfig()
  const cats = cfg.bareCategories
  if (Array.isArray(cats) && !cats.some(c => entry.path.includes(c))) return false
  const t = norm(entry.title)
  return !(cfg.strictTitles || []).some(x => norm(x) === t)
}

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
      { reg: '^#?(原神)?更新图鉴目录$', fnc: 'updateVersions', permission: 'master' },
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
      priority: cfg.priority ?? -100,
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
    // e.msg 不是字符串时（比如纯图片/卡片消息），正则 test() 会把它当成字符串 "undefined"/"null" 误匹配上这条兜底规则
    if (typeof this.e.msg !== 'string') return false
    return this.query(this.e.msg.replace(/^[#/]/, ''), { bare: true, plain: !/^[#/]/.test(this.e.msg) })
  }

  /** bare：只在命中条目时回复（partial 允许名称的一部分）；loose：没命中时放行。两者都不提示“没找到”；plain：不认弱别名 */
  async query (q, { bare = false, loose = false, partial = false, plain = false } = {}) {
    q = String(q).trim()
    if (!q || q.length > 30) return false

    let index
    try {
      index = await source.getIndex()
    } catch (err) {
      if (bare) return false
      logger.error(err)
      return this.reply(`观测枢目录拉取失败：${err.message}`)
    }

    if (bare && !partial && !mayHit(q, index, plain)) return false
    const res = lookup(q, index, plain)

    if (res.type === 'hit' && skipped(res.entry)) return false
    if (bare) return res.type === 'hit' && (partial || res.via !== 'partial') && bareAllowed(res.entry) ? this.sendEntry(res.entry, false, res.dish) : false
    if (res.type === 'hit' && res.via !== 'partial') return this.sendEntry(res.entry, false, res.dish)

    const cat = categoryReply(q, index)
    if (cat) return sendMany(this.e, cat, `${q}图鉴`, true)
    if (res.type === 'hit') return this.sendEntry(res.entry, false, res.dish)

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

  /** 重新拉取目录，顺带同步一次版本表（genshin-db）；两边各自失败不互相影响 */
  async update () {
    const force = this.e.msg.includes('强制')
    if (force) source.clearDetails()
    const lines = []
    try {
      const index = await source.getIndex(true)
      lines.push(`目录已更新，共 ${index.length} 条${force ? '；详情缓存已清空' : ''}`)
    } catch (err) {
      lines.push(`目录更新失败：${err.message}`)
    }
    try {
      lines.push(...formatSyncResult(await syncVersions(GAME)))
    } catch (err) {
      lines.push(`版本表同步失败：${err.message}`)
    }
    return sendMany(this.e, lines, '图鉴更新')
  }

  /** 立即从 genshin-db 同步一次版本表，方便刚出新武器/圣遗物时马上更新，不用等到当天自动同步的时间 */
  async updateVersions () {
    let result
    try {
      result = await syncVersions(GAME)
    } catch (err) {
      return this.reply(`版本表同步失败：${err.message}`)
    }
    return sendMany(this.e, formatSyncResult(result), '版本表更新', true)
  }

  /** 不带名称清空全部详情缓存；带名称只清这一条；都只清缓存，不生成图，下次查询时重新拉取 */
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
    return this.reply(`已清空「${res.entry.title}」的详情缓存，下次查询时重新拉取`)
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
