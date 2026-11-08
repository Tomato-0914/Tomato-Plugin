import zlib from 'node:zlib'

/**
 * 极简 xlsx 读取：只为了读椰羊等小程序导出的成就表格，不另装依赖。
 * xlsx 是 zip 包，里面的 xl/sharedStrings.xml（共享字符串）+ xl/worksheets/sheetN.xml（单元格）就够了。
 */

/** 解 zip，返回 Map(文件名 → Buffer)；只支持不压缩（0）和 deflate（8），够用了 */
export function unzip (buf) {
  const files = new Map()
  // 中央目录结束记录（EOCD）在文件末尾，签名 0x06054b50，后面可能跟最多 65535 字节的注释
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / xlsx 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('xlsx 文件目录损坏')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    const lNameLen = buf.readUInt16LE(local + 26)
    const lExtraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + csize)
    if (method === 0) files.set(name, raw)
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw))
  }
  return files
}

const unescapeXml = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&')

/** <si> 里可能是 <t>，也可能是多段 <r><t>（富文本），全部拼起来 */
const textOf = xml => unescapeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''))

/** 列字母 → 0 起的列号：A → 0，Z → 25，AA → 26 */
const colIndex = ref => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1

/** 读第一个工作表，返回二维数组（行 → 单元格文本） */
export function readXlsx (buf) {
  const files = unzip(buf)
  const shared = []
  const sst = files.get('xl/sharedStrings.xml')
  if (sst) for (const m of sst.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]))

  const sheetName = [...files.keys()].filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))[0]
  if (!sheetName) throw new Error('xlsx 里没有工作表')
  const xml = files.get(sheetName).toString('utf8')

  const rows = []
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]
      const body = cm[2] || ''
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1]
      const type = attrs.match(/\bt="(\w+)"/)?.[1]
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let val = ''
      if (type === 's') val = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') val = textOf(body)
      else if (v !== undefined) val = unescapeXml(v)
      row[ref ? colIndex(ref) : row.length] = val
    }
    rows.push(Array.from(row, x => x ?? ''))
  }
  return rows
}
