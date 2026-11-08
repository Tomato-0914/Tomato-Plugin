import { readXlsx } from './xlsx.js'

/**
 * 解析各家成就工具的导出数据，统一成 { format, replace, done: Map(id → 完成时间秒), undone: Set(id) }：
 * - 椰羊等小程序导出的 xlsx / csv 表格：按表头找「ID」「状态」两列（没有状态列时表里的都算已完成）
 * - UIAF（椰羊、胡桃工具箱、寻空等通用的成就交换格式）JSON：status 2、3 算已完成，0、1 算未完成，
 *   没有 status 字段（UIAF v1.0）的都算已完成
 * - 其他 JSON：凡是带 id 的对象数组、或者「成就 id: true」这种对象，都尽量认出来
 * - 纯文字：里面的成就 id（8 开头的五位数）都算已完成，只追加不覆盖
 * replace 为 true 表示这是一份完整存档，导入时整个替换原有记录；false 表示只把里面的追加进去
 */

const isId = n => Number.isInteger(n) && n >= 80000 && n < 1000000

const DONE_WORDS = /^(已完成|已达成|完成|达成|已领取|finished|done|completed|true|是|√|✓|✔|1)$/i
const UNDONE_WORDS = /^(未完成|未达成|unfinished|invalid|false|否|×|0)$/i

function result (format, replace) {
  return { format, replace, done: new Map(), undone: new Set() }
}

/** 表格（xlsx / csv 解析出的二维数组） */
export function parseRows (rows, format = '表格') {
  const out = result(format, true)
  const headerAt = rows.findIndex(r => r.some(c => /^(id|编号|成就id)$/i.test(String(c).trim())))
  if (headerAt < 0) throw new Error('表格里没有找到「ID」列')
  const header = rows[headerAt].map(c => String(c).trim())
  const idCol = header.findIndex(c => /^(id|编号|成就id)$/i.test(c))
  const stCol = header.findIndex(c => /^(状态|完成状态|是否完成|status)$/i.test(c))
  const timeCol = header.findIndex(c => /^(完成时间|时间|日期|date|timestamp)$/i.test(c))
  for (const row of rows.slice(headerAt + 1)) {
    const id = Number(String(row[idCol] ?? '').trim())
    if (!isId(id)) continue
    const st = stCol < 0 ? '' : String(row[stCol] ?? '').trim()
    if (stCol >= 0 && (UNDONE_WORDS.test(st) || /未/.test(st))) {
      out.undone.add(id)
    } else if (stCol < 0 || DONE_WORDS.test(st) || /完成|达成/.test(st)) {
      out.done.set(id, toSeconds(timeCol < 0 ? '' : row[timeCol]))
    } else {
      out.undone.add(id)
    }
  }
  return out
}

function toSeconds (v) {
  if (v === undefined || v === null || v === '') return 0
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.floor(n / 1000) : n > 1e8 ? Math.floor(n) : 0
  const t = Date.parse(String(v).replace(/\//g, '-'))
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0
}

/** 一个成就对象是不是明确标了「未完成」 */
function objUndone (o) {
  if (typeof o.status === 'number') return o.status < 2
  if (typeof o.status === 'string' && UNDONE_WORDS.test(o.status.trim())) return true
  for (const k of ['done', 'completed', 'finished', 'isDone', 'isCompleted', 'isFinished']) if (o[k] === false) return true
  return false
}

/** JSON：UIAF 优先，其次在整棵树里找成就数组 / 成就 id 映射 */
export function parseJson (obj) {
  if (Array.isArray(obj?.list) && (obj.info?.uiaf_version || obj.info?.export_app || obj.list.some(x => isId(Number(x?.id))))) {
    const out = result(`UIAF${obj.info?.export_app ? `（${obj.info.export_app}）` : ''}`, true)
    for (const x of obj.list) {
      const id = Number(x?.id)
      if (!isId(id)) continue
      if (objUndone(x)) out.undone.add(id)
      else out.done.set(id, toSeconds(x.timestamp))
    }
    return out
  }

  const out = result('JSON', true)
  const walk = (v, depth) => {
    if (depth > 6 || !v || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) {
        if (isId(Number(x)) && typeof x !== 'object') out.done.set(Number(x), 0)
        else if (x && typeof x === 'object' && isId(Number(x.id))) {
          if (objUndone(x)) out.undone.add(Number(x.id))
          else out.done.set(Number(x.id), toSeconds(x.timestamp ?? x.date ?? x.time))
        } else walk(x, depth + 1)
      }
      return
    }
    for (const [k, x] of Object.entries(v)) {
      const id = Number(k)
      if (isId(id) && (typeof x === 'boolean' || typeof x === 'number')) {
        if (x) out.done.set(id, typeof x === 'number' && x > 1e8 ? toSeconds(x) : 0)
        else out.undone.add(id)
      } else walk(x, depth + 1)
    }
  }
  walk(obj, 0)
  return out
}

/** csv / tsv 的简单解析（够读导出的表格；双引号包起来的单元格可以带逗号） */
function parseCsv (text) {
  const sep = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ','
  return text.split(/\r?\n/).filter(l => l.trim()).map(line => {
    const cells = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') quoted = false
        else cur += c
      } else if (c === '"') quoted = true
      else if (c === sep) { cells.push(cur); cur = '' } else cur += c
    }
    cells.push(cur)
    return cells.map(s => s.trim())
  })
}

/** 文字：JSON → 带表头的 csv → 散落的成就 id */
export function parseText (text) {
  text = String(text ?? '').replace(/^﻿/, '').trim()
  if (!text) throw new Error('内容是空的')
  if (/^[[{]/.test(text)) {
    let obj
    try {
      obj = JSON.parse(text)
    } catch (err) {
      throw new Error(`JSON 格式不对（可能是复制不完整）：${err.message}`)
    }
    return parseJson(obj)
  }
  const first = text.split('\n')[0]
  if (/(^|[,\t])\s*"?(id|编号)"?\s*([,\t]|$)/i.test(first)) return parseRows(parseCsv(text), 'CSV 表格')
  const out = result('成就 ID', false)
  for (const m of text.matchAll(/(?<!\d)(\d{5,6})(?!\d)/g)) if (isId(Number(m[1]))) out.done.set(Number(m[1]), 0)
  return out
}

/** 文件内容：zip（xlsx）→ 文本 */
export function parseFile (buf, name = '') {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf[0] === 0x50 && buf[1] === 0x4b) return parseRows(readXlsx(buf), 'xlsx 表格')
  if (/\.xls$/i.test(name)) throw new Error('不支持旧版 .xls，请导出或另存为 .xlsx')
  return parseText(buf.toString('utf8'))
}
