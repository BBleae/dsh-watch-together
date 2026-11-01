// Resident PowerShell UI Automation worker.
//
// One long-lived process, one command per line, one JSON answer per command. A
// cold start costs ~1.2s (PowerShell + Add-Type of the automation assemblies +
// the interop class), which per click would make the hands useless. Kept warm it
// is ~50ms per action, which is what a person perceives as "it did that".
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { log } from './shared.mjs'

const WORKER = fileURLToPath(new URL('./uia-worker.ps1', import.meta.url))

// The control-role vocabulary the worker matches by ("button:Save"). It lives
// HERE, not in the .ps1, because PowerShell 5.1 reads a BOM-less script as GBK:
// one CJK literal in that file becomes a parse error on the whole worker. Sending
// the table as base64 JSON at startup keeps the script pure ASCII.
const ROLES = {
  button: 'Button', '按钮': 'Button',
  menu: 'MenuItem', menuitem: 'MenuItem', '菜单': 'MenuItem', '菜单项': 'MenuItem',
  edit: 'Edit', input: 'Edit', textbox: 'Edit', '输入框': 'Edit', '文本框': 'Edit',
  tab: 'TabItem', '标签': 'TabItem', '标签页': 'TabItem', '选项卡': 'TabItem',
  link: 'Hyperlink', '链接': 'Hyperlink',
  checkbox: 'CheckBox', '复选框': 'CheckBox',
  radio: 'RadioButton', '单选': 'RadioButton', '单选框': 'RadioButton',
  combo: 'ComboBox', combobox: 'ComboBox', '下拉框': 'ComboBox',
  item: 'ListItem', listitem: 'ListItem', '列表项': 'ListItem',
  treeitem: 'TreeItem', dataitem: 'DataItem',
  text: 'Text', '文本': 'Text', '文字': 'Text',
}

export class HandsWorker {
  constructor() {
    this.child = null
    this.ready = null
    this.waiting = []
    this.actions = 0
    this.lastError = null
    this.startedAt = 0
  }

  start() {
    if (this.ready) return this.ready
    this.startedAt = Date.now()
    this.child = spawn(
      'powershell.exe',
      // The pid is the worker's only way to notice a hard kill of this process.
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER, String(process.pid)],
      // stdin is the worker's lifeline: it reads a command per line and exits when
      // the stream closes. If this process dies abruptly nothing closes stdin, so
      // the worker survives as an orphan holding a UIA subscription - measured:
      // four of them accumulated after a few restarts. A child that outlives its
      // parent is not a "worker", it is a leak.
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: false },
    )
    const rl = createInterface({ input: this.child.stdout })
    let settled = false
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('hands worker did not become ready in 25s'))
      }, 25000)
      rl.on('line', (line) => {
        if (!settled && line.trim() === 'READY') {
          settled = true
          clearTimeout(timer)
          log('uia worker ready in ' + (Date.now() - this.startedAt) + 'ms')
          // Hand over the role vocabulary before serving anything: matching by
          // "button:Save" needs the table, and an empty table would silently
          // treat every target as "no role specified" (still works, less precise).
          this.waiting.push({
            resolve: () => resolve(true),
            reject: (e) => reject(e),
          })
          const payload = Buffer.from(JSON.stringify(ROLES), 'utf8').toString('base64')
          try { this.child.stdin.write('ROLES|' + payload + '\n') } catch { /* worker already gone */ }
          return
        }
        const next = this.waiting.shift()
        if (!next) return
        if (line.startsWith('ERR|')) {
          this.lastError = line.slice(4)
          next.reject(new Error(this.lastError))
          return
        }
        next.resolve(line.startsWith('OK|') ? line.slice(3) : line)
      })
      this.child.stderr.on('data', (d) => {
        const s = String(d).trim()
        if (s) log('uia stderr: ' + s.slice(0, 400))
      })
      this.child.on('exit', (code) => {
        log('uia worker exited ' + code)
        this.child = null
        this.ready = null
        for (const w of this.waiting.splice(0)) w.reject(new Error('uia worker exited'))
      })
    }).catch((e) => {
      this.ready = null
      throw e
    })
    return this.ready
  }

  async send(cmd, timeoutMs) {
    await this.start()
    const line = this.waiting.length
    return await new Promise((resolve, reject) => {
      const entry = {
        resolve: (v) => {
          clearTimeout(timer)
          this.actions += 1
          try { resolve(JSON.parse(v)) } catch { resolve(v) }
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry)
        if (i >= 0) this.waiting.splice(i, 1)
        reject(new Error('uia timeout: ' + cmd.split('|')[0]))
      }, timeoutMs ?? 30000)
      this.waiting.push(entry)
      try {
        this.child.stdin.write(cmd + '\n')
      } catch {
        this.waiting.pop()
        clearTimeout(timer)
        reject(new Error('uia worker stdin closed'))
      }
    })
  }

  get queued() {
    return this.waiting.length
  }

  // Kill the worker from an exit hook, synchronously.
  //
  // process.on('exit') cannot await anything, so this sends the quit line (the
  // worker's own clean path) and then kills the pid. Both are best effort: the
  // point is that no code path leaves a PowerShell process behind.
  killNow() {
    try { this.child?.stdin.write('QUIT\n') } catch { /* gone */ }
    try { this.child?.kill() } catch { /* gone */ }
    this.child = null
    this.ready = null
  }

  stop() {
    try { this.child?.stdin.write('QUIT\n') } catch { /* gone */ }
    try { this.child?.kill() } catch { /* gone */ }
    this.child = null
    this.ready = null
  }
}
