import { sanitizeHtml } from './sanitize.js'
import { tagRarity, formatNum } from './weapon.js'

const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const clean = s => sanitizeHtml(String(s ?? ''))
const flat = x => Array.isArray(x) ? x.join('') : (x ?? '')
/** 天赋描述常是带字面 \n 换行的整段纯文本（不是 <p> 分段），先转成 <br> 再清洗 */
const richify = s => clean(String(s ?? '').replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>'))

/** 天赋/命座序号前缀（天赋1（普通攻击） → 普通攻击） */
const tagOf = s => strip(s).replace(/^天赋\d*/, '').replace(/[（）]/g, '').trim()

/**
 * 有些角色（命座之间带联动效果的）命之座表格不是一命一行，而是全部 6 个命座挤在同一个单元格
 * 的一长串 <p> 里：每个命座开头是一段带图标的 <p>（图标 + 命座名连在一起），后面跟若干段说明 <p>，
 * 直到下一个带图标的 <p> 开始下一个命座。按「是否带图标」分段，而不是简单按行数取。
 */
function splitMergedConstellations (html) {
  const paras = [...String(html ?? '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1])
  const groups = []
  let cur = null
  for (const p of paras) {
    if (/<img\b|custom-image-view/i.test(p)) {
      if (cur) groups.push(cur)
      cur = {
        icon: p.match(/data-image-url="([^"]+)"/)?.[1] || p.match(/<img[^>]*src="([^"]+)"/)?.[1] || '',
        name: strip(p),
        descParas: []
      }
    } else if (cur && strip(p)) {
      cur.descParas.push(p)
    }
  }
  if (cur) groups.push(cur)
  return groups.map((g, i) => ({ level: i + 1, name: g.name, icon: g.icon, desc: clean(g.descParas.map(p => `<p>${p}</p>`).join('')) }))
    .filter(c => c.name)
}

/** 「天赋演示」模块的「角色概述」页签：一段大图 + 几句话的角色简介，取文字部分（去掉大图和行内小图标那段） */
function extractOverview (ws) {
  const tables = ws.find(w => w.module === '天赋演示' && w.id === 'multi_table')?.data?.tables || []
  const table = tables.find(t => strip(t.tab_name).includes('概述'))
  const html = String([].concat(table?.row?.[0] ?? [])[0] ?? '')
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1]).filter(p => strip(p))
  return clean(paras.map(p => `<p>${p}</p>`).join(''))
}

/** 命之座：多数角色一命一行（两列：图标+名字、说明）；少数角色全挤在一个单元格里，按段落重新切开 */
function extractConstellations (table) {
  const rows = table?.row || []
  const firstRowCells = [].concat(rows[0] ?? [])
  if (firstRowCells.length >= 2) {
    return rows.map((r, i) => {
      const [imgCell, descCell] = [].concat(r)
      const icon = String(imgCell ?? '').match(/data-image-url="([^"]+)"/)?.[1] || String(imgCell ?? '').match(/<img[^>]*src="([^"]+)"/)?.[1] || ''
      return { level: i + 1, name: strip(imgCell), icon, desc: richify(descCell) }
    }).filter(c => c.name)
  }
  if (firstRowCells.length === 1) return splitMergedConstellations(firstRowCells[0])
  return []
}

function widgetsOf (content) {
  return Array.isArray(content?.widgets) ? content.widgets : []
}

/** 新接口：角色词条按 widgets（role_base_info / role_ascension / role_talent / multi_table / recommend）取结构化数据 */
function extractNewCharacter (content) {
  const ws = widgetsOf(content)
  const base = ws.find(w => w.id === 'role_base_info')?.data
  if (!base || !base.name) return null

  const info = {}
  for (const a of Array.isArray(base.attr) ? base.attr : []) info[strip(a.key)] = strip(flat(a.value))

  const ascList = ws.find(w => w.id === 'role_ascension')?.data?.list || []
  const matSrc = ascList[0]?.materials || []
  const materials = tagRarity(matSrc.filter(m => m?.nickname).map(m => ({
    name: strip(m.nickname), img: m.img || '', num: formatNum(m.amount)
  })))
  const topAttr = ascList[ascList.length - 1]?.attr || []
  const stats = topAttr.map(a => ({ key: strip(a.key), value: strip(flat(a.value)) })).filter(s => s.key && s.value)

  const talents = (ws.find(w => w.id === 'role_talent')?.data?.list || []).map(t => ({
    tag: tagOf(t.tab_name),
    name: strip(t.title),
    icon: t.icon || '',
    desc: richify(t.desc)
  })).filter(t => t.name)

  const constTable = (ws.find(w => w.id === 'multi_table' && w.module === '命之座')?.data?.tables || [])[0]
  const constellations = extractConstellations(constTable)

  const recTables = ws.find(w => w.id === 'recommend')?.data?.tables || []
  const recommend = kind => {
    const t = recTables.find(t => strip(t.tab_name).includes(kind))
    const out = []
    for (const r of t?.row || []) {
      const cell = String([].concat(r)[0] ?? '')
      const name = strip(cell.match(/data-entry-name="([^"]+)"/)?.[1])
      const img = cell.match(/data-entry-img="([^"]+)"/)?.[1] || ''
      if (name && !out.some(x => x.name === name)) out.push({ name, img })
    }
    return out
  }

  const cvHtml = String(ws.find(w => w.module === '角色CV')?.data?.rich_text || '').replace(/<p>\s*四国语音展示请下划浏览\s*<\/p>\s*$/i, '')
  const cv = clean(cvHtml)
  const summary = extractOverview(ws)

  return {
    name: strip(base.name),
    title: info['称号'] || '',
    element: info['神之眼'] || info['元素'] || '',
    accent: base.role_attribute || '',
    weaponType: info['武器类型'] || '',
    constellationName: info['命之座'] || '',
    birthday: info['生日'] || '',
    affiliation: info['所属'] || '',
    position: info['定位'] || '',
    star: Number(base.star) || 0,
    image: base.avatar_m || base.avatar_pc || '', // avatar_m 是给手机端用的竖版裁图，比桌面端的宽版 avatar_pc 更贴近我们卡片的窄长展示框
    cv,
    summary,
    stats,
    materials,
    talents,
    constellations,
    recommendWeapons: recommend('武器'),
    recommendArtifacts: recommend('圣遗物')
  }
}

/** 旧接口兜底：character/newMain（资料）、breach（突破材料）、skill（天赋）、life（命之座） */
function extractOldCharacter (content) {
  const html = (Array.isArray(content?.contents) ? content.contents : []).map(s => s?.text || '').join('')
  let main, breach, skill, life
  for (const m of html.matchAll(/data-data="([^"]+)"/g)) {
    let arr
    try { arr = JSON.parse(decodeURIComponent(m[1])) } catch { continue }
    if (!Array.isArray(arr)) continue
    for (const b of arr) {
      if (b.tmplKey !== 'character') continue
      if (b.partKey === 'newMain' && !main) main = b.data
      else if (b.partKey === 'breach' && !breach) breach = b.data
      else if (b.partKey === 'skill' && !skill) skill = b.data
      else if (b.partKey === 'life' && !life) life = b.data
    }
  }
  if (!main || !main.name) return null

  const fields = {}
  for (const f of Array.isArray(main.mainFields) ? main.mainFields : []) {
    if (f.nameL) fields[f.nameL] = f.valueL
    if (f.nameR) fields[f.nameR] = f.valueR
  }

  const matSrc = breach?.attr?.[0]?.material || []
  const materials = tagRarity(matSrc.filter(m => m?.name).map(m => ({
    name: strip(m.name), img: m.icon || '', num: formatNum(strip(m.num).replace(/^\*/, ''))
  })))

  const talents = (Array.isArray(skill?.attr) ? skill.attr : []).map(t => ({
    tag: tagOf(t.name_),
    name: strip(t.title).replace(/^[^·]*·\s*/, ''),
    icon: t.icon || '',
    desc: clean(String(t.introduction || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join(''))
  })).filter(t => t.name)

  const constellations = (Array.isArray(life?.attr) ? life.attr : []).map((c, i) => ({
    level: i + 1,
    name: strip(c.name_),
    icon: c.icon || '',
    desc: clean(String(c.introduction || '').split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join(''))
  })).filter(c => c.name)

  return {
    name: strip(main.name),
    title: fields['称号'] || '',
    element: fields['神之眼'] || '',
    accent: main.property || '',
    weaponType: fields['武器类型'] || '',
    constellationName: fields['命之座'] || '',
    birthday: fields['生日'] || '',
    affiliation: fields['所属'] || '',
    position: '',
    star: Number(main.star) || 0,
    image: main.mobile || main.pc || '', // 同上，优先用手机端竖版裁图
    cv: '',
    summary: '',
    stats: [],
    materials,
    talents,
    constellations,
    recommendWeapons: [],
    recommendArtifacts: []
  }
}

export function extractCharacter (content) {
  if (!content) return null
  return extractNewCharacter(content) || extractOldCharacter(content)
}
