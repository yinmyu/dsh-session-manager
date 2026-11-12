/**
 * Documentation artwork generator — no dependencies, no browser.
 *
 * The documentation needs real-looking panels, and this machine has no browser automation, so the
 * screenshots are drawn from the same structure the panel itself renders: a 34px row with a
 * checkbox, title, badges, a right-aligned size cell, a relative time, and the risk mark; a
 * selection bar; a confirm block with the tier breakdown; and the recycle-bin view with its
 * countdown and undo hint. Every value below is invented — session titles, folders (always
 * `~/projects/…`), sizes and times — so the artwork is safe to publish.
 *
 *   node tools/render-docs.mjs            # write docs/shot-*.svg
 *   node tools/render-docs.mjs --check    # fail when a file on disk differs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = new URL('../docs/', import.meta.url)
const FONT = "ui-sans-serif, -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Helvetica, Arial, sans-serif"
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const INK = '#0c1117'
const EDGE = '#2b3a4d'
const TEXT = '#e8edf3'
const DIM = '#9fb0c3'
const FAINT = '#5b6b7c'
const OK = '#2f9e5f'
const WARN = '#c9861b'
const DANGER = '#cf5348'

const LOCALES = {
  zh: {
    listTitle: '会话管理',
    listSub: '14 个会话 · 已归档 6 · 共 1.2 GB',
    note: '删除的会话会先放入回收站，30 天内都能恢复。',
    filters: ['全部', '未归档', '已归档', '人才池'],
    search: '搜索标题、目录或 ID',
    workspace: '工作区：checkout-api',
    selectAll: '全选',
    suggest: '有 9 项可放心删除',
    count: '显示 12 / 共 14 个',
    rows: [
      { title: '重构支付回调的幂等处理', badge: null, size: '8.4 MB', time: '2 小时前', risk: ['警告', DANGER] },
      { title: '线上告警排查记录', badge: '运行中', size: '1.6 MB', time: '5 分钟前', risk: ['警告', DANGER] },
      { title: '结算页埋点核对', badge: null, size: '3.1 MB', time: '3 天前', risk: ['谨慎', WARN] },
      { title: '夜间批处理监控', badge: '子代理', size: '640 KB', time: '9 天前', risk: ['建议删除', OK] },
      { title: '（未命名会话）', badge: '空白', size: '—', time: '12 天前', risk: ['建议删除', OK] },
      { title: '旧版接口迁移记录', badge: null, size: '22.0 MB', time: '26 天前', risk: ['建议删除', OK] },
    ],
    selected: '已选 4 项 · 12.6 MB',
    barActions: ['移入回收站', '归档', '撤销'],
    confirmTitle: '移入回收站',
    confirmBody: '4 个会话会移到回收站，30 天内可以恢复。',
    tiers: [
      ['建议删除 2 项（7 天以上没有活动）', OK],
      ['谨慎 1 项', WARN],
      ['警告 1 项（线上告警排查记录）', DANGER],
    ],
    confirmSub: '已选 4 项 · 12.6 MB',
    confirmActions: ['取消', '移入回收站'],
    binTitle: '会话管理 · 人才池',
    binSub: '4 项 · 31.0 MB · 保留 30 天',
    binRows: [
      { title: '旧版接口迁移记录', badge: null, size: '22.0 MB', time: '28 天后清除', risk: ['有 1 个派生会话', WARN] },
      { title: '夜间批处理监控', badge: null, size: '640 KB', time: '21 天后清除', risk: null },
      { title: '（未命名会话）', badge: null, size: '—', time: '即将清除', risk: ['已到期', WARN] },
      { title: '重构支付回调的幂等处理', badge: null, size: '8.4 MB', time: '9 天后清除', risk: null },
    ],
    binBar: ['恢复', '彻底删除', '清理已到期'],
    binSelected: '已选 1 项 · 22.0 MB',
    binCount: '共 4 个',
    binNote: '恢复后会话回到原目录；彻底删除是唯一不可逆的一步。',
    caption: '示意界面，数据均为虚构，目录已隐去真实路径',
  },
  en: {
    listTitle: 'Session manager',
    listSub: '14 sessions · 6 archived · 1.2 GB on disk',
    note: 'Removed sessions go to the recycle bin first and can be restored for 30 days.',
    filters: ['All', 'Active', 'Archived', 'Talent pool'],
    search: 'Search titles, folders, or IDs',
    workspace: 'Workspace: checkout-api',
    selectAll: 'Select all',
    suggest: '9 can be removed safely',
    count: '12 of 14',
    rows: [
      { title: 'Make the payment callback idempotent', badge: null, size: '8.4 MB', time: '2 h ago', risk: ['Keep an eye on', DANGER] },
      { title: 'Incident triage notes', badge: 'Running', size: '1.6 MB', time: '5 min ago', risk: ['Keep an eye on', DANGER] },
      { title: 'Checkout funnel instrumentation', badge: null, size: '3.1 MB', time: '3 d ago', risk: ['Check first', WARN] },
      { title: 'Nightly batch monitor', badge: 'Child', size: '640 KB', time: '9 d ago', risk: ['Safe to remove', OK] },
      { title: '(untitled session)', badge: 'Empty', size: '—', time: '12 d ago', risk: ['Safe to remove', OK] },
      { title: 'Legacy API migration log', badge: null, size: '22.0 MB', time: '26 d ago', risk: ['Safe to remove', OK] },
    ],
    selected: '4 selected · 12.6 MB',
    barActions: ['Offboard', 'Archive', 'Undo'],
    confirmTitle: 'Move to recycle bin',
    confirmBody: '4 sessions move to the recycle bin and can be restored for 30 days.',
    tiers: [
      ['Safe to remove: 2 — idle for 7+ days', OK],
      ['Check first: 1', WARN],
      ['Keep an eye on: 1 — Incident triage notes', DANGER],
    ],
    confirmSub: '4 selected · 12.6 MB',
    confirmActions: ['Cancel', 'Offboard'],
    binTitle: 'Session manager · Talent pool',
    binSub: '4 entries · 31.0 MB · kept 30 days',
    binRows: [
      { title: 'Legacy API migration log', badge: null, size: '22.0 MB', time: '28 days left', risk: ['1 derived session', WARN] },
      { title: 'Nightly batch monitor', badge: null, size: '640 KB', time: '21 days left', risk: null },
      { title: '(untitled session)', badge: null, size: '—', time: 'Due now', risk: ['expired', WARN] },
      { title: 'Make the payment callback idempotent', badge: null, size: '8.4 MB', time: '9 days left', risk: null },
    ],
    binBar: ['Restore', 'Delete permanently', 'Remove expired'],
    binSelected: '1 selected · 22.0 MB',
    binCount: '4 entries',
    binNote: 'Restoring puts the session back where it came from; deleting permanently is the only irreversible step.',
    caption: 'Illustration with invented data; real paths are hidden',
  },
}


/** Approximate advance width of a string at a given font size (CJK ≈ 1em, latin ≈ 0.55em). */
function textWidth(value, size = 13) {
  let width = 0
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    const wide = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60)
    width += wide ? size : size * 0.55
  }
  return Math.ceil(width)
}

/** Clip a label to the pixels available, with an ellipsis. */
function clip(value, available, size = 13) {
  if (textWidth(value, size) <= available) return value
  let out = ''
  for (const char of String(value)) {
    if (textWidth(out + char, size) + size > available) return `${out}…`
    out += char
  }
  return out
}

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const text = (x, y, value, { size = 13, fill = TEXT, font = FONT, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(value)}</text>`
const rect = (x, y, w, h, { fill = 'none', stroke = EDGE, width = 1.5, rx = 8, opacity = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" fill-opacity="${opacity}" stroke="${stroke}" stroke-width="${width}"/>`
const chip = (x, y, label, tone, { width = null } = {}) => {
  const w = width ?? Math.max(52, textWidth(label, 11) + 20)
  return rect(x, y, w, 20, { stroke: tone, rx: 10 }) + text(x + 10, y + 14, label, { size: 11, fill: tone })
}
const frame = (title, subtitle, note, width = 900, height = 520) => {
  const parts = []
  parts.push(rect(0.75, 0.75, width - 1.5, height - 1.5, { fill: INK, stroke: EDGE, rx: 18 }))
  parts.push(`<path d="M1 58h${width - 2}" stroke="${EDGE}" stroke-width="1.5"/>`)
  parts.push(text(24, 36, title, { size: 17, weight: 600 }))
  parts.push(text(24, 88, subtitle, { size: 12, fill: DIM }))
  if (note) parts.push(text(24, height - 22, note, { size: 11, fill: FAINT }))
  return parts
}
const row = (x, y, data, { width = 852, checked = false } = {}) => {
  const parts = []
  // Lay the right-hand cells out from the edge inwards, each measured, so nothing can collide.
  const timeRight = x + width - 14
  const timeWidth = textWidth(data.time, 11.5)
  const sizeRight = timeRight - timeWidth - 18
  const sizeWidth = textWidth(data.size, 11.5)
  const riskRight = sizeRight - sizeWidth - 18
  if (checked) parts.push(rect(x, y, width, 34, { stroke: 'none', rx: 6, fill: EDGE, opacity: 0.3 }))
  parts.push(`<path d="M${x} ${y + 34}h${width}" stroke="${EDGE}" stroke-width="1"/>`)
  parts.push(rect(x + 12, y + 9, 16, 16, { stroke: checked ? OK : FAINT, rx: 4, fill: checked ? OK : 'none', opacity: checked ? 0.25 : 1 }))
  if (checked) parts.push(`<path d="M${x + 16} ${y + 17}l4 4 7-8" stroke="${OK}" stroke-width="2" fill="none" stroke-linecap="round"/>`)
  // badges and the risk chip occupy fixed slots on the right; the title is clipped into what is left
  let cursor = riskRight
  if (data.risk) {
    const chipWidth = Math.max(52, textWidth(data.risk[0], 11) + 20)
    cursor -= chipWidth
    parts.push(chip(cursor, y + 7, data.risk[0], data.risk[1], { width: chipWidth }))
    cursor -= 8
  }
  if (data.badge) {
    const badgeWidth = Math.max(38, textWidth(data.badge, 10) + 16)
    cursor -= badgeWidth
    parts.push(rect(cursor, y + 8, badgeWidth, 18, { stroke: EDGE, rx: 4, fill: EDGE, opacity: 0.35 }))
    parts.push(text(cursor + 8, y + 21, data.badge, { size: 10, fill: DIM }))
    cursor -= 8
  }
  const titleRoom = cursor - (x + 40) - 8
  parts.push(text(x + 40, y + 22, clip(data.title, titleRoom, 13), { size: 13 }))
  parts.push(text(sizeRight, y + 22, data.size, { size: 11.5, fill: DIM, font: MONO, anchor: 'end' }))
  parts.push(text(timeRight, y + 22, data.time, { size: 11.5, fill: FAINT, anchor: 'end' }))
  return parts.join('')
}

function listPanel(locale) {
  const parts = frame(locale.listTitle, locale.listSub, locale.caption)
  // segmented filter + search + workspace
  let x = 24
  for (const label of locale.filters) {
    const w = Math.max(40, 18 + label.length * 8)
    parts.push(rect(x, 108, w, 24, { stroke: EDGE, rx: 6 }))
    parts.push(text(x + 9, 124, label, { size: 11.5, fill: DIM }))
    x += w + 6
  }
  parts.push(rect(24, 142, 420, 26, { stroke: EDGE, rx: 7 }))
  parts.push(text(36, 159, locale.search, { size: 11.5, fill: FAINT }))
  {
    const chipWidth = textWidth(locale.workspace, 11) + 24
    parts.push(chip(876 - chipWidth, 144, locale.workspace, FAINT, { width: chipWidth }))
  }
  // meta row
  parts.push(text(24, 192, locale.selectAll, { size: 11.5, fill: DIM }))
  parts.push(text(430, 192, locale.suggest, { size: 11.5, fill: OK, anchor: 'middle' }))
  parts.push(text(876, 192, locale.count, { size: 11.5, fill: FAINT, anchor: 'end' }))
  // rows
  let y = 202
  locale.rows.forEach((data, index) => {
    parts.push(row(24, y, data, { checked: index < 4 }))
    y += 38
  })
  // selection bar
  parts.push(rect(24, y + 6, 852, 34, { stroke: EDGE, rx: 7, fill: EDGE, opacity: 0.25 }))
  parts.push(text(36, y + 28, locale.selected, { size: 11.5, fill: DIM }))
  {
    const widths = locale.barActions.map((label) => Math.max(64, textWidth(label, 11.5) + 26))
    let bx = 876 - widths.reduce((total, w) => total + w + 8, -8)
    locale.barActions.forEach((label, index) => {
      const w = widths[index]
      const primary = index === 0
      parts.push(rect(bx, y + 12, w, 22, { stroke: primary ? OK : EDGE, rx: 6, fill: primary ? OK : 'none', opacity: primary ? 0.22 : 1 }))
      parts.push(text(bx + w / 2, y + 27, label, { size: 11.5, fill: primary ? OK : DIM, anchor: 'middle' }))
      bx += w + 8
    })
  }
  return wrap(parts)
}

function confirmPanel(locale) {
  const parts = frame(locale.listTitle, locale.listSub, locale.caption)
  parts.push(rect(24, 116, 852, 34, { stroke: EDGE, rx: 7, fill: EDGE, opacity: 0.25 }))
  parts.push(text(36, 138, locale.selected, { size: 11.5, fill: DIM }))
  let y = 166
  locale.rows.slice(0, 3).forEach((data) => {
    parts.push(row(24, y, data, { checked: true, width: 852 }))
    y += 38
  })
  // confirm block
  const top = y + 14
  parts.push(rect(24, top, 852, 150, { stroke: WARN, rx: 10, fill: WARN, opacity: 0.08, width: 1.5 }))
  parts.push(text(44, top + 32, locale.confirmTitle, { size: 15, weight: 600 }))
  parts.push(text(44, top + 56, locale.confirmBody, { size: 12, fill: DIM }))
  let ty = top + 78
  for (const [label, tone] of locale.tiers) {
    parts.push(text(44, ty, label, { size: 12, fill: tone }))
    ty += 20
  }
  parts.push(text(44, ty + 6, locale.confirmSub, { size: 11, fill: FAINT }))
  let bx = 856 - locale.confirmActions.reduce((total, label) => total + Math.max(72, textWidth(label, 12) + 28) + 10, -10)
  locale.confirmActions.forEach((label, index) => {
    const w = Math.max(72, textWidth(label, 12) + 28)
    const primary = index === 1
    parts.push(rect(bx, top + 112, w, 26, { stroke: primary ? OK : EDGE, rx: 7, fill: primary ? OK : 'none', opacity: primary ? 0.22 : 1 }))
    parts.push(text(bx + w / 2, top + 129, label, { size: 12, fill: primary ? OK : DIM, anchor: 'middle' }))
    bx += w + 10
  })
  return wrap(parts)
}

function binPanel(locale) {
  const parts = frame(locale.binTitle, locale.binSub, locale.binNote)
  parts.push(text(24, 120, locale.selectAll, { size: 11.5, fill: DIM }))
  parts.push(text(876, 120, locale.binCount, { size: 11.5, fill: FAINT, anchor: 'end' }))
  let y = 134
  locale.binRows.forEach((data, index) => {
    parts.push(row(24, y, data, { checked: index === 0 }))
    y += 38
  })
  parts.push(rect(24, y + 8, 852, 34, { stroke: EDGE, rx: 7, fill: EDGE, opacity: 0.25 }))
  parts.push(text(36, y + 30, locale.binSelected, { size: 11.5, fill: DIM }))
  let bx = 856 - locale.binBar.reduce((total, label) => total + Math.max(76, textWidth(label, 11.5) + 26) + 8, -8)
  locale.binBar.forEach((label, index) => {
    const w = Math.max(76, textWidth(label, 11.5) + 26)
    const primary = index === 0
    const danger = index === 1
    parts.push(rect(bx, y + 14, w, 22, {
      stroke: primary ? OK : danger ? DANGER : EDGE, rx: 6,
      fill: primary ? OK : 'none', opacity: primary ? 0.22 : 1,
    }))
    parts.push(text(bx + w / 2, y + 29, label, { size: 11.5, fill: primary ? OK : danger ? DANGER : DIM, anchor: 'middle' }))
    bx += w + 8
  })
  return wrap(parts)
}

const wrap = (parts) => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" role="img">\n  ${parts.join('\n  ')}\n</svg>\n`

const check = process.argv.includes('--check')
let mismatched = 0
let written = 0
for (const [locale, data] of Object.entries(LOCALES)) {
  const files = {
    [`shot-list.${locale}.svg`]: listPanel(data),
    [`shot-confirm.${locale}.svg`]: confirmPanel(data),
    [`shot-bin.${locale}.svg`]: binPanel(data),
  }
  for (const [name, body] of Object.entries(files)) {
    const path = join(OUT.pathname, name)
    if (check === true) {
      let current = ''
      try {
        current = readFileSync(path, 'utf8')
      } catch {
        current = ''
      }
      if (current !== body) {
        mismatched += 1
        console.log(`drift: docs/${name}`)
      }
      continue
    }
    writeFileSync(path, body)
    written += 1
  }
}
console.log(check === true
  ? (mismatched === 0 ? 'documentation artwork is up to date' : `${mismatched} file(s) differ — run node tools/render-docs.mjs`)
  : `wrote ${written} artwork file(s)`)
process.exit(check === true && mismatched > 0 ? 1 : 0)