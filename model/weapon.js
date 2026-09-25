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
    const m = t.match(/^([^:：]{1,16})[:：]\s*(.+)$/)
    if (!m || m[1].includes('未突破')) continue
    const key = m[1].replace(/[（(]突破后[）)]/, '').trim()
    out.push({ key: STAT_LABEL[key] || key, value: m[2].trim() })
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
  const hr = h.search(/<hr[^>]*>/i)
  const head = hr >= 0 ? h.slice(0, hr) : h
  const open = head.search(/<strong[^>]*>/i)
  let name = ''
  let desc = ''
  if (open >= 0) {
    const inner = head.slice(open).replace(/^<strong[^>]*>/i, '')
    const m = inner.match(/^([^<]*?)(?:<br[^>]*>|\n)/i)
    let rest = inner
    if (m) {
      name = strip(m[1]).trim()
      rest = inner.slice(m[0].length)
    }
    if (hr < 0) rest = rest.split(/<\/strong>/i)[0]
    desc = `<p>${rest.replace(/<\/?strong[^>]*>/gi, '').replace(/^\s*·\s*/, '')}`
      .replace(/<p[^>]*>(\s|&nbsp;|<br[^>]*>)*<\/p>/gi, '')
      .replace(/(<br[^>]*>\s*){2,}/gi, '<br>')
      .replace(/<span\b[^>]*style="([^"]*)"[^>]*>/gi, (_, st) => {
        const c = st.match(/color\s*:\s*([^;]+)/i)?.[1]?.replace(/\s+/g, '') || ''
        return c && !/^(#000(000)?|rgba?\(0,0,0(,1)?\)|black)$/i.test(c) ? '<span class="hl">' : '<span>'
      })
      .trim()
  }
  const tail = hr >= 0 ? h.slice(hr).replace(/^<hr[^>]*>/i, '') : (h.split(/<\/strong>/i)[1] || '')
  const flavor = strip(tail.split(/<table/i)[0]).trim()
  const ob = h.match(/获取途径[：:]?\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i)
  const obtain = ob ? strip(ob[1]).trim() : ''
  return { name, desc, flavor, obtain }
}

const FIXED_RARITY = { 摩拉: 3, 精锻用魔矿: 3, 精锻用良矿: 2, 精锻用杂矿: 1 }
const RUN_START = [2, 2, 1]

function sameSeries (a, b) {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  let j = 0
  while (j < a.length && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
  return i >= 2 || j >= 2
}

/** 按材料系列推断稀有度：突破素材 2★ 起，精英怪素材 2★ 起，普通怪素材 1★ 起 */
function tagRarity (mats) {
  let run = -1
  let pos = 0
  let prev = ''
  for (const m of mats) {
    if (FIXED_RARITY[m.name]) {
      m.rarity = FIXED_RARITY[m.name]
      prev = ''
      continue
    }
    if (prev && sameSeries(prev, m.name)) pos++
    else {
      run++
      pos = 0
    }
    m.rarity = Math.min(5, (RUN_START[run] ?? 1) + pos)
    prev = m.name
  }
  return mats
}

function formatNum (n) {
  const t = String(n ?? '').trim()
  const v = Number(t)
  if (!t || !Number.isFinite(v)) return t
  return v >= 10000 ? `${Math.round(v / 10000)}万` : String(v)
}

/** 按突破材料名称匹配秘境开放日，配置见 weapon.domainDays */
export function materialDays (mats = [], table = {}) {
  for (const [days, series] of Object.entries(table || {})) {
    if ((series || []).some(k => k && mats.some(m => m.name.includes(k)))) return days
  }
  return ''
}

/** 升级材料：取材料最多的一组（通常是 1 级那组全集，含魔矿 / 摩拉） */
function extractMaterials (html) {
  const blocks = [...String(html ?? '').matchAll(/<div class="materials">([\s\S]*?)<\/div>/g)].map(m => m[1])
  const best = blocks.sort((a, b) => (b.match(/class="mat"/g) || []).length - (a.match(/class="mat"/g) || []).length)[0] || ''
  const out = []
  const re = /<img[^>]*src="([^"]+)"[^>]*>\s*<span class="mat-name">([^<]+)<\/span>\s*(?:<span class="mat-num">([^<]+)<\/span>)?/g
  for (const m of best.matchAll(re)) {
    out.push({ img: m[1], name: decode(m[2]).trim(), num: formatNum(m[3] ? decode(m[3]).replace(/^×/, '') : '') })
  }
  return tagRarity(out)
}

/** 推荐角色：从词条卡片（custom-entry-wrapper / entry-material-box）里取头像和名字 */
function extractCharacters (html) {
  const h = String(html ?? '')
  const out = []
  const push = (name, img) => {
    name = decode(name).trim()
    if (name && img && !out.some(c => c.name === name)) out.push({ name, img })
  }
  for (const [tag] of h.matchAll(/<span\b[^>]*class="[^"]*custom-entry-wrapper[^"]*"[^>]*>/g)) {
    push(tag.match(/data-entry-name="([^"]+)"/)?.[1], tag.match(/data-entry-img="([^"]+)"/)?.[1])
  }
  if (!out.length) {
    for (const m of h.matchAll(/<a\b[^>]*entry-material-box[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?class="name">([^<]+)</g)) push(m[2], m[1])
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

  const chars = section(content, '推荐角色', '适用角色', '适配角色')
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
    skillDesc: '',
    skillHtml: '',
    flavor: '',
    obtain: '',
    materials: [],
    characters: []
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
    skillDesc: '',
    skillHtml: '',
    flavor: '',
    obtain: '',
    materials: [],
    characters: []
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
        const levels = Array.isArray(d.data) ? d.data : []
        const top = levels.filter(l => l?.basic).pop()
        if (top) w.base = parseStatLines(top.basic)
        const full = levels.map(l => (Array.isArray(l?.material) ? l.material : [])).sort((a, b) => b.length - a.length)[0] || []
        const mats = full
          .filter(x => x?.name)
          .map(x => ({ img: x.icon || '', name: decode(x.name).trim(), num: formatNum(x.num) }))
        if (mats.length) w.materials = tagRarity(mats)
      }
    }
    for (const b of arr) {
      if (b.tmplKey !== 'illustration' || !String(b.data?.title ?? '').includes('角色')) continue
      for (const g of Array.isArray(b.data?.data) ? b.data.data : []) {
        for (const x of Array.isArray(g?.data) ? g.data : []) {
          if (x?.name && x?.image && !w.characters.some(c => c.name === x.name)) w.characters.push({ name: decode(x.name).trim(), img: x.image })
        }
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
