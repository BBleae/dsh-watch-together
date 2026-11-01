#!/usr/bin/env node
// Standalone CLI so the browser is drivable without a dsh restart.
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
  if (cmd === 'goto' || cmd === 'open') {
    json(await call('/do' + qs({ action: 'goto', url: positional[0] ?? flags.url, ms: flags.ms }), 180000))
  } else if (cmd === 'do') {
    json(await call('/do' + qs({ action: positional[0], selector: flags.selector, text: flags.text ?? positional.slice(1).join(' '), value: flags.value, ms: flags.ms, url: flags.url, full: flags.full }), 180000))
  } else if (cmd === 'state') {
    json(await call('/state', 120000))
  } else if (cmd === 'launch-cdp') {
    // Relaunch the isolated Chrome that the daemon attaches to over CDP. It has
    // to be started NORMALLY (not by Playwright) or navigator.webdriver is true
    // and a behavioural captcha refuses to run.
    const { spawn } = await import('node:child_process')
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const profileDir = path.join(os.homedir(), '.dsh-watch-browser', 'chrome-profile')
    fs.mkdirSync(profileDir, { recursive: true })
    const chrome = flags.exe ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    if (!fs.existsSync(chrome)) throw new Error('chrome.exe not found at ' + chrome + ' (pass --exe)')
    const port = String(flags.port ?? 9222)
    const args = [
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + port,
      '--no-first-run',
      '--no-default-browser-check',
      positional[0] ?? 'https://www.bilibili.com',
    ]
    // Launch through WMI, not spawn().
    //
    // Everything DSH spawns inherits its Windows job object, and closing DSH
    // terminates the whole job - which killed this browser every time the app
    // exited. A process created by Win32_Process.Create is parented to
    // WmiPrvSE.exe, outside that job, so it survives.
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const cmdline = '"' + chrome + '" ' + args.map((a) => '"' + a + '"').join(' ')
    const ps = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ' +
      "'" + cmdline.replace(/'/g, "''") + "'" + ' } | Select-Object -ExpandProperty ProcessId'
    const dir = mkdtempSync(tmpdir() + '\\dsh-watch-browser-')
    const script = dir + '\\launch.ps1'
    writeFileSync(script, ps, 'utf8')
    const { execFileSync } = await import('node:child_process')
    let pid = 0
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' })
      pid = Number(String(out).trim()) || 0
    } catch (e) {
      throw new Error('WMI launch failed: ' + String(e && e.message).slice(0, 200))
    }
    const cfg2 = loadConfig()
    cfg2.cdpUrl = 'http://127.0.0.1:' + port
    saveConfig(cfg2)
    json({ launched: true, pid, profileDir, cdpUrl: cfg2.cdpUrl, via: 'Win32_Process.Create (survives DSH exit)', note: 'daemon will attach to this browser; restart it if it was already running' })
  } else if (cmd === 'status') {
    json(await ensureDaemon())
  } else if (cmd === 'stop') {
    try { json(await call('/stop', 15000)) } catch { json({ stopped: 'already down' }) }
  } else if (cmd === 'set-account') {
    // ears-style: browser set-account bilibili <user> <password>
    const cfg = loadConfig()
    cfg.accounts = cfg.accounts ?? {}
    cfg.accounts[positional[0]] = { user: positional[1] ?? '', password: positional[2] ?? '' }
    saveConfig(cfg)
    json({ saved: positional[0], hasUser: !!positional[1], hasPassword: !!positional[2], configPath: CONFIG_PATH })
  } else if (cmd === 'play') {
    json(await call('/do' + qs({ action: 'play', ms: flags.ms }), 120000))
  } else if (cmd === 'pause') {
    json(await call('/do' + qs({ action: 'pause' }), 120000))
  } else {
    process.stdout.write([
      'dsh-watch-browser',
      '',
      '  browser goto <url>                        # 打开页面',
      '  browser play | pause                      # 控制页面里的 <video>',
      '  browser do <action> [--selector .. --text .. --value .. --ms ..]',
      '        actions: goto click fill press eval wait seek mute volume screenshot back reload',
      '                 login-bilibili',
      '  browser state                             # 当前 url / 标题 / 视频状态',
      '  browser launch-cdp [url]                   # 拉起隔离 Chrome（正常启动+调试端口）',
      '  browser set-account <site> <user> <password>',
      '  browser status | stop',
      '',
      '  port ' + DEFAULT_PORT + ' (config: ' + CONFIG_PATH + ')',
      '',
    ].join('\n'))
  }
} catch (e) {
  process.stderr.write('browser: ' + String((e && e.message) || e) + '\n')
  process.exit(1)
}
