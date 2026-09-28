import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { getConfig, pluginRoot, readYaml } from './model/config.js'
import { scheduleImageClear } from './model/imageCache.js'

const USER_FILE = path.join(pluginRoot, 'config', 'config.yaml')

/** 锅巴表单项：field 用点号表示嵌套配置 */
const schemas = [
  { component: 'Divider', label: '基础设置' },
  { field: 'priority', label: '插件优先级', component: 'InputNumber', bottomHelpMessage: '数字越小越先响应，默认 -100（比喵喵插件的默认优先级低很多）；修改后需重启', componentProps: { placeholder: '-100' } },
  { field: 'bareMatch', label: '直接查询', component: 'Switch', bottomHelpMessage: '开启后不带“图鉴”也能查，如 #护摩之杖、护摩之杖' },
  { field: 'renderTip', label: '生成提示', component: 'Switch', bottomHelpMessage: '生成图片前先回复“正在生成”' },
  { field: 'renderScale', label: '渲染精度', component: 'InputNumber', required: true, bottomHelpMessage: '50~300，默认 100；数值越大图片越清晰，体积也越大', componentProps: { min: 50, max: 300, placeholder: '100' } },
  { field: 'forwardThreshold', label: '合并转发阈值', component: 'InputNumber', bottomHelpMessage: '图片或消息超过这个条数时改用合并转发', componentProps: { min: 1, max: 20, placeholder: '2' } },

  { component: 'Divider', label: '查询范围' },
  { field: 'skipCategories', label: '不响应的分类', component: 'GTags', bottomHelpMessage: '这些分类交给其他插件处理，默认为空；比如想让角色图鉴继续交给喵喵插件可以加上「角色」', componentProps: { allowAdd: true, allowDel: true } },
  { field: 'excludeCategories', label: '不收录的分类', component: 'GTags', bottomHelpMessage: '这些分类整个不收录：不查询、不拉详情、不出图，#图鉴分类 里也不显示；默认是成就、任务、地图文本、教程、洞天、NPC&商店、活动、深境螺旋、幻想真境剧诗、幽境危战；从这里删掉的分类要发 #图鉴更新 才会恢复', componentProps: { allowAdd: true, allowDel: true } },
  { field: 'bareCategories', label: '可直接查询的分类', component: 'GTags', bottomHelpMessage: '直接发名称只对这些分类生效，其余分类要发 #名称图鉴', componentProps: { allowAdd: true, allowDel: true } },
  { field: 'strictTitles', label: '严格条目', component: 'GTags', bottomHelpMessage: '日常用词或与其他插件指令重名的条目，只认 #名称图鉴 / #图鉴名称', componentProps: { allowAdd: true, allowDel: true } },

  { component: 'Divider', label: '图片' },
  { field: 'imageCache', label: '图片缓存', component: 'Switch', bottomHelpMessage: '开启后渲染好的图存到 data/Tomato-Plugin/gs/Atlas/<分类>/<图鉴名>/（如 Atlas/角色/兹白/），再查直接发本地图，更快；数据不对时发 #图鉴清除图片缓存<名称> 重新生成。关闭不会删除已有缓存' },
  { field: 'imageCacheCron', label: '定时清理图片缓存', component: 'EasyCron', bottomHelpMessage: '用选择器选时间，默认每周三凌晨 4 点；选择器生成的 7 位表达式插件会自动转换；留空不定时清理；保存后立即生效', componentProps: { placeholder: '0 0 4 ? * 4 *' } },
  { field: 'render.quality', label: '图片质量', component: 'InputNumber', bottomHelpMessage: 'JPEG 质量 1~100', componentProps: { min: 1, max: 100, placeholder: '90' } },
  { field: 'weapon.artDir', label: '武器立绘目录', component: 'Input', bottomHelpMessage: '喵喵插件的武器立绘目录（相对 Yunzai 根目录），找不到时用观测枢图标' },

  { component: 'Divider', label: '数据缓存' },
  { field: 'api.timeout', label: '请求超时（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 120000, placeholder: '15000' } },
  { field: 'api.indexTTL', label: '目录缓存（秒）', component: 'InputNumber', componentProps: { min: 600, placeholder: '21600' } },
  { field: 'api.detailTTL', label: '详情缓存（秒）', component: 'InputNumber', componentProps: { min: 600, placeholder: '43200' } }
]

const fields = schemas.map(s => s.field).filter(Boolean)
const getPath = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj)
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const flatten = (obj, pre = '') => Object.entries(obj || {}).flatMap(([k, v]) => {
  const key = pre ? `${pre}.${k}` : k
  return isObj(v) && !fields.includes(key) ? flatten(v, key) : [[key, v]]
})
function setPath (obj, key, value) {
  const keys = key.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {})
  o[keys[keys.length - 1]] = value
}

/** 锅巴插件配置入口：读取合并后的配置，保存时写入 config/config.yaml */
export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'Tomato-Plugin',
      title: '观测枢图鉴',
      author: '@Tomato-0914',
      authorLink: 'https://github.com/Tomato-0914',
      link: 'https://github.com/Tomato-0914/Tomato-Plugin',
      isV3: true,
      isV2: false,
      description: '实时拉取米游社观测枢数据渲染原神图鉴',
      icon: 'mdi:book-open-page-variant',
      iconColor: '#9C6B3C'
    },
    configInfo: {
      schemas,
      getConfigData () {
        const cfg = getConfig()
        const flat = Object.fromEntries(fields.map(f => [f, getPath(cfg, f)]))
        return { ...cfg, ...flat }
      },
      setConfigData (data, { Result }) {
        const user = readYaml(USER_FILE)
        for (const [key, value] of flatten(data)) {
          if (!fields.includes(key)) continue
          setPath(user, key, key === 'renderScale' ? Math.min(300, Math.max(50, Number(value) || 100)) : value)
        }
        fs.mkdirSync(path.dirname(USER_FILE), { recursive: true })
        fs.writeFileSync(USER_FILE, YAML.stringify(user))
        scheduleImageClear('gs')
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
