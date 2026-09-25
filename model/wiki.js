import { sanitizeHtml } from './sanitize.js'
import { extractNewWeapon } from './weapon.js'

/**
 * 新版观测枢（hoyowiki）词条解析。
 *
 * 新接口 /hoyowiki/genshin/wapi/entry_page 返回的是 `data.page`，其
 * `modules[].components[].data` 是一段「JSON 字符串」，里面是一套
 * 通用 widget 描述（rich_text / tables / list / attr / materials / image …），
 * 不是旧接口那种整段 HTML。这里把它转成旧版 `content` 那样的规范结构
 * { title, summary, icon, contents: [{ name, text }] }，这样 render.js 和
 * entry.html 完全不用感知数据来自哪套接口。
 */

const isUrl = s => typeof s === 'string' && /^https?:\/\//i.test(s.trim())

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** 富文本/单元格/描述：按 HTML 走一遍清洗，纯文本也不受影响 */
const clean = s => sanitizeHtml(String(s ?? ''))

const img = (src) => {
  const u = String(src ?? '').trim()
  return isUrl(u) ? `<img src="${esc(u)}">` : ''
}

/** attr 数组 → 两列表格；value 可能是文本，也可能是 HTML（甚至嵌图） */
function renderAttr (attr) {
  const list = Array.isArray(attr) ? attr : []
  const rows = []
  for (const a of list) {
    if (!a || typeof a !== 'object') continue
    const k = String(a.key ?? a.name ?? '').trim()
    const vals = Array.isArray(a.value) ? a.value : [a.value]
    const v = vals.map(x => {
      if (x == null || x === '') return ''
      if (typeof x === 'string') return clean(x)
      if (typeof x === 'object') return dataToHtml(x)
      return esc(x)
    }).join('')
    if (k || v) rows.push(`<tr><th>${esc(k)}</th><td>${v}</td></tr>`)
  }
  return rows.length ? `<table><tbody>${rows.join('')}</tbody></table>` : ''
}

/**
 * 有的模块把 `attr` 用作 key/value 数组（基础信息、角色突破），
 * 有的把它用作整张表（天赋里的 { header, row }）。这里按形状分流。
 */
function renderAttrOrTable (x) {
  if (!x) return ''
  if (Array.isArray(x)) return renderAttr(x)
  if (typeof x === 'object' && (Array.isArray(x.header) || Array.isArray(x.table))) return renderTable(x)
  return renderAttr(x)
}

/** 表格：{ header[], row[][] } 或 { table: [对象] }（配音那种对象数组） */
function renderTable (t) {
  if (!t || typeof t !== 'object') return ''
  // 对象数组表（如配音展示的 table: [{ name, content }]）
  if (Array.isArray(t.table) && !Array.isArray(t.header)) {
    const objs = t.table
    if (!objs.length) return ''
    const skip = new Set(['audio_url', 'audio_name', 'isUploading', 'tab_id', 'url'])
    const keys = [...new Set(objs.flatMap(o => Object.keys(o || {}).filter(k => !skip.has(k) && o[k] !== '' && o[k] != null)))]
    if (!keys.length) return ''
    const thead = `<thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead>`
    const body = objs.map(o => `<tr>${keys.map(k => `<td>${clean(o?.[k])}</td>`).join('')}</tr>`).join('')
    return `<table>${thead}<tbody>${body}</tbody></table>`
  }
  // 传统表：header + row
  if (Array.isArray(t.header) && Array.isArray(t.row)) {
    const thead = `<thead><tr>${t.header.map(h => `<th>${clean(h)}</th>`).join('')}</tr></thead>`
    const body = t.row.map(r => `<tr>${(Array.isArray(r) ? r : []).map(c => `<td>${clean(c)}</td>`).join('')}</tr>`).join('')
    return `<table>${thead}<tbody>${body}</tbody></table>`
  }
  return ''
}

/** 材料 chips：小图 + 名字 + 数量 */
function renderMaterials (mats) {
  const items = Array.isArray(mats) ? mats : []
  const chips = items.map((m) => {
    const name = m?.nickname ?? m?.name ?? ''
    const amount = m?.amount ?? m?.num ?? ''
    const u = m?.img ?? m?.image ?? m?.icon ?? ''
    const im = isUrl(u) ? `<img src="${esc(u)}">` : ''
    return `<span class="mat">${im}<span class="mat-name">${esc(name)}</span>${amount !== '' && amount != null ? `<span class="mat-num">×${esc(amount)}</span>` : ''}</span>`
  }).join('')
  return chips ? `<div class="materials">${chips}</div>` : ''
}

const LIST_IMG_KEYS = ['image', 'img', 'icon', 'cover', 'long_img', 'card_img', 'icon_url', 'header_img_url']
const TOP_IMG_KEYS = ['long_img', 'image', 'img', 'icon_url', 'card_img', 'header_img_url']

function renderList (list, opts = {}) {
  const items = Array.isArray(list) ? list : []
  const out = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const frags = []
    const tab = String(it.tab_name ?? it.tab ?? '').trim()
    if (tab && !/^页签\d*$/.test(tab)) frags.push(`<h3>${esc(tab)}</h3>`)
    const ttl = String(it.title ?? '').trim()
    if (ttl && ttl !== tab && ttl !== opts.title) frags.push(`<p><strong>${esc(ttl)}</strong></p>`)
    if (typeof it.rich_text === 'string') frags.push(clean(it.rich_text))
    if (typeof it.desc === 'string') frags.push(clean(it.desc))
    for (const k of LIST_IMG_KEYS) if (isUrl(it[k])) frags.push(img(it[k]))
    if (isUrl(it.avatar_pc)) frags.push(img(it.avatar_pc))
    else if (isUrl(it.avatar_m)) frags.push(img(it.avatar_m))
    if (Array.isArray(it.table)) frags.push(renderTable({ table: it.table }))
    if (Array.isArray(it.tables)) for (const t of it.tables) frags.push(renderTable(t))
    if (it.attr) frags.push(renderAttrOrTable(it.attr))
    if (Array.isArray(it.materials)) frags.push(renderMaterials(it.materials))
    if (it.new_talent_unlocked) frags.push(clean(it.new_talent_unlocked))
    out.push(frags.filter(Boolean).join(''))
  }
  return out.filter(Boolean).join('')
}

/** 一段 widget data → HTML */
/** { key, value: [...] } 形式的字段（新版圣遗物等）摊平成字符串 */
const flat = x => (x && typeof x === 'object' && !Array.isArray(x) && 'value' in x) ? [].concat(x.value ?? []).join('') : x

function dataToHtml (d, opts = {}) {
  if (d == null) return ''
  if (typeof d === 'string') return clean(d)
  if (typeof d !== 'object') return esc(String(d))
  d = { ...d, name: flat(d.name), title: flat(d.title), desc: flat(d.desc), story: flat(d.story) }

  const out = []
  if (typeof d.rich_text === 'string') out.push(clean(d.rich_text))
  else if (typeof d.desc === 'string') out.push(clean(d.desc))
  else if (typeof d.story === 'string') out.push(clean(d.story))

  for (const t of Array.isArray(d.tables) ? d.tables : []) out.push(renderTable(t))
  if (Array.isArray(d.table)) out.push(renderTable({ table: d.table }))
  if (Array.isArray(d.list)) out.push(renderList(d.list, opts))

  for (const k of TOP_IMG_KEYS) if (isUrl(d[k])) out.push(img(d[k]))
  if (isUrl(d.avatar_pc)) out.push(img(d.avatar_pc))
  else if (isUrl(d.avatar_m)) out.push(img(d.avatar_m))

  if (d.attr) out.push(renderAttrOrTable(d.attr))
  if (Array.isArray(d.materials)) out.push(renderMaterials(d.materials))

  // 纯字段兜底（武器 banner、食物、圣遗物单件等）：名称/星级/类别
  const plain = []
  const name = typeof d.name === 'string' ? d.name.trim() : ''
  if (name && name !== opts.title && !d.rich_text) plain.push(`<strong>${esc(name)}</strong>`)
  if (typeof d.title === 'string' && d.title.trim() && d.title.trim() !== opts.title) plain.push(esc(d.title))
  if (d.star) plain.push('★'.repeat(Number(d.star) || 0))
  if (d.category) plain.push(esc(String(d.category)))
  if (plain.length) out.unshift(`<p>${plain.join(' · ')}</p>`)

  return out.filter(Boolean).join('')
}

/** 新版 page → 旧版 content 规范结构 */
export function modulesToContents (page) {
  const title = String(page?.name ?? '').trim()
  const desc = String(page?.desc ?? '').trim()
  const contents = []
  const widgets = []

  for (const m of Array.isArray(page?.modules) ? page.modules : []) {
    if (m?.is_hidden) continue
    const name = String(m.name ?? '').trim()
    const frags = []
    for (const c of Array.isArray(m?.components) ? m.components : []) {
      let d = c?.data
      if (typeof d === 'string') {
        try { d = JSON.parse(d) } catch { d = { rich_text: d } }
      }
      widgets.push({ module: name, id: String(c?.component_id ?? ''), data: d })
      frags.push(dataToHtml(d, { title }))
    }
    const html = frags.filter(Boolean).join('')
    if (!html.trim()) continue
    // 空名 / 与词条同名 / 占位符 → 不出小标题
    const secName = (!name || name === title || /^页签\d*$/.test(name)) ? '' : name
    contents.push({ name: secName, text: html })
  }

  const weapon = extractNewWeapon(page)
  return {
    title,
    summary: desc && desc !== title ? desc : '',
    icon: page?.icon_url || page?.header_img_url || '',
    contents,
    widgets,
    ...(weapon ? { weapon } : {})
  }
}
