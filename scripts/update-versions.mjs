#!/usr/bin/env node
/**
 * 从 genshin-db（MIT License, Copyright (c) 2020 theBowja）拉取武器/圣遗物/食物的
 * 上线版本数据，重新生成 resources/version/gs.yaml。
 * 单独拉取需要的几个 JSON 文件（不克隆整个仓库），配合 .github/workflows/update-versions.yml 定时跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'resources', 'version', 'gs.yaml')
const RAW = 'https://raw.githubusercontent.com/theBowja/genshin-db/main/src/data'

/** 分类：genshin-db 的英文目录名 → 输出 yaml 里的中文分类名（domains 名字和观测枢对不上，没收） */
const CATEGORIES = { weapons: '武器', artifacts: '圣遗物', foods: '食物', enemies: '敌人', materials: '背包' }

async function fetchJson (url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

/** 名称: 版本号 的排序 yaml 块 */
function block (label, map) {
  const vkey = v => v.split('.').map(Number)
  const lines = [...map.entries()]
    .sort(([, a], [, b]) => vkey(a)[0] - vkey(b)[0] || (vkey(a)[1] || 0) - (vkey(b)[1] || 0))
    .map(([name, ver]) => `  ${/^[「\[{]/.test(name) || /[:#]/.test(name) ? JSON.stringify(name) : name}: '${ver}'`)
  return `${label}:\n${lines.join('\n')}`
}

async function loadCategory (dir) {
  const [idx, ver] = await Promise.all([
    fetchJson(`${RAW}/index/ChineseSimplified/${dir}.json`),
    fetchJson(`${RAW}/version/${dir}.json`)
  ])
  const out = new Map()
  for (const [key, version] of Object.entries(ver)) {
    const name = idx.namemap?.[key]
    if (name && version) out.set(name, String(version))
  }
  return out
}

async function main () {
  const parts = []
  for (const [dir, label] of Object.entries(CATEGORIES)) {
    const map = await loadCategory(dir)
    if (!map.size) throw new Error(`${dir} 没拉到数据，可能是 genshin-db 改了目录结构`)
    parts.push(block(label, map))
    console.log(`${label}：${map.size} 条`)
  }

  const header = [
    '# 条目上线版本：分类列表按版本分组、排序用',
    '# 整理自 genshin-db（https://github.com/theBowja/genshin-db ，MIT License，Copyright (c) 2020 theBowja）',
    '# 格式：名称: 版本号（带引号）；自己补充或修正写到 config/version/gs.yaml，格式一样，升级不会被覆盖'
  ].join('\n')

  fs.writeFileSync(OUT, `${header}\n\n${parts.join('\n\n')}\n`)
  console.log('已写入', path.relative(ROOT, OUT))
}

main().catch(err => {
  console.error('更新版本表失败：', err.message)
  process.exit(1)
})
