#!/usr/bin/env node
// Read the live observation stream.
//
// Why this exists: the parent session cannot be woken by the pusher (the host
// rejects inbox delivery to a root session), so it polls this file instead. One
// command answers "what happened while I was thinking".
//
//   live read [--seconds 600] [--max 80]          对白 + 画面，人类可读
//   live read --json                              原样 JSON
//   live mark                                     记下当前位置（下次只读新的）
//   live since                                    从上次 mark 开始读
//   live stats                                    今天记了多少
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from '../lib/shared.mjs'

// The same DATA_DIR the daemon writes to. Hard-coding it meant this reader and
// the recorder could disagree after the workspace moved, and "nothing heard today"
// looked like a dead microphone instead of a wrong path.
const DIR = join(DATA_DIR, 'live')
const MARK = join(DIR, '.mark')
const [cmd, ...rest] = process.argv.slice(2)

const flag = (name, dflt) => {
  const i = rest.indexOf('--' + name)
  return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt
}
const has = (name) => rest.includes('--' + name)

function readRows(sinceMs, limit) {
  let files = []
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.ndjson')).sort() } catch { return [] }
  const rows = []
  for (const f of files) {
    const dayStart = Date.parse(f.replace('.ndjson', '') + 'T00:00:00Z')
    if (!Number.isFinite(dayStart) || dayStart + 86400000 < sinceMs) continue
    let text = ''
    try { text = readFileSync(join(DIR, f), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line) continue
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      if (o && o.at && Date.parse(o.at) >= sinceMs) rows.push(o)
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return rows.slice(-limit)
}

const hhmmss = (iso) => {
  const d = new Date(iso)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
}

if (cmd === 'read' || cmd === 'since') {
  let since = Date.now() - Number(flag('seconds', 600)) * 1000
  if (cmd === 'since' && existsSync(MARK)) {
    const m = Number(readFileSync(MARK, 'utf8').trim())
    if (Number.isFinite(m) && m > 0) since = m
  }
  const limit = Number(flag('max', 80))
  const rows = readRows(since, limit)
  if (has('json')) {
    console.log(JSON.stringify(rows, null, 1))
  } else if (rows.length === 0) {
    console.log('（这段时间什么都没听到）')
  } else {
    for (const r of rows) {
      const tag = r.source === 'loop' ? '视频' : (r.source === 'mic' ? '我' : '脑')
      const loud = r.peak ? ' p=' + Number(r.peak).toFixed(2) : ''
      console.log(hhmmss(r.at) + ' [' + tag + ']' + loud + ' ' + String(r.text))
    }
    console.log('')
    console.log('共 ' + rows.length + ' 条')
  }
} else if (cmd === 'mark') {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(MARK, String(Date.now()), 'utf8')
  console.log('已记下位置')
} else if (cmd === 'stats') {
  let files = []
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.ndjson')).sort() } catch { files = [] }
  if (files.length === 0) { console.log('今天还没记东西'); process.exit(0) }
  for (const f of files) {
    const rows = readRows(0, 999999).filter(() => true)
    let n = 0, mic = 0, vid = 0
    for (const line of readFileSync(join(DIR, f), 'utf8').split('\n')) {
      if (!line) continue
      let o = null
      try { o = JSON.parse(line) } catch { continue }
      if (!o) continue
      n++
      if (o.source === 'mic') mic++
      else if (o.source === 'loop') vid++
    }
    console.log(f + '  ' + n + ' 条（我 ' + mic + ' / 视频 ' + vid + '）')
  }
} else {
  console.log('live read | live since | live mark | live stats')
}
