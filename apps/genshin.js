import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName } from '../model/config.js'
import { ObcSource } from '../model/obc.js'
import { matchEntry, listCategory, getAliases } from '../model/match.js'
import { renderEntry } from '../model/render.js'

const GAME = 'gs'
const source = new ObcSource(GAME)

/** 清理旧版本留下的图片缓存目录 */
fs.rmSync(path.join(dataRoot, GAME, 'render'), { recursive: true, force: true })

const HELP = [
  '【观测枢图鉴 · 原神】',
  '#胡桃图鉴 或 #图鉴胡桃：查询条目',
  '#武器图鉴：列出某个分类下的全部条目',
  '#图鉴分类：看看有哪些分类',
  '#图鉴更新：重新拉取目录（主人）',
  '#图鉴强制更新：清空全部数据缓存（主人）',
  '#图鉴清除缓存：清空全部条目详情缓存（主人）',
  '#图鉴清除缓存胡桃：重新拉取该条目并生成（主人）',
  '#图鉴调试胡桃：导出原始数据（主人）'
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
      { reg: '^#(原神)?图鉴(帮助|help)?$', fnc: 'help' },
      { reg: '^#(原神)?图鉴(强制)?更新$', fnc: 'update', permission: 'master' },
      { reg: '^#(原神)?图鉴调试\\s*\\S.*$', fnc: 'debug', permission: 'master' },
      { reg: '^#(原神)?图鉴清除缓存.*$', fnc: 'clearCache', permission: 'master' },
      { reg: '^#(原神)?图鉴(分类|目录)$', fnc: 'categories' },
      { reg: '^#(原神)?图鉴\\s*\\S.*$', fnc: 'queryPrefix' },
      { reg: '^#.+图鉴$', fnc: 'querySuffix' }
    ]
    if (cfg.bareMatch) rule.push({ reg: '^#[^#\\s]{1,15}$', fnc: 'queryBare' })
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
    return this.query(this.e.msg.replace(/^#(原神)?图鉴\s*/, ''))
  }

  async querySuffix () {
    if (/^#(强制)?更新图鉴$/.test(this.e.msg)) return false
    return this.query(this.e.msg.replace(/^#(原神)?/, '').replace(/\s*图鉴$/, ''), { loose: true })
  }

  async queryBare () {
    return this.query(this.e.msg.replace(/^#/, ''), { bare: true })
  }

  /** bare：#名称；loose：#名称图鉴。两者没命中都放行给其他插件 */
  async query (q, { bare = false, loose = false } = {}) {
    q = String(q).trim()
    if (!q || q.length > 30) return false

    let index
    try {
      index = await source.getIndex()
    } catch (err) {
      logger.error(err)
      return bare ? false : this.reply(`观测枢目录拉取失败：${err.message}`)
    }

    const game = getConfig().games[GAME]
    const res = matchEntry(q, index, { aliases: getAliases(GAME), priority: game.categoryPriority || [] })

    if (bare) return res.type === 'hit' && res.via !== 'partial' ? this.sendEntry(res.entry) : false
    if (res.type === 'hit') return this.sendEntry(res.entry)

    const cat = listCategory(q, index)
    if (cat) {
      const text = `「${q}」共 ${cat.length} 条，发送 #名称图鉴 查看：\n${cat.join('、')}`
      return sendMany(this.e, chunkText(text), q)
    }

    if (res.type === 'multi') {
      return this.reply(`「${q}」对应多个条目，写完整一点：\n${res.list.map(x => x.title).join('、')}`)
    }
    if (loose) return false
    if (res.suggest.length) {
      return this.reply(`没找到「${q}」，你要找的是不是：${res.suggest.map(x => x.title).join('、')}`)
    }
    return this.reply(`没找到「${q}」。发送 #图鉴分类 可以看有哪些分类`)
  }

  async sendEntry (entry, force = false) {
    let content
    try {
      content = await source.getDetail(entry.id, force)
    } catch (err) {
      logger.error(err)
      return this.reply(`获取「${entry.title}」失败：${err.message}`)
    }

    let imgs
    try {
      imgs = await renderEntry(GAME, entry, content, {
        onStart: () => getConfig().renderTip && this.reply(`正在生成「${entry.title}」，请稍候…`)
      })
    } catch (err) {
      logger.error(err)
      return this.reply(`「${entry.title}」渲染失败：${err.message}`)
    }
    return sendMany(this.e, imgs.map(buf => segment.image(buf)), entry.title)
  }

  async update () {
    const force = this.e.msg.includes('强制')
    if (force) source.clearDetails()
    try {
      const index = await source.getIndex(true)
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
    const game = getConfig().games[GAME]
    const res = matchEntry(q, index, { aliases: getAliases(GAME), priority: game.categoryPriority || [] })
    if (res.type !== 'hit') return this.reply(`没找到唯一条目「${q}」`)
    source.clearDetails(res.entry.id)
    return this.sendEntry(res.entry, true)
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
    const game = getConfig().games[GAME]
    const res = matchEntry(q, index, { aliases: getAliases(GAME), priority: game.categoryPriority || [] })
    if (res.type !== 'hit') return this.reply(`没找到唯一条目「${q}」`)
    try {
      content = await source.getDetail(res.entry.id, true)
    } catch (err) {
      return this.reply(`详情拉取失败：${err.message}`)
    }

    const file = path.join(ensureDir(path.join(dataRoot, GAME, 'debug')), `${res.entry.id}.json`)
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
    const rawFile = file.replace(/\.json$/, '.raw.json')
    try {
      fs.writeFileSync(rawFile, JSON.stringify(await source.getRawDetail(res.entry.id), null, 2))
    } catch (err) {
      logger.warn(`[${pluginName}] 原始数据导出失败：${err.message}`)
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
      `接口原始数据：${path.relative(process.cwd(), rawFile)}`
    ]
    return sendMany(this.e, chunkText(lines.join('\n')), '图鉴调试')
  }
}
