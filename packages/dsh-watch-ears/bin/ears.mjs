#!/usr/bin/env node
// Standalone CLI so hearing works without a dsh restart.
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

try {
  if (cmd === 'hear') {
    const r = await call('/hear' + qs({ source: flags.source ?? 'loop', seconds: flags.seconds ?? 6, prompt: flags.prompt }), 180000)
    if (flags.text === '1') process.stdout.write((r.text || '(silence)') + '\n')
    else json(r)
  } else if (cmd === 'heard') {
    json(await call('/heard' + qs({ seconds: flags.seconds ?? 300 }), 30000))
  } else if (cmd === 'listen') {
    const action = positional[0] ?? 'status'
    if (action === 'start') json(await call('/listen/start' + qs({ segment: flags.segment, sources: flags.sources }), 120000))
    else if (action === 'stop') json(await call('/listen/stop', 60000))
    else json(await call('/listen/status', 60000))
  } else if (cmd === 'digest') {
    json(await call('/digest' + qs({ seconds: flags.seconds ?? 30, since: flags.since, max: flags.max }), 60000))
  } else if (cmd === 'inject') {
    // Test seam: pretend something was heard, to exercise the pusher without a
    // human in the room. Replaces the old "converse inject".
    const said = positional.join(' ') || flags.text
    if (!said) throw new Error('usage: ears inject --source mic "假装听到的话"')
    json(await call('/inject' + qs({ source: flags.source, text: said }), 60000))
  } else if (cmd === 'asr') {
    // One screen answering "what will happen when someone talks".
    //
    // A user installing this plugin has no way to know whether their machine
    // has a usable GPU, so the plugin states the answer instead of leaving them
    // to read a log after the first failed transcription.
    const cfg = loadConfig()
    const { backendReport } = await import('../lib/asr.mjs')
    const r = backendReport(cfg)
    json({
      ...r,
      help: {
        local: 'needs python + faster-whisper + a model directory (DSH_WHISPER_MODELS)',
        cloud: 'needs a key: ears config set asr.apiKey <key>',
        switch: 'ears config set asr.backend local|cloud|auto, then restart the daemon',
      },
    })
  } else if (cmd === 'devices') {
    json(await call('/devices', 90000))
  } else if (cmd === 'status') {
    json(await ensureDaemon())
  } else if (cmd === 'stop') {
    try { json(await call('/stop', 10000)) } catch { json({ stopped: 'already down' }) }
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
      else if (value !== '' && !Number.isNaN(Number(value)) && /^-?[0-9.]+$/.test(value)) node[last] = Number(value)
      else node[last] = value
      saveConfig(cfg)
      json({ saved: dotted, value: node[last], configPath: CONFIG_PATH })
    } else json(cfg)
  } else {
    process.stdout.write([
      'dsh-watch-ears',
      '',
      '  ears hear     [--source loop|mic] [--seconds 6] [--text]   # 听一段并转写',
      '  ears listen   start [--segment 6] [--sources loop,mic]     # 持续听',
      '  ears listen   stop | status',
      '  ears heard    [--seconds 300]                              # 最近听到了什么',
      '  ears digest   [--seconds 30] [--since <ms>]               # 极简感知摘要（常醒循环用）',
      '  ears inject   [--source mic] "假装听到的话"               # 测试用：注入一句',
      '  ears devices | status | stop | config',
      '',
      '  没有 converse 了。说话在 37716（dsh-watch-mouth），思考在会话自己的子代理里。',
      '',
      '  port ' + DEFAULT_PORT + ' (config: ' + CONFIG_PATH + ')',
      '',
    ].join('\n'))
  }
} catch (e) {
  process.stderr.write('ears: ' + String((e && e.message) || e) + '\n')
  process.exit(1)
}
