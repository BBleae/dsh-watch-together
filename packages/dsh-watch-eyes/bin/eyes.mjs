#!/usr/bin/env node
// Standalone CLI so the same pipeline is usable without a dsh restart.
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
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i += 1
    } else {
      flags[key] = '1'
    }
  } else {
    positional.push(a)
  }
}

const json = (v) => process.stdout.write(JSON.stringify(v, null, 1) + '\n')

try {
  if (cmd === 'look') {
    const r = await call(
      '/look' +
        qs({
          prompt: flags.prompt,
          window: flags.window,
          region: flags.region,
          width: flags.width,
          force: flags.force,
        }),
      60000,
    )
    if (flags.text === '1') process.stdout.write(r.text + '\n')
    else json(r)
  } else if (cmd === 'watch') {
    const r = await call(
      '/watch' +
        qs({
          seconds: flags.seconds ?? 20,
          every: flags.every ?? 3,
          max: flags.max,
          prompt: flags.prompt,
          window: flags.window,
          region: flags.region,
        }),
      300000,
    )
    if (flags.text === '1') {
      for (const f of r.frames) process.stdout.write(f.at + '  ' + f.text + '\n')
    } else json(r)
  } else if (cmd === 'say') {
    const text = [positional.join(' '), flags.text].filter(Boolean).join(' ')
    if (!text) throw new Error('usage: eyes say "要念的话"')
    json(await call('/say' + qs({ text }), 60000))
  } else if (cmd === 'said') {
    // What the mouth has said lately (this CLI proxies to it). Kept here so an
    // operator debugging the echo filter does not have to remember two ports.
    json(await call('/said', 10000))
  } else if (cmd === 'mouth') {
    json(await call('/mouth', 6000))
  } else if (cmd === 'narrate') {
    const action = positional[0] ?? 'status'
    if (action === 'start') json(await call('/narrate/start' + qs({ every: flags.every, prompt: flags.prompt }), 45000))
    else if (action === 'stop') json(await call('/narrate/stop', 45000))
    else json(await call('/narrate/status', 45000))
  } else if (cmd === 'devices') {
    // What the speech worker sees, and which one it is pinned to.
    json(await call('/devices', 40000))
  } else if (cmd === 'windows') {
    json(await call('/windows', 30000))
  } else if (cmd === 'doctor') {
    json(await call('/doctor', 60000))
  } else if (cmd === 'status') {
    const h = await ensureDaemon()
    json(h)
  } else if (cmd === 'stop') {
    try {
      json(await call('/stop', 5000))
    } catch {
      json({ stopped: 'already down' })
    }
  } else if (cmd === 'config') {
    const cfg = loadConfig()
    if (positional[0] === undefined) {
      json(cfg)
    } else if (positional[0] === 'set') {
      const dotted = positional[1]
      const value = positional.slice(2).join(' ')
      if (!dotted) throw new Error('usage: eyes config set <dotted.key> <value>')
      const parts = dotted.split('.')
      let node = cfg
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] ?? {}
        node = node[parts[i]]
      }
      const last = parts[parts.length - 1]
      if (value === 'true') node[last] = true
      else if (value === 'false') node[last] = false
      else if (value === 'null') node[last] = null
      else if (value !== '' && !Number.isNaN(Number(value)) && /^-?[0-9.]+$/.test(value)) node[last] = Number(value)
      else node[last] = value
      saveConfig(cfg)
      json({ saved: dotted, value: node[last], configPath: CONFIG_PATH })
    } else {
      json(cfg)
    }
  } else {
    process.stdout.write(
      [
        'dsh-watch-eyes',
        '',
        '  eyes look     [--prompt "..."] [--window "..."] [--region x,y,w,h] [--width 960] [--force] [--text]',
        '  eyes watch    --seconds 20 --every 3 [--window "..."] [--text]',
        '  eyes say "要念的话"                        # 直接朗读一句',
        '  eyes narrate start --every 6             # 开始自动解说（daemon 内部循环）',
        '  eyes narrate stop  |  eyes narrate       # 停止 / 查看已播报内容',
        '  eyes devices                            # 播放设备表 + 语音当前走哪个',
        '  eyes said | ears mouth                   # 最近说过什么 / 口型时钟（转发到 37716）',
        '  eyes windows',
        '  eyes doctor',
        '  eyes status',
        '  eyes stop',
        '  eyes config [set <dotted.key> <value>]',
        '',
        '  port ' + DEFAULT_PORT + ' (config: ' + CONFIG_PATH + ')',
        '',
      ].join('\n'),
    )
  }
} catch (e) {
  process.stderr.write('eyes: ' + String((e && e.message) || e) + '\n')
  process.exit(1)
}
