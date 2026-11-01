#!/usr/bin/env node
// Standalone CLI so the hands work without a dsh restart.
import { call, ensureDaemon, qs } from '../lib/client.mjs'
import { CONFIG_PATH, DEFAULT_PORT, loadConfig, saveConfig } from '../lib/shared.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const flags = {}
const positional = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1 } else { flags[key] = '1' }
  } else positional.push(a)
}
const json = (v) => process.stdout.write(JSON.stringify(v, null, 1) + '\n')

function renderApps(list) {
  const rows = (list || []).map((a) => (a.fg ? '* ' : '  ') + String(a.process).padEnd(22) + '  ' + String(a.title).slice(0, 60) + '   [' + a.hwnd + ']')
  process.stdout.write(rows.join('\n') + '\n')
}

try {
  if (cmd === 'apps') {
    const r = await call('/apps', 30000)
    if (flags.text === '1') renderApps(r.apps)
    else json(r)
  } else if (cmd === 'windows') {
    json(await call('/windows' + qs({ hint: positional.join(' ') || flags.hint }), 30000))
  } else if (cmd === 'focus') {
    json(await call('/focus' + qs({ hint: positional.join(' ') || flags.hint, hwnd: flags.hwnd }), 30000))
  } else if (cmd === 'window') {
    json(await call('/window' + qs({ op: positional[0] || 'restore', hint: positional.slice(1).join(' ') || flags.hint, hwnd: flags.hwnd, rect: flags.rect }), 30000))
  } else if (cmd === 'find') {
    const r = await call('/find' + qs({ hint: flags.hint, name: positional.join(' ') || flags.name, limit: flags.limit, depth: flags.depth }), 45000)
    if (flags.text === '1') {
      // "disabled" is only present when true now (the worker omits false to save
      // bytes on a listing that can be a hundred rows).
      for (const e of r.elements || []) process.stdout.write(String(e.role).padEnd(13) + ' ' + String(e.name || '').slice(0, 46).padEnd(48) + '[' + e.x + ',' + e.y + ' ' + e.w + 'x' + e.h + ']' + (e.disabled ? '  (disabled)' : '') + '\n')
    } else json(r)
  } else if (cmd === 'read') {
    const r = await call('/read' + qs({ hint: positional.join(' ') || flags.hint, max: flags.max }), 45000)
    if (flags.text === '1') process.stdout.write((r.lines || []).join('\n') + '\n')
    else json(r)
  } else if (cmd === 'menu') {
    json(await call('/menu' + qs({ hint: positional.join(' ') || flags.hint }), 45000))
  } else if (cmd === 'click') {
    json(await call('/click' + qs({ hint: flags.hint, hwnd: flags.hwnd, name: positional.join(' ') || flags.name }), 60000))
  } else if (cmd === 'clickat') {
    json(await call('/clickat' + qs({ x: positional[0], y: positional[1] }), 30000))
  } else if (cmd === 'type') {
    json(await call('/type' + qs({ text: positional.join(' ') || flags.text, hint: flags.hint, delay: flags.delay }), 120000))
  } else if (cmd === 'key') {
    json(await call('/key' + qs({ combo: positional.join(' ') || flags.combo, hint: flags.hint }), 30000))
  } else if (cmd === 'run') {
    json(await call('/run' + qs({ target: positional.join(' ') || flags.target }), 45000))
  } else if (cmd === 'api') {
    // What another program would see, plus the local token so an operator can
    // hand it to one without hunting through config.json.
    const d = await call('/descriptor', 15000)
    if (flags.text === '1') {
      process.stdout.write('dsh-watch-hands API v' + d.version + '  base ' + d.base + '\n')
      process.stdout.write('  ' + d.about + '\n')
      process.stdout.write('  ' + d.coordinates + '\n')
      for (const e of d.endpoints) process.stdout.write('  ' + String(e.name).padEnd(12) + '(' + (e.params || '') + ')\n')
      process.stdout.write('\n  token: ' + String(loadConfig().api?.token || '(none)') + '\n')
    } else {
      json({ ...d, token: loadConfig().api?.token || null })
    }
  } else if (cmd === 'history') {
    json(await call('/history', 15000))
  } else if (cmd === 'status') {
    json(await ensureDaemon())
  } else if (cmd === 'stop') {
    try { json(await call('/stop', 5000)) } catch { json({ stopped: 'already down' }) }
  } else if (cmd === 'config') {
    const cfg = loadConfig()
    if (positional[0] === 'set') {
      const dotted = positional[1]
      const value = positional.slice(2).join(' ')
      const parts = dotted.split('.')
      let node = cfg
      for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] ?? {}; node = node[parts[i]] }
      const last = parts[parts.length - 1]
      if (value === 'true') node[last] = true
      else if (value === 'false') node[last] = false
      else if (value === 'null') node[last] = null
      else if (value !== '' && !Number.isNaN(Number(value)) && /^-?[0-9.]+$/.test(value)) node[last] = Number(value)
      else node[last] = value
      saveConfig(cfg)
      json({ saved: dotted, value: node[last], configPath: CONFIG_PATH })
    } else json(cfg)
  } else {
    process.stdout.write([
      'dsh-watch-hands',
      '',
      '  hands apps [--text]                    # 屏幕上开着什么（像看任务栏）',
      '  hands windows <关键字>                  # 按进程/标题过滤',
      '  hands focus <关键字>                    # 提到前台',
      '  hands window <minimise|maximise|restore|close|move> <关键字> [--rect x,y,w,h]',
      '  hands find <按钮名> --hint <窗口> [--text]   # 找控件（无障碍树）',
      '  hands read <窗口> [--text]               # 读它现在显示的字',
      '  hands menu <窗口>                       # 列出菜单栏',
      '  hands click <按钮名> --hint <窗口>        # 按名字点它（真点击）',
      '  hands clickat <x> <y>                   # 按坐标点（逃生口）',
      '  hands type "要打的字" [--hint <窗口>]     # 打中文也行',
      '  hands key ctrl+s [--hint <窗口>]         # 发组合键',
      '  hands run <程序或命令>                   # 启动程序',
      '  hands api [--text]                     # 给别的程序看的接口说明 + token',
      '  hands history | status | stop | config',
      '',
      '  port ' + DEFAULT_PORT + ' (config: ' + CONFIG_PATH + ')',
      '',
    ].join('\n'))
  }
} catch (e) {
  process.stderr.write('hands: ' + String((e && e.message) || e) + '\n')
  process.exit(1)
}
