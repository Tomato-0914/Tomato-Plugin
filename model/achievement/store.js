import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../config.js'
import { achievementDir } from './data.js'

/**
 * 每个用户的成就记录：data/<插件名>/gs/achievement/user/<user_id>.json
 * { user_id, updatedAt, source, done: { 成就id: 完成时间（秒，不知道为 0） } }
 * 只记录已完成的；不在 done 里的都算未完成。genshin-db 还没收录的 id 也原样保存，等数据更新后自动算进去。
 */

const safeName = s => String(s ?? '').replace(/[^\w.@-]/g, '_').slice(0, 120) || '_'
const userFile = (game, userId) => path.join(achievementDir(game), 'user', `${safeName(userId)}.json`)

export function loadRecord (game, userId) {
  try {
    const raw = JSON.parse(fs.readFileSync(userFile(game, userId), 'utf8'))
    return { ...raw, done: new Map(Object.entries(raw.done || {}).map(([id, t]) => [Number(id), Number(t) || 0])) }
  } catch {
    return null
  }
}

export function saveRecord (game, userId, record) {
  const file = userFile(game, userId)
  ensureDir(path.dirname(file))
  const done = Object.fromEntries([...record.done].sort((a, b) => a[0] - b[0]))
  const data = { user_id: String(userId), updatedAt: Date.now(), source: record.source || '', done }
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data))
  fs.renameSync(`${file}.tmp`, file)
  return { ...data, done: record.done }
}

export function deleteRecord (game, userId) {
  const file = userFile(game, userId)
  const had = fs.existsSync(file)
  fs.rmSync(file, { force: true })
  return had
}

/**
 * 把解析结果写进记录：replace 时整个替换（完整存档），否则只追加。
 * 返回 { record, added, removed, unknown }：added / removed 是这次新增 / 取消的已完成成就数，unknown 是成就数据里没有的 id 数
 */
export function applyImport (game, userId, parsed, known, source) {
  const prev = loadRecord(game, userId)?.done || new Map()
  const done = parsed.replace ? new Map() : new Map(prev)
  for (const [id, t] of parsed.done) done.set(id, t || prev.get(id) || 0)
  if (!parsed.replace) for (const id of parsed.undone) done.delete(id)

  let added = 0
  let removed = 0
  for (const id of done.keys()) if (!prev.has(id)) added++
  for (const id of prev.keys()) if (!done.has(id)) removed++
  const unknown = known ? [...parsed.done.keys(), ...parsed.undone].filter(id => !known.has(id)).length : 0
  const record = saveRecord(game, userId, { done, source })
  return { record, added, removed, unknown }
}

/** 手动标记 / 取消单个或多个成就，返回实际有变化的 id */
export function markIds (game, userId, ids, done = true) {
  const rec = loadRecord(game, userId) || { done: new Map(), source: '手动标记' }
  const changed = []
  for (const id of ids) {
    if (done && !rec.done.has(id)) {
      rec.done.set(id, Math.floor(Date.now() / 1000))
      changed.push(id)
    } else if (!done && rec.done.has(id)) {
      rec.done.delete(id)
      changed.push(id)
    }
  }
  if (changed.length) saveRecord(game, userId, rec)
  return changed
}

/** 导出成 UIAF v1.1（椰羊、胡桃工具箱等都能导入）；数据里有的成就都写上，没完成的 status 记 1 */
export function toUiaf (record, data, appVersion = '') {
  const ids = new Set([...(data?.list || []).map(a => a.id), ...record.done.keys()])
  // current 是进度条数值，这里不记录进度，统一写 0
  const list = [...ids].sort((a, b) => a - b).map(id => {
    const done = record.done.has(id)
    return { id, timestamp: done ? record.done.get(id) || 0 : 0, current: 0, status: done ? 3 : 1 }
  })
  return {
    info: { export_app: 'Tomato-Plugin', export_app_version: appVersion, uiaf_version: 'v1.1', export_timestamp: Math.floor(Date.now() / 1000) },
    list
  }
}
