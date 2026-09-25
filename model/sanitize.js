/**
 * 观测枢正文是 HTML。渲染前先在这里去掉脚本、内嵌框架、事件属性等，
 * 页面里的模板脚本还会再按配置删一遍元素（双保险）。
 */
export function sanitizeHtml (html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|textarea)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|style|iframe|object|embed|noscript|template|textarea|link|meta|base|audio|video|source|track|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1=$2#$2')
}
