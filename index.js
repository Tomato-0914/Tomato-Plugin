import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginName } from './model/config.js'

const appsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps')
const apps = {}

for (const file of fs.readdirSync(appsDir).filter(f => f.endsWith('.js'))) {
  const name = file.replace(/\.js$/, '')
  try {
    const mod = await import(pathToFileURL(path.join(appsDir, file)).href)
    apps[name] = mod[Object.keys(mod)[0]]
  } catch (err) {
    logger.error(`[${pluginName}] 载入 ${file} 失败`)
    logger.error(err)
  }
}

logger.info(`[${pluginName}] 观测枢图鉴插件加载完成`)

export { apps }
