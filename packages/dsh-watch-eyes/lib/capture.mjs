// Resident PowerShell capture worker: one long-lived process, one command per line.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { log } from './shared.mjs'

const WORKER = fileURLToPath(new URL('./capture-worker.ps1', import.meta.url))

export class CaptureWorker {
  constructor() {
    this.child = null
    this.rl = null
    this.pending = []
    this.ready = null
    this.frames = 0
    this.lastError = null
  }

  start() {
    if (this.child) return this.ready
    log('starting capture worker')
    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    this.child.stderr.on('data', (d) => log('worker stderr: ' + String(d).slice(0, 500)))
    this.child.on('exit', (code) => {
      log('capture worker exited code=' + code)
      this.child = null
      const err = new Error('capture worker exited (code ' + code + ')')
      for (const p of this.pending.splice(0)) p.reject(err)
    })
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      setTimeout(() => reject(new Error('capture worker did not become ready in 20s')), 20000)
    })
    return this.ready
  }

  onLine(line) {
    if (line === 'READY') {
      log('capture worker ready')
      if (this.readyResolve) this.readyResolve(true)
      return
    }
    const next = this.pending.shift()
    if (!next) return
    if (line.startsWith('ERR|')) {
      this.lastError = line.slice(4)
      next.reject(new Error(this.lastError))
      return
    }
    const parts = line.split('|')
    if (parts[0] === 'WINDOWS') {
      try {
        next.resolve(JSON.parse(parts.slice(1).join('|')))
      } catch (e) {
        next.reject(e)
      }
      return
    }
    if (parts[0] === 'FOREGROUND') {
      // The foreground window arrives as JSON on one line. Kept separate from
      // WINDOWS so a caller cannot mistake the two shapes.
      try {
        next.resolve(JSON.parse(parts.slice(1).join('|')))
      } catch (e) {
        next.reject(e)
      }
      return
    }
    if (parts[0] === 'OK') {
      this.frames += 1
      next.resolve({
        width: Number(parts[1]),
        height: Number(parts[2]),
        hash: parts[3],
        bytes: Number(parts[4]),
        captureMs: Number(parts[5]),
        data: parts[6],
      })
      return
    }
    next.reject(new Error('unexpected worker line: ' + line.slice(0, 120)))
  }

  send(cmd) {
    this.start()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture timeout: ' + cmd.slice(0, 40))), 30000)
      this.pending.push({
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.child.stdin.write(cmd + '\n')
    })
  }

  async windows() {
    return await this.send('WINDOWS')
  }

  // The foreground window, answered by the resident worker instead of a fresh
  // PowerShell. Returns null when the worker does not know the command (older
  // build), so callers can fall back.
  async foreground() {
    try {
      const v = await this.send('FOREGROUND')
      return v || null
    } catch {
      return null
    }
  }

  async capture(opts = {}) {
    const full = !opts.region
    if (full) return await this.send('CAPTURE|full|' + opts.width + '|' + opts.quality)
    const r = opts.region
    return await this.send(
      'CAPTURE|' + r.x + '|' + r.y + '|' + r.w + '|' + r.h + '|' + opts.width + '|' + opts.quality,
    )
  }

  stop() {
    try {
      if (this.child) this.child.stdin.write('QUIT\n')
    } catch {
      /* already gone */
    }
    try {
      if (this.child) this.child.kill()
    } catch {
      /* already gone */
    }
    this.child = null
  }
}

export function resolveRegion(config, win) {
  if (win && typeof win === 'object' && win.w > 0 && win.h > 0) return win
  if (config.region && config.region.w > 0) return config.region
  return null
}
