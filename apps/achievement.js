import fs from 'node:fs'
import path from 'node:path'
import { getConfig, dataRoot, ensureDir, pluginName, pluginRoot } from '../model/config.js'
import { norm } from '../model/match.js'
import { renderTemplate } from '../model/render.js'
import { getAchievements, syncAchievements, syncing, formatSync, scheduleAchievementSync } from '../model/achievement/data.js'
import { parseFile, parseText } from '../model/achievement/importer.js'
import { loadRecord, applyImport, markIds, deleteRecord, toUiaf } from '../model/achievement/store.js'

/**
 * 成就：查询、查漏、统计、录入。
 * 数据来自 genshin-db（见 model/achievement/data.js），和图鉴的观测枢目录完全分开：
 * 配置里 excludeCategories 默认屏蔽的「成就」只是让 #xx图鉴 不去查观测枢的成就条目，不影响这里。
 */

const GAME = 'gs'
const TPL = path.join(pluginRoot, 'resources', 'achievement', 'achievement.html')
const MAX_FILE = 10 * 1024 * 1024

const acfg = () => getConfig().achievement || {}
const enabled = () => acfg().enable !== false

if (enabled()) scheduleAchievementSync(GAME)

const HELP = [
  '【成就 · 原神】数据整理自 genshin-db，按游戏内成就 ID 记录',
  '#成就录入：发送后再发椰羊导出的 xlsx 表格或 UIAF json 文件（群里官方 Bot 收不到不带 @ 的文件，建议私聊）；',
  '　也可以直接 #成就录入 后面贴 UIAF JSON，或贴一串成就 ID（只追加不覆盖）',
  '#成就查漏：列出没完成的成就；后面可以加特辑名、版本、隐藏、页码，如 #成就查漏 至冬、#成就查漏 6.0、#成就查漏 2',
  '#成就统计：各特辑完成进度',
  '#成就查询 关键词：按名称、描述或 ID 搜索，如 #成就查询 甘撒、#成就 登月；发特辑名（#成就查询 天地万象）看整个特辑',
  '#成就完成 名称或ID / #成就取消 名称或ID：手动标记，可以一次写多个（空格分开）',
  '#成就导出：导出成 UIAF json 文件（可导入椰羊、胡桃工具箱）',
  '#清空成就记录：删除自己的成就记录',
  '#成就更新：立即从 genshin-db 同步成就数据（主人；插件每天也会自动同步）'
].join('\n')

const fmtTime = ms => ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : ''

/** 完成度：没全部完成时不四舍五入到 100% */
function percent (done, total) {
  if (!total) return '0'
  const p = Math.floor(done / total * 1000) / 10
  return String(done < total ? Math.min(p, 99.9) : 100)
}

function summarize (data, rec) {
  let done = 0
  let primoDone = 0
  let primoAll = 0
  for (const a of data.list) {
    primoAll += a.primo
    if (rec?.done.has(a.id)) {
      done++
      primoDone += a.primo
    }
  }
  const total = data.list.length
  return { done, total, missing: total - done, pct: percent(done, total), primoDone, primoMissing: primoAll - primoDone }
}

/** 按特辑分组：groups 里每项带 done/total/missing/primoMissing，items 是传入的成就 */
function groupItems (data, items, rec) {
  const pick = new Map()
  for (const a of items) {
    if (!pick.has(a.groupId)) pick.set(a.groupId, [])
    pick.get(a.groupId).push(a)
  }
  return data.groups.filter(g => pick.has(g.id)).map(g => ({ ...groupProgress(data, g, rec), items: pick.get(g.id) }))
}

function groupProgress (data, g, rec) {
  let done = 0
  let primoMissing = 0
  for (const a of data.list) {
    if (a.groupId !== g.id) continue
    if (rec?.done.has(a.id)) done++
    else primoMissing += a.primo
  }
  return { name: g.name, id: g.id, total: g.total, done, missing: g.total - done, primoMissing, pct: percent(done, g.total) }
}

/** 特辑关键词 → 特辑列表：完全一致优先，其次包含（比如「至冬」匹配到两个至冬特辑） */
function findGroups (data, q) {
  const k = norm(q)
  if (!k) return []
  const exact = data.groups.filter(g => norm(g.name) === k)
  return exact.length ? exact : data.groups.filter(g => norm(g.name).includes(k))
}

/** 名称或 ID → 成就列表 */
function resolve (data, q) {
  q = String(q).trim()
  if (/^\d{5,6}$/.test(q)) return data.byId.has(Number(q)) ? [data.byId.get(Number(q))] : []
  const k = norm(q)
  return k ? data.list.filter(a => norm(a.title) === k) : []
}

/** 关键词搜索：ID → 名称完全一致 → 名称包含 → 描述包含 */
function search (data, q) {
  const exact = resolve(data, q)
  if (exact.length) return exact
  const k = norm(q)
  if (!k) return []
  const byTitle = data.list.filter(a => norm(a.title).includes(k))
  return byTitle.length ? byTitle : data.list.filter(a => norm(a.desc).includes(k))
}

const who = e => {
  const name = e.sender?.card || e.sender?.nickname || ''
  return name ? `${name}` : `用户 ${e.user_id}`
}

/** 图片超过 1 张时合并转发 */
async function sendImages (e, imgs, title) {
  const msgs = imgs.map(buf => segment.image(buf))
  if (msgs.length <= 1) return e.reply(msgs[0])
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

/** 消息里的文件段 → 下载地址（官方 Bot / OneBot 直接带 url；icqq 要用 fid 换） */
async function fileUrl (e, seg) {
  for (const v of [seg.url, seg.file]) if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  const fid = seg.fid || seg.file_id
  const target = e.isGroup ? e.group : e.friend
  if (fid && typeof target?.getFileUrl === 'function') return target.getFileUrl(fid)
  for (const v of [seg.path, seg.file]) if (typeof v === 'string' && fs.existsSync(v)) return v
  return ''
}

async function download (url) {
  if (!/^https?:\/\//.test(url)) return fs.readFileSync(url)
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length'))
  if (len > MAX_FILE) throw new Error('文件太大了（超过 10MB），不像是成就存档')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_FILE) throw new Error('文件太大了（超过 10MB），不像是成就存档')
  return buf
}

/** 当前消息、以及它回复的那条消息里的文件段 */
async function fileSegments (e) {
  const segs = (Array.isArray(e.message) ? e.message : []).filter(m => m?.type === 'file')
  if (segs.length) return segs
  try {
    const reply = typeof e.getReply === 'function' ? await e.getReply() : null
    return (Array.isArray(reply?.message) ? reply.message : []).filter(m => m?.type === 'file')
  } catch {
    return []
  }
}

export class TomatoAchievement extends plugin {
  constructor () {
    const cfg = getConfig()
    super({
      name: '观测枢图鉴·成就',
      dsc: '原神成就查询、查漏、录入',
      event: 'message',
      // 比图鉴查询再靠前一点：#成就图鉴 之类的消息别被图鉴的模糊匹配接走
      priority: (cfg.priority ?? -100) - 1,
      rule: [
        { reg: '^#(原神)?成就(帮助|菜单|help|功能|图鉴)$', fnc: 'help' },
        { reg: '^#(原神)?成就(数据)?(强制)?更新$', fnc: 'sync', permission: 'master' },
        { reg: '^#(原神)?成就(录入|导入|上传)([\\s\\S]*)$', fnc: 'importCmd' },
        { reg: '^#(原神)?成就(查漏|缺失|未完成)(.*)$', fnc: 'missing' },
        { reg: '^#(原神)?(我的)?成就(统计|进度|总览)?$', fnc: 'stats' },
        { reg: '^#(原神)?成就(完成|标记|打卡)\\s*(.+)$', fnc: 'markDone' },
        { reg: '^#(原神)?成就(取消|撤销)(完成|标记)?\\s*(.+)$', fnc: 'markUndone' },
        { reg: '^#(原神)?成就导出$', fnc: 'exportCmd' },
        { reg: '^#(原神)?(清空|删除)(我的)?成就(记录|存档)$', fnc: 'clear' },
        { reg: '^#(原神)?成就(查询|搜索|查找)?\\s*(.+)$', fnc: 'query' }
      ]
    })
  }

  /** 成就数据；还没同步过时顺手开始同步并提示 */
  async data () {
    const data = getAchievements(GAME)
    if (data) return data
    if (!syncing(GAME)) syncAchievements(GAME).catch(err => logger.warn(`[${pluginName}] 成就数据同步失败：${err.message}`))
    await this.reply('成就数据还没同步完成（首次需要一两分钟从 genshin-db 下载），请稍后再试')
    return null
  }

  async help () {
    if (!enabled()) return false
    return this.reply(HELP)
  }

  async sync () {
    if (!enabled()) return false
    const force = this.e.msg.includes('强制')
    await this.reply(`开始${force ? '重新下载全部' : '同步'}成就数据…`)
    try {
      return this.reply(formatSync(await syncAchievements(GAME, { force })))
    } catch (err) {
      return this.reply(`成就数据同步失败：${err.message}`)
    }
  }

  // ---------- 录入 ----------

  async importCmd () {
    if (!enabled()) return false
    const text = this.e.msg.replace(/^#(原神)?成就(录入|导入|上传)/, '').trim()
    if (await this.tryImport(text)) return true
    this.setContext('importContext', false, 120)
    return this.reply([
      '请在 2 分钟内发送成就存档：',
      '· 椰羊小程序导出的 xlsx 表格文件',
      '· 或 UIAF 格式的 json 文件 / 直接粘贴 JSON 文本（椰羊、胡桃工具箱、寻空等都能导出）',
      '· 或一串成就 ID（只追加，不覆盖已有记录）',
      '发送「取消」退出。群里官方 Bot 收不到不带 @ 的文件，建议私聊发送'
    ].join('\n'))
  }

  async importContext () {
    const e = this.e
    const text = typeof e.msg === 'string' ? e.msg.trim() : ''
    if (/^#?(取消|算了|退出)$/.test(text)) {
      this.finish('importContext')
      return this.reply('已取消成就录入')
    }
    // 发了别的指令：退出录入，免得一直卡在这里
    if (/^[#/]/.test(text) && !/^#(原神)?成就(录入|导入|上传)/.test(text)) {
      this.finish('importContext')
      return this.reply('已退出成就录入，需要时再发 #成就录入')
    }
    if (await this.tryImport(text.replace(/^#(原神)?成就(录入|导入|上传)/, '').trim())) {
      this.finish('importContext')
      return true
    }
    return this.reply('没收到文件或可识别的内容，请发送 xlsx / json 文件，或发送「取消」退出')
  }

  /** 从当前消息里找文件 / 链接 / 文本并导入；什么都没有返回 false */
  async tryImport (text) {
    const e = this.e
    let parsed
    let from = ''
    try {
      const segs = await fileSegments(e)
      if (segs.length) {
        const seg = segs[0]
        const url = await fileUrl(e, seg)
        if (!url) throw new Error('当前适配器拿不到文件下载地址，可以把 JSON 内容直接粘贴发送')
        from = seg.name || '文件'
        parsed = parseFile(await download(url), from)
      } else if (/^https?:\/\/\S+$/.test(text)) {
        from = '链接'
        parsed = parseFile(await download(text), text)
      } else if (text) {
        from = '文本'
        parsed = parseText(text)
        // 既不是 JSON 也没有成就 ID 的文字，当作没发存档
        if (!parsed.replace && !parsed.done.size) return false
      } else {
        return false
      }
    } catch (err) {
      await this.reply(`成就存档解析失败：${err.message}`)
      return true
    }

    const data = await this.data()
    if (!data) return true
    if (!parsed.done.size && !parsed.undone.size) {
      await this.reply('没有识别到任何成就，请确认是椰羊导出的表格或 UIAF 格式的存档')
      return true
    }
    const { record, added, removed, unknown } = applyImport(GAME, e.user_id, parsed, data.byId, parsed.format)
    const sum = summarize(data, record)
    const lines = [
      `成就录入成功（${parsed.format}${from && from !== '文本' ? `，${from}` : ''}）`,
      parsed.replace ? `已按存档覆盖原有记录：新增完成 ${added} 个${removed ? `，取消 ${removed} 个` : ''}` : `追加完成 ${added} 个`,
      `当前进度 ${sum.done}/${sum.total}（${sum.pct}%），未完成 ${sum.missing} 个，还能拿 ${sum.primoMissing} 原石`
    ]
    if (unknown) lines.push(`有 ${unknown} 个 ID 不在当前成就数据里（可能是新版本成就，数据更新后会自动算上）`)
    lines.push('发送 #成就查漏 查看未完成的成就')
    await this.reply(lines.join('\n'))
    return true
  }

  // ---------- 查漏 / 统计 / 查询 ----------

  /** #成就查漏 [特辑] [版本] [隐藏] [页码] */
  async missing () {
    if (!enabled()) return false
    const data = await this.data()
    if (!data) return true
    const rec = loadRecord(GAME, this.e.user_id)
    if (!rec) return this.reply('你还没有录入成就，发送 #成就录入 导入椰羊等工具导出的存档')

    let arg = this.e.msg.replace(/^#(原神)?成就(查漏|缺失|未完成)/, '').trim()
    let page = 1
    const pm = arg.match(/(?:^|\s|第)(\d{1,3})\s*页?$/)
    if (pm && !/\d+\.\d*$/.test(arg)) {
      page = Math.max(1, Number(pm[1]))
      arg = arg.slice(0, pm.index).trim()
    }
    let version = ''
    arg = arg.replace(/(\d+)\.(\d+|x)\s*(版本)?/i, (_, a, b) => { version = `${a}.${b.toLowerCase()}`; return ' ' }).trim()
    let hiddenOnly = false
    arg = arg.replace(/隐藏(成就)?/, () => { hiddenOnly = true; return ' ' }).trim()

    let pool = data.list.filter(a => !rec.done.has(a.id))
    const conds = []
    if (arg) {
      const groups = findGroups(data, arg)
      if (!groups.length) return this.reply(`没有找到特辑「${arg}」，发送 #成就统计 可以看全部特辑`)
      const ids = new Set(groups.map(g => g.id))
      pool = pool.filter(a => ids.has(a.groupId))
      conds.push(`特辑 <b>${groups.map(g => g.name).join('、')}</b>`)
    }
    if (version) {
      pool = pool.filter(a => version.endsWith('.x') ? a.version.split('.')[0] === version.split('.')[0] : a.version === version)
      conds.push(`版本 <b>${version}</b>`)
    }
    if (hiddenOnly) {
      pool = pool.filter(a => a.hidden)
      conds.push('<b>隐藏成就</b>')
    }

    const size = Math.max(10, Number(acfg().pageSize) || 40)
    const pages = Math.max(1, Math.ceil(pool.length / size))
    if (page > pages) return this.reply(`一共只有 ${pages} 页`)
    const items = pool.slice((page - 1) * size, page * size)
    const primo = pool.reduce((n, a) => n + a.primo, 0)
    const filterParts = []
    if (conds.length) filterParts.push(`筛选：${conds.join(' · ')}`)
    if (conds.length || pages > 1) filterParts.push(`共 <b>${pool.length}</b> 个未完成，<b>${primo}</b> 原石`)
    if (pages > 1) filterParts.push(`第 <b>${page}</b>/${pages} 页`)

    const tips = []
    if (pages > page) tips.push(`下一页发送 <b>#成就查漏${arg ? ` ${arg}` : ''}${version ? ` ${version}` : ''}${hiddenOnly ? ' 隐藏' : ''} ${page + 1}</b>`)
    if (!conds.length && pool.length > size) tips.push('未完成的太多了，可以按特辑查：<b>#成就查漏 天地万象</b>；或按版本：<b>#成就查漏 6.x</b>')
    tips.push('完成了可以发 <b>#成就完成 ID</b> 标记，或者重新 <b>#成就录入</b> 最新存档')

    return this.renderSend('missing', {
      mode: 'missing',
      title: '成就查漏',
      filter: filterParts.join('；'),
      groups: groupItems(data, items, rec),
      empty: conds.length ? '这个范围内的成就都完成啦' : '全部成就都完成啦！',
      tips
    }, data, rec)
  }

  async stats () {
    if (!enabled()) return false
    const data = await this.data()
    if (!data) return true
    const rec = loadRecord(GAME, this.e.user_id)
    if (!rec) return this.reply(`你还没有录入成就。\n${HELP}`)
    return this.renderSend('stats', {
      mode: 'stats',
      title: '成就统计',
      // 没完成的特辑排前面，全部完成的放后面
      sections: (() => {
        const all = data.groups.map(g => groupProgress(data, g, rec))
        const todo = all.filter(g => g.missing)
        const full = all.filter(g => !g.missing)
        return [
          todo.length && { title: `未完成的特辑（${todo.length}）`, groups: todo },
          full.length && { title: `已全部完成（${full.length}）`, groups: full }
        ].filter(Boolean)
      })(),
      tips: ['发送 <b>#成就查漏</b> 看没完成的成就，<b>#成就查漏 特辑名</b> 只看某个特辑']
    }, data, rec)
  }

  async query () {
    if (!enabled()) return false
    const m = this.e.msg.match(/^#(原神)?成就(查询|搜索|查找)?\s*(.+)$/)
    const explicit = !!m?.[2]
    const q = m?.[3]?.trim() || ''
    if (!q || q.length > 30) return false
    // 不带「查询」的 #成就xxx：只认 ID、完整的成就名或特辑名，对不上就放行，免得抢了别的插件的指令
    const data = explicit ? await this.data() : getAchievements(GAME)
    if (!data) return explicit

    const rec = loadRecord(GAME, this.e.user_id)
    // ID / 完整成就名 → 特辑名（完整或部分，如「至冬」）→ 成就名包含 → 描述包含；不带「查询」时只认前两种完整写法
    const groups = findGroups(data, q)
    const exactGroup = groups.length === 1 && norm(groups[0].name) === norm(q)
    const inGroups = gs => data.list.filter(a => gs.some(g => g.id === a.groupId))
    let list = resolve(data, q)
    if (!list.length && (exactGroup || (explicit && groups.length))) list = inGroups(groups)
    if (!list.length && explicit) list = search(data, q)
    if (!list.length) return explicit ? this.reply(`没找到和「${q}」有关的成就`) : false

    if (list.length <= 3) return this.reply(list.map(a => this.textOf(a, rec)).join('\n\n'))

    const size = Math.max(10, Number(acfg().pageSize) || 40) * 2
    const shown = list.slice(0, size)
    return this.renderSend('search', {
      mode: 'search',
      title: '成就查询',
      hasRecord: !!rec,
      filter: `「<b>${q.replace(/[<>&]/g, '')}</b>」共 <b>${list.length}</b> 个成就${list.length > shown.length ? `，只显示前 ${shown.length} 个，写具体一点可以缩小范围` : ''}`,
      groups: groupItems(data, shown, rec).map(g => ({ ...g, items: g.items.map(a => ({ ...a, done: !!rec?.done.has(a.id) })) })),
      tips: rec ? [] : ['录入成就后可以看到每个成就是否完成：<b>#成就录入</b>']
    }, data, rec)
  }

  textOf (a, rec) {
    const tags = [a.group, a.stages > 1 ? `第 ${a.stage}/${a.stages} 阶段` : '', a.hidden ? '隐藏成就' : '', a.version ? `${a.version} 版本` : ''].filter(Boolean)
    const lines = [`【${a.title}】#${a.id}`, tags.join(' · '), a.desc, `奖励：原石 ×${a.primo}`]
    if (rec) lines.push(`状态：${rec.done.has(a.id) ? '✅ 已完成' : '❌ 未完成'}`)
    return lines.join('\n')
  }

  async renderSend (id, view, data, rec) {
    try {
      const imgs = await renderTemplate(GAME, { id: `achievement_${id}`, title: view.title }, TPL, {
        who: who(this.e),
        summary: summarize(data, rec),
        syncedAt: fmtTime(data.syncedAt),
        updatedAt: fmtTime(rec?.updatedAt),
        ...view
      }, { multiPage: true, width: 800 })
      return sendImages(this.e, imgs, view.title)
    } catch (err) {
      logger.error(err)
      return this.reply(`${view.title}图片生成失败：${err.message}`)
    }
  }

  // ---------- 手动标记 / 导出 / 清空 ----------

  async markDone () {
    return this.mark(true, this.e.msg.replace(/^#(原神)?成就(完成|标记|打卡)/, ''))
  }

  async markUndone () {
    return this.mark(false, this.e.msg.replace(/^#(原神)?成就(取消|撤销)(完成|标记)?/, ''))
  }

  async mark (done, arg) {
    if (!enabled()) return false
    const data = await this.data()
    if (!data) return true
    arg = arg.trim()
    // 整句先当成一个名称（有的成就名带空格），对不上再按空格、逗号拆开
    const tokens = resolve(data, arg).length ? [arg] : arg.split(/[\s,，、]+/).filter(Boolean)
    const ids = []
    const problems = []
    for (const t of tokens) {
      const hit = resolve(data, t)
      if (hit.length === 1) ids.push(hit[0].id)
      else if (hit.length > 1) problems.push(`「${t}」有 ${hit.length} 个阶段，请用 ID：${hit.map(a => `${a.id}（${a.desc}）`).join('；')}`)
      else problems.push(`没找到「${t}」${/^\d+$/.test(t) ? '' : '，可以先 #成就查询 关键词 找到 ID'}`)
    }
    const changed = ids.length ? markIds(GAME, this.e.user_id, ids, done) : []
    const lines = []
    if (changed.length) lines.push(`已${done ? '标记完成' : '取消完成'}：${changed.map(id => data.byId.get(id)?.title || id).join('、')}`)
    const same = ids.filter(id => !changed.includes(id))
    if (same.length) lines.push(`本来就${done ? '已完成' : '未完成'}：${same.map(id => data.byId.get(id)?.title || id).join('、')}`)
    lines.push(...problems)
    if (changed.length) {
      const sum = summarize(data, loadRecord(GAME, this.e.user_id))
      lines.push(`当前进度 ${sum.done}/${sum.total}（${sum.pct}%）`)
    }
    return this.reply(lines.join('\n'))
  }

  async exportCmd () {
    if (!enabled()) return false
    const data = await this.data()
    if (!data) return true
    const rec = loadRecord(GAME, this.e.user_id)
    if (!rec) return this.reply('你还没有录入成就')
    const dir = ensureDir(path.join(dataRoot, GAME, 'achievement', 'export'))
    const file = path.join(dir, `uiaf_${String(this.e.user_id).replace(/[^\w-]/g, '_')}.json`)
    let ver = ''
    try {
      ver = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version || ''
    } catch {}
    fs.writeFileSync(file, JSON.stringify(toUiaf(rec, data, ver)))
    try {
      if (typeof segment !== 'undefined' && typeof segment.file === 'function') {
        await this.reply(segment.file(file, `成就UIAF_${new Date().toISOString().slice(0, 10)}.json`))
        return true
      }
      if (this.e.isGroup && typeof this.e.group?.sendFile === 'function') return await this.e.group.sendFile(file)
      if (typeof this.e.friend?.sendFile === 'function') return await this.e.friend.sendFile(file)
    } catch (err) {
      logger.warn(`[${pluginName}] 发送成就导出文件失败：${err.message}`)
    }
    return this.reply('当前适配器不支持发送文件，请联系主人到 data 目录下取出导出文件')
  }

  async clear () {
    if (!enabled()) return false
    return this.reply(deleteRecord(GAME, this.e.user_id) ? '已删除你的成就记录' : '你还没有成就记录')
  }
}
