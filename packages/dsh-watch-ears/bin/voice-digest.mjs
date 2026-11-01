#!/usr/bin/env node
// 语音沉淀：把当天听过的话压成记忆原料。
//
// 为什么需要这个：语音只说给分身听，分身不带记忆，说完就散。会话不在那条链路上，
// 所以「今天他说过什么」过一夜就没了。这个工具每天把 live 流水里的 mic 行抽出来，
// 去重、分段、算时长，写成一份人能读的原料；再由会话决定哪些进记忆。
//
//   voice-digest                     今天的
//   voice-digest --date 2026-10-26   指定日期
//   voice-digest --min 3             只看至少说了 3 句的时段
//   voice-digest --raw               原样 JSON
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../lib/shared.mjs'

const LIVE = join(DATA_DIR, 'live')
const OUT = join(DATA_DIR, '..', 'voice-digest')
const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const has = (n) => args.includes('--' + n)

const date = flag('date', new Date().toISOString().slice(0, 10))
const minLines = Number(flag('min', 2))

function loadDay(day) {
  const p = join(LIVE, day + '.ndjson')
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    let o = null
    try { o = JSON.parse(line) } catch { continue }
    // Peak gate: measured on this machine, real speech into the microphone sits
    // at 0.30-0.64 while live-stream audio bleeding from the speakers lands at
    // 0.02-0.04. Without this the digest attributes commentary to the user.
    if (o && o.source === 'mic' && o.text && !o.injected && Number(o.peak || 0) >= 0.08) out.push(o)
  }
  return out
}

const rows = loadDay(date)
if (has('raw')) {
  console.log(JSON.stringify(rows, null, 1))
  process.exit(0)
}
if (rows.length === 0) {
  console.log(date + '：语音里没有记录到你说的话')
  process.exit(0)
}

// Group into bursts: a gap over 90 seconds starts a new burst. That is roughly
// "one thing he was talking about", which is the unit worth remembering.
const bursts = []
let cur = null
for (const r of rows) {
  const at = Date.parse(r.at)
  if (!cur || at - cur.end > 90000) {
    cur = { start: at, end: at, lines: [] }
    bursts.push(cur)
  }
  cur.end = at
  cur.lines.push(String(r.text).trim())
}

const hhmm = (ms) => {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const useful = bursts.filter((b) => b.lines.length >= minLines)
const out = []
out.push('# 语音原料 · ' + date)
out.push('')
out.push('共 ' + rows.length + ' 句，' + bursts.length + ' 段，其中 ' + useful.length + ' 段够长（至少 ' + minLines + ' 句）')
out.push('')

// Repetition is kept on purpose: what he says twice is what he cares about.
// Only exact adjacent duplicates collapse, because ASR sometimes emits the same
// tail twice in a row.
for (const b of useful) {
  const lines = []
  for (const t of b.lines) {
    if (lines.length && lines[lines.length - 1] === t) continue
    lines.push(t)
  }
  const mins = Math.max(1, Math.round((b.end - b.start) / 60000))
  out.push('## ' + hhmm(b.start) + '–' + hhmm(b.end) + '（' + mins + ' 分钟，' + lines.length + ' 句）')
  for (const t of lines) out.push('- ' + t)
  out.push('')
}

const text = out.join('\n')
console.log(text)

// Keep a copy so the session can read it later without re-running the tool.
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, date + '.md'), text, 'utf8')
console.error('已存到 ' + join(OUT, date + '.md'))
