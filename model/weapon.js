import { sanitizeHtml } from './sanitize.js'

const strip = s => String(s ?? '').replace(/<[^>]+>/g, '')
const decode = s => String(s ?? '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")

const STAT_LABEL = { 暴击伤害: '爆伤' }

function parseStatLines (raw) {
  const html = (Array.isArray(raw) ? raw : [raw])
    .map(x => (typeof x === 'string' ? x : x?.value || ''))
    .join('\n')
  const text = html.replace(/<\/p>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = t.match(/^([^:：]{1,12})[:：]\s*(.+)$/)
    if (m) out.push({ key: STAT_LABEL[m[1].trim()] || m[1].trim(), value: m[2].trim() })
  }
  return out
}

function parseComponent (c) {
  let d = c?.data
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { d = null } }
  return d && typeof d === 'object' ? d : null
}

function skillName (html) {
  const m = String(html).match(/<strong[^>]*>([^<]+?)(?:<br|\n|<\/strong>)/i)
  return m ? m[1].trim() : ''
}

/** 从装备描述 HTML 里拆出技能名 / 技能描述 / 背景故事 / 获取途径（新旧接口结构一致） */
function parseSkill (html) {
  const h = String(html ?? '')
  const strong = h.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? ''
  let name = ''
  let desc = ''
  if (strong) {
    const m = strong.match(/^([^<]*?)(?:<br[^>]*>|\n)/i)
    if (m) {
      name = strip(m[1]).trim()
      desc = strong.slice(m[0].length).replace(/^\s*·\s*/, '')
    } else {
      desc = strong
    }
  }
  const afterHr = h.split(/<hr[^>]*>/i)[1]
  const afterStrong = h.split(/<\/strong>/i)[1]
  const tail = afterHr || afterStrong || ''
  const flavor = strip(tail.split(/<table/i)[0]).trim()
  const ob = h.match(/获取途径[：:]?\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
  const obtain = ob ? strip(ob[1]).trim() : ''
  return { name, desc, flavor, obtain }
}

/** 升级材料：取材料最多的一组（通常是 1 级那组全集，含魔矿 / 摩拉） */
function extractMaterials (html) {
  const blocks = [...String(html ?? '').matchAll(/<div class="materials">([\s\S]*?)<\/div>/g)].map(m => m[1])
  const best = blocks.sort((a, b) => (b.match(/class="mat"/g) || []).length - (a.match(/class="mat"/g) || []).length)[0] || ''
  const out = []
  const re = /<img[^>]*src="([^"]+)"[^>]*>\s*<span class="mat-name">([^<]+)<\/span>\s*(?:<span class="mat-num">([^<]+)<\/span>)?/g
  for (const m of best.matchAll(re)) {
    out.push({ img: m[1], name: decode(m[2]).trim(), num: (m[3] ? decode(m[3]).replace(/^×/, '') : '').trim() })
  }
  return out
}

/** 推荐角色：从 custom-entry-wrapper 里取头像和名字 */
function extractCharacters (html) {
  const out = []
  const seen = new Set()
  for (const m of String(html ?? '').matchAll(/<span class="custom-entry-wrapper"([^>]*)>/g)) {
    const img = m[1].match(/data-entry-img="([^"]+)"/)?.[1]
    const name = m[1].match(/data-entry-name="([^"]+)"/)?.[1]
    if (!img || !name) continue
    const key = `${img}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: decode(name).trim(), img })
  }
  return out
}

/** 基础属性：取最后一组「初始基础数值」（最高等级，和官方卡片一致） */
function extractMaxStats (html) {
  const cells = [...String(html ?? '').matchAll(/初始基础数值[：:]?\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)]
  const last = cells[cells.length - 1]?.[1]
  return last ? parseStatLines(last) : []
}

function section (content, ...keys) {
  const secs = Array.isArray(content?.contents) ? content.contents : []
  return secs.find(s => keys.some(k => String(s?.name ?? '').includes(k)))
}

/** 统一从规范化正文里补齐字段（材料 / 推荐角色 / 背景故事 / 最高级属性） */
export function enrichWeapon (w, content) {
  if (!w) return null
  const p = parseSkill(w.skillHtml)
  if (p.name) w.skillName = p.name
  if (p.desc) w.skillDesc = p.desc
  if (p.flavor) w.flavor = p.flavor
  if (p.obtain) w.obtain = p.obtain

  const growth = section(content, '成长数值')
  if (growth) {
    const mats = extractMaterials(growth.text)
    if (mats.length) w.materials = mats
    const stats = extractMaxStats(growth.text)
    if (stats.length) w.base = stats
  }

  const chars = section(content, '推荐角色')
  if (chars) {
    const list = extractCharacters(chars.text)
    if (list.length) w.characters = list
  }

  return w
}

export function extractNewWeapon (page) {
  const w = {
    name: String(page?.name ?? '').trim(),
    type: '',
    rate: 0,
    image: page?.icon_url || '',
    base: [],
    skillName: '',
    skillHtml: '',
    obtain: ''
  }
  let isWeapon = false
  for (const m of Array.isArray(page?.modules) ? page.modules : []) {
    const d = parseComponent(m?.components?.[0])
    if (!d) continue
    if (d.category && (d.star || d.rate)) {
      isWeapon = true
      w.type = String(d.category)
      w.rate = Number(d.star ?? d.rate) || 0
      if (d.image) w.image = d.image
      if (d.name) w.name = d.name
    }
    if (m.name === '装备描述') {
      w.skillHtml = sanitizeHtml(d.rich_text || '')
      w.skillName = skillName(w.skillHtml)
      const ob = Array.isArray(d.attr) ? d.attr.find(a => String(a.key || '').includes('获取途径')) : null
      if (ob) w.obtain = strip(Array.isArray(ob.value) ? ob.value.join('') : ob.value).trim()
    }
    if (m.name === '成长数值') {
      const basic = d.list?.[0]?.attr?.find(a => String(a.key || '').includes('初始'))
      if (basic) w.base = parseStatLines(basic.value)
    }
  }
  return isWeapon ? w : null
}

export function extractOldWeapon (content) {
  const html = (Array.isArray(content?.contents) ? content.contents : [])
    .map(s => s?.text || '')
    .join('')
  const w = {
    name: '',
    type: '',
    rate: 0,
    image: content?.icon || '',
    base: [],
    skillName: '',
    skillHtml: '',
    obtain: ''
  }
  let found = false
  for (const m of html.matchAll(/data-data="([^"]+)"/g)) {
    let arr
    try { arr = JSON.parse(decodeURIComponent(m[1])) } catch { continue }
    if (!Array.isArray(arr)) continue
    for (const b of arr) {
      if (b.tmplKey !== 'equipment') continue
      const d = b.data || {}
      if (b.partKey === 'main') {
        found = true
        if (d.name) w.name = d.name
        if (d.type) w.type = d.type
        w.rate = Number(d.rate) || 0
        if (d.image) w.image = d.image
      } else if (b.partKey === 'description') {
        w.skillHtml = sanitizeHtml(d.content || '')
        w.skillName = skillName(w.skillHtml)
        if (d.proceed) w.obtain = strip(d.proceed).trim()
      } else if (b.partKey === 'value') {
        const first = d.data?.[0]
        if (first?.basic) w.base = parseStatLines(first.basic)
      }
    }
  }
  return found ? w : null
}

export function extractWeapon (content) {
  if (!content) return null
  const w = content.weapon ? content.weapon : extractOldWeapon(content)
  return enrichWeapon(w, content)
}
