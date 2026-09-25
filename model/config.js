import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const pluginName = path.basename(pluginRoot)
export const dataRoot = path.join(process.cwd(), 'data', pluginName)

const DEFAULT_FILE = path.join(pluginRoot, 'config', 'default.yaml')
const USER_FILE = path.join(pluginRoot, 'config', 'config.yaml')

let cached = null
let cachedSig = ''

export function mtime (file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

export function readYaml (file) {
  if (!fs.existsSync(file)) return {}
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (err) {
    logger.error(`[${pluginName}] YAML 解析失败：${file}`)
    logger.error(err)
    return {}
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)

function merge (base, over) {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  }
  return out
}

/** 读取配置；文件有改动会自动重新加载 */
export function getConfig () {
  const sig = `${mtime(DEFAULT_FILE)}|${mtime(USER_FILE)}`
  if (cached && sig === cachedSig) return cached
  cached = merge(readYaml(DEFAULT_FILE), readYaml(USER_FILE))
  cachedSig = sig
  return cached
}

export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
