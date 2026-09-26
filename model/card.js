import { sanitizeHtml } from './sanitize.js'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const isUrl = s => typeof s === 'string' && /^https?:\/\//i.test(s.trim())
const flat = x => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) ? [].concat(x.value ?? []).join('') : x

/** 正文清洗：去掉内联样式和高亮标记，统一交给模板排版 */
function clean (html) {
  return sanitizeHtml(html)
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/<\/?(mark|span|a)\b[^>]*>/gi, '')
    .replace(/<p[^>]*>(\s|&nbsp;|<br[^>]*>)*<\/p>/gi, '')
    .trim()
}

const STAR_WORDS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 }
const starOf = v => {
  const m = String(v ?? '').match(/([一二三四五1-5])\s*星/)
  return m ? STAR_WORDS[m[1]] || Number(m[1]) : 0
}
const tag = (entry, ...keys) => (entry.tags || []).find(t => keys.includes(t.k))?.v || ''

/** 旧版正文里 obc-tmpl 组件的 data-data（URL 编码的 JSON） */
export function parseParts (content) {
  const out = []
  for (const s of Array.isArray(content?.contents) ? content.contents : []) {
    for (const m of String(s?.text ?? '').matchAll(/data-data="([^"]+)"/g)) {
      try {
        for (const p of [].concat(JSON.parse(decodeURIComponent(m[1])))) if (p?.tmplKey) out.push(p)
      } catch {}
    }
  }
  return out
}

const block = (title, body, cls = '') => body ? `<div class="card block ${cls}">${title ? `<h2>${esc(title)}</h2>` : ''}${body}</div>` : ''
const textBlock = (title, html, cls = '') => html ? block(title, `<div class="rich fit">${html}</div>`, cls) : ''
const rowsBlock = (title, rows, cls = '') => {
  const body = rows.filter(r => r.html).map(r => `<div class="row"><span class="row-k">${esc(r.k)}</span><div class="row-v rich">${r.html}</div></div>`).join('')
  return body ? block(title, `<div class="fit">${body}</div>`, cls) : ''
}
const iconsBlock = (title, items, cls = '') => {
  const body = items.filter(i => i.name || i.img).map(i =>
    `<div class="icon-cell"><div class="tile">${isUrl(i.img) ? `<img src="${esc(i.img)}">` : ''}${i.num ? `<span class="num">${esc(i.num)}</span>` : ''}</div><span class="icon-name">${esc(i.name)}</span></div>`
  ).join('')
  return body ? block(title, `<div class="icons">${body}</div>`, cls) : ''
}
const tagsBlock = (title, items, cls = '') => {
  const body = items.filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('')
  return body ? block(title, `<div class="tags">${body}</div>`, cls) : ''
}
const piecesBlock = pieces => pieces.length
  ? `<div class="pieces">${pieces.map(p =>
    `<div class="piece"><div class="piece-art">${isUrl(p.img) ? `<img src="${esc(p.img)}">` : ''}</div><div class="piece-name">${esc(p.name)}</div><div class="piece-slot">${esc(p.slot)}</div><div class="piece-desc">${esc(p.desc)}</div></div>`
  ).join('')}</div>`
  : ''

/** 页面里的词条卡片（custom-entry-wrapper），取名称和图片 */
function entryCards (html) {
  const out = []
  for (const [t] of String(html ?? '').matchAll(/<span\b[^>]*class="[^"]*custom-entry-wrapper[^"]*"[^>]*>/g)) {
    const name = strip(t.match(/data-entry-name="([^"]+)"/)?.[1])
    const img = t.match(/data-entry-img="([^"]+)"/)?.[1]
    if (name && img && !out.some(c => c.name === name)) out.push({ name, img })
  }
  return out
}

const chip = (k, v) => {
  const t = strip(v)
  return t ? { k, v: t, wide: t.length > 10 } : null
}

/** 道具字段：新版 material_base_info 组件，旧版 material 模板 */
function materialInfo (content) {
  const ws = Array.isArray(content?.widgets) ? content.widgets : []
  const main = ws.find(w => w.id === 'material_base_info' && w.data?.name)
  if (main) {
    const d = main.data
    const fields = {}
    for (const a of Array.isArray(d.attr) ? d.attr : []) fields[strip(a.key)] = clean([].concat(a.value ?? []).join(''))
    return { name: strip(d.name), image: d.img || d.image || content.icon, star: Number(d.star) || 0, fields }
  }
  const part = parseParts(content).find(p => p.tmplKey === 'material' && p.partKey === 'main')
  if (!part) return null
  const d = part.data || {}
  const fields = {}
  for (const c of Array.isArray(d.content) ? d.content : []) fields[strip(c.name)] = clean(c.content)
  if (d.proceed) fields['获得方式'] = clean(d.proceed)
  return { name: strip(d.name), image: d.image || content.icon, star: 0, fields }
}

const FOOD_TIERS = ['奇怪', '普通', '美味', '特色']

/** 加工材料 HTML 拆成 [{ name, num, img }]：优先读词条卡片的 data-entry-*，其次按 <img>鸟蛋*4 的文字 */
function materialList (html) {
  const h = String(html ?? '')
  const out = []
  for (const [t] of h.matchAll(/<span\b[^>]*class="[^"]*custom-entry-wrapper[^"]*"[^>]*>/g)) {
    const name = strip(t.match(/data-entry-name="([^"]+)"/)?.[1])
    if (name) out.push({ name, num: strip(t.match(/data-entry-amount="([^"]+)"/)?.[1]), img: t.match(/data-entry-img="([^"]+)"/)?.[1] })
  }
  if (out.length) return out
  for (const m of h.matchAll(/<img[^>]*src="([^"]+)"[^>]*>([\s\S]*?)(?=<img|$)/gi)) {
    const t = strip(m[2]).match(/^(.+?)\s*[*×xX]\s*(\d+)/)
    if (t) out.push({ img: m[1], name: t[1].trim(), num: t[2] })
  }
  if (!out.length) {
    for (const t of strip(h).matchAll(/([^\s*×，,、；;]+)\s*[*×]\s*(\d+)/g)) out.push({ name: t[1], num: t[2] })
  }
  return out
}

/** 效果段落拆成 效果行 / 获得方式 / 食谱获取 */
function splitEffect (html) {
  const out = { effect: [], obtain: '', recipe: '' }
  const paras = [...String(html ?? '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1])
  for (const p of paras.length ? paras : [html]) {
    const t = strip(p)
    if (/^获得方式[：:]/.test(t)) out.obtain = t.replace(/^获得方式[：:]\s*/, '')
    else if (/^食谱获[得取][：:]/.test(t)) out.recipe = t.replace(/^食谱获[得取][：:]\s*/, '')
    else if (t) out.effect.push(t.replace(/^使用效果[：:]\s*/, ''))
  }
  return out
}

/** 食物各品质：旧版每个品质一个 food 模板，新版每个品质一个 material_base_info 组件 */
function foodItems (content) {
  const old = parseParts(content).filter(p => p.tmplKey === 'food' && p.data?.name).map(p => p.data)
  if (old.length) {
    return old.map(d => ({
      name: strip(d.name),
      img: d.image,
      star: Number(d.rate) || 0,
      desc: clean(d.description),
      mats: (d.material || []).map(m => ({ name: strip(m.name), num: strip(m.num) })),
      proceed: strip(d.proceed),
      ...splitEffect(d.effect)
    }))
  }
  const ws = Array.isArray(content?.widgets) ? content.widgets : []
  return ws.filter(w => w.id === 'material_base_info' && strip(w.data?.name)).map(w => {
    const d = w.data
    const f = {}
    for (const a of Array.isArray(d.attr) ? d.attr : []) f[strip(a.key)] = [].concat(a.value ?? []).join('')
    const eff = splitEffect(f['使用效果'])
    return {
      name: strip(d.name),
      img: d.img || d.image,
      star: Number(d.star) || 0,
      desc: clean(f['描述']),
      mats: materialList(d.materials?.value),
      proceed: '',
      effect: eff.effect,
      obtain: strip(f['获得方式']) || eff.obtain,
      recipe: strip(f['食谱获得'] || f['食谱获取']) || eff.recipe
    }
  })
}

/** 食物页里的各品质料理名（奇怪 / 美味 / 特色料理等），用来建立搜索别名 */
export function dishNames (content) {
  return foodItems(content).map(i => i.name).filter(Boolean)
}

const matsBlock = mats => {
  const list = mats.filter(m => m.name && m.name !== '无')
  return list.some(m => m.img)
    ? iconsBlock('加工材料', list)
    : tagsBlock('加工材料', list.map(m => `${m.name}${m.num ? ` ×${m.num}` : ''}`))
}

/** 单独一道料理（特色料理 / 奇怪 / 美味品质）的卡片，注明所属的原料理 */
function dishCard (entry, content, dish, normal) {
  const title = strip(entry.title)
  return {
    kind: '食物',
    name: dish.name,
    stars: dish.star || normal.star || starOf(tag(entry, '食物星级', '星级')),
    summary: `「${title}」的${dish.tier === '特色' ? '特色料理' : `${dish.tier}品质`}`,
    art: { mode: 'circle', images: [dish.img || normal.img || content.icon] },
    chips: [chip('获得方式', dish.obtain || dish.proceed), chip('食谱获取', dish.recipe || normal.recipe)],
    left: textBlock('', dish.desc, 'grow') + iconsBlock('原料理', [{ name: title, img: normal.img }], 'round'),
    right: rowsBlock('料理效果', [{ k: '效果', html: dish.effect.map(t => `<p>${esc(t)}</p>`).join('') }], 'grow') +
      matsBlock(dish.mats.length ? dish.mats : normal.mats)
  }
}

function food (entry, content, { dish } = {}) {
  const title = strip(entry.title)
  const tierOf = n => n.startsWith('奇怪的') ? '奇怪' : n.startsWith('美味的') ? '美味' : n === title ? '普通' : '特色'
  const items = foodItems(content)
    .map(i => ({ ...i, tier: tierOf(i.name) }))
    .sort((a, b) => FOOD_TIERS.indexOf(a.tier) - FOOD_TIERS.indexOf(b.tier))
  if (!items.length) return null
  const normal = items.find(i => i.tier === '普通') || items[0]
  const focus = dish && items.find(i => i.name === dish)
  if (focus && focus !== normal) return dishCard(entry, content, focus, normal)
  const single = items.length === 1
  const rows = items.map(i => ({
    k: single ? '效果' : i.tier,
    html: (i.tier === '特色' && !single ? `<p><b>${esc(i.name)}</b>${i.obtain ? `（${esc(i.obtain)}）` : ''}</p>` : '') + i.effect.map(t => `<p>${esc(t)}</p>`).join('')
  }))
  const specials = single ? [] : items.filter(i => i.tier === '特色').map(i => ({ name: i.name, img: i.img }))
  return {
    kind: '食物',
    name: title,
    stars: normal.star || starOf(tag(entry, '食物星级', '星级')),
    art: { mode: 'circle', images: [normal.img || content.icon] },
    chips: [chip('获得方式', normal.obtain || normal.proceed), chip('食谱获取', normal.recipe)],
    left: textBlock('', normal.desc, 'grow') + iconsBlock('特色料理', specials, 'round'),
    right: rowsBlock('料理效果', rows, 'grow') + matsBlock(normal.mats)
  }
}

function item (entry, content) {
  const info = materialInfo(content)
  if (!info) return null
  const f = info.fields
  return {
    kind: tag(entry, '道具类型') || '道具',
    name: info.name || entry.title,
    stars: info.star || starOf(tag(entry, '星级')),
    art: { mode: 'circle', images: [info.image] },
    chips: [chip('获取途径', tag(entry, '获取方式'))],
    left: textBlock('获得方式', f['获得方式'], 'grow'),
    right: rowsBlock('', Object.entries(f).filter(([k]) => k !== '获得方式').map(([k, html]) => ({ k, html })), 'grow')
  }
}

function monster (entry, content) {
  const parts = parseParts(content).filter(p => p.tmplKey === 'monster')
  const main = parts.find(p => p.partKey === 'main')?.data
  if (!main) return null
  const bg = parts.find(p => p.partKey === 'background')?.data || {}
  const raid = parts.find(p => p.partKey === 'raid')?.data || {}
  const fields = Object.fromEntries((main.fields || []).map(x => [strip(x.name), clean(x.value)]))
  const drops = (main.material || []).map(m => ({ name: strip(m.name), img: m.icon, num: strip(m.num) }))
  return {
    kind: '原魔',
    name: strip(main.name) || entry.title,
    stars: 0,
    summary: strip(bg.backgroundStory),
    art: { mode: 'frame', images: [main.preview?.[0]?.image || content.icon] },
    chips: [chip('类型', tag(entry, '类型')), chip('元素', fields['元素'] || tag(entry, '元素')), chip('所在区域', fields['所在区域'])],
    left: textBlock('攻略方法', clean(raid.content), 'grow'),
    right: iconsBlock('掉落物品', drops) + rowsBlock('', [{ k: '攻击方式', html: fields['攻击方式'] }, { k: '备注', html: clean(bg.remark) }], 'grow')
  }
}

function domain (entry, content) {
  const parts = parseParts(content)
  const mission = parts.find(p => p.tmplKey === 'mission' && p.partKey === 'main')?.data
  if (!mission) return null
  const attr = Object.fromEntries((mission.attr || []).map(a => [strip(a.name), strip(a.content)]))
  const maps = (parts.find(p => p.tmplKey === 'mission' && p.partKey === 'map')?.data?.content || []).map(x => x?.image).filter(isUrl).slice(0, 2)
  const levelsOf = key => parts.find(p => p.tmplKey === 'illustration' && strip(p.data?.title).includes(key))?.data?.data || []
  const extend = (row, labels, label) => {
    const i = (labels || []).indexOf(label)
    return i >= 0 ? strip(row?.[`extend_${i}_`]) : ''
  }

  const entrances = levelsOf('入口')
  const top = entrances[entrances.length - 1]
  const topRow = top?.data?.[0] || {}
  const labels = top?.['data.extend_']
  const lv = String(top?.name_ ?? '').match(/lv\s*\d+/i)?.[0]

  const waves = levelsOf('怪物')
  const wave = waves.find(w => w.name_ === top?.name_) || waves[waves.length - 1]
  const monsters = (wave?.data || []).map(m => {
    const num = extend(m, wave['data.extend_'], '数量')
    return { name: `${strip(m.name)}${num ? ` ×${num}` : ''}`, img: m.image }
  })

  const html = (content.contents || []).map(s => s.text || '').join('')
  const rewards = [...new Set([...html.slice(Math.max(0, html.indexOf('秘境奖励'))).matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map(m => strip(m[1])))]

  return {
    kind: '',
    name: `${attr['秘境名称'] || entry.title}${lv ? `·${lv}` : ''}`,
    stars: 0,
    summary: attr['秘境简述'],
    art: { mode: 'frame', images: maps.length ? maps : [content.icon] },
    chips: [
      chip('推荐元素', extend(topRow, labels, '推荐元素') || tag(entry, '推荐元素')),
      chip('冒险等级', extend(topRow, labels, '冒险等级要求')),
      chip('秘境消耗', attr['秘境消耗'] || tag(entry, '秘境消耗'))
    ],
    left: iconsBlock('', monsters, 'round'),
    right: textBlock('地脉异常', clean(topRow[`extend_${(labels || []).indexOf('地脉异常')}_`] || ''), 'grow') + tagsBlock('可能掉落', rewards)
  }
}

const SET_NAMES = { 1: '一件套', 2: '两件套', 4: '四件套' }

function artifact (entry, content) {
  const ws = Array.isArray(content?.widgets) ? content.widgets : []
  const info = {}
  let pieces = []
  let chars = []
  const base = ws.find(w => w.id === 'rich_base_info')
  if (base) {
    for (const x of base.data?.list || []) info[strip(x.key)] = clean([].concat(x.value ?? []).join(''))
    pieces = ws.filter(w => w.id === 'artifact_list_v2').map(w => ({ slot: strip(w.module), name: strip(flat(w.data?.name)), img: w.data?.icon_url, desc: strip(flat(w.data?.desc)) }))
    const table = (ws.find(w => w.id === 'multi_table')?.data?.tables || []).find(t => strip(t.tab_name).includes('角色'))
    chars = entryCards((table?.row || []).map(r => [].concat(r)[0] ?? '').join(''))
  } else {
    const parts = parseParts(content)
    for (const x of parts.find(p => p.tmplKey === 'common' && p.partKey === 'recommend')?.data?.list?.[0]?.recommend || []) info[strip(x.key)] = clean(x.introduction)
    pieces = parts.filter(p => p.tmplKey === 'relic').map(p => p.data || {}).map(d => ({ slot: strip(d.content?.[0]?.name), name: strip(d.title || d.content?.[0]?.value), img: d.image, desc: strip(d.desc) }))
    const ill = parts.find(p => p.tmplKey === 'illustration' && strip(p.data?.title).includes('推荐'))
    const group = (ill?.data?.data || []).find(g => strip(g.name_).includes('角色'))
    chars = (group?.data || []).filter(x => x?.name && isUrl(x.image)).map(x => ({ name: strip(x.name), img: x.image }))
  }
  if (!pieces.length && !Object.keys(info).length) return null

  const rarity = strip(info['稀有度'])
  const sets = Object.entries(info)
    .filter(([k]) => k.includes('件套'))
    .map(([k, html]) => ({ k: SET_NAMES[k.match(/\d/)?.[0]] || k.replace(/效果$/, ''), html }))
  return {
    kind: '圣遗物',
    name: entry.title,
    stars: Math.max(0, ...(rarity.match(/[1-5]/g) || []).map(Number)) || starOf(tag(entry, '星级')),
    summary: rarity ? `稀有度：${rarity}` : '',
    art: null,
    chips: [],
    left: textBlock('获取途径', info['获取途径'], 'grow'),
    right: rowsBlock('套装效果', sets, 'grow'),
    bottom: piecesBlock(pieces) + iconsBlock('适用角色', chars, 'wide'),
    mainHeight: 380
  }
}

const BUILDERS = { 食物: food, 背包: item, 敌人: monster, 秘境: domain, 圣遗物: artifact }

/** 按目录分类生成专属卡片数据；opts.dish 指定只看某一道料理；没有对应分类或解析失败返回 null，走通用模板 */
export function buildCard (entry, content, opts = {}) {
  const key = Object.keys(BUILDERS).find(k => entry.path.includes(k))
  if (!key) return null
  const view = BUILDERS[key](entry, content, opts)
  if (!view) return null
  view.chips = view.chips.filter(Boolean)
  return view
}
