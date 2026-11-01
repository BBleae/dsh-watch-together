// Local Windows OCR, kept warm.
//
// A one-shot PowerShell OCR call costs ~400ms of process start before any
// recognition happens. This holds one worker alive and speaks to it over
// stdin/stdout, so a subtitle line is read in ~70ms instead of ~840ms over
// the network - an order of magnitude that decides whether a reaction lands
// while the shot is still on screen.
//
// Quality matters as much as speed: Windows OCR needs glyph pixels. A native
// 1460px crop read '谁家好个用些 ep § eek' while the same frame at 2x scale
// read '谁家好人用 Deepseek' correctly, so the crop is taken at 2x.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { log } from './shared.mjs'

// The worker lives next to this file: the ears pusher is its only consumer
// (it reads subtitles), so it moved out of the eyes plugin with the rest of the
// vision-only code. An env override still wins for probes and benchmarks.
const WORKER = process.env.DSH_OCR_WORKER || fileURLToPath(new URL('./ocr-worker.ps1', import.meta.url))

export class LocalOcr {
  constructor() {
    this.child = null
    this.ready = null
    this.waiting = []
  }

  start() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const rl = createInterface({ input: this.child.stdout })
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('ocr worker never ready')) } }, 15000)
      rl.on('line', (raw) => {
        // PowerShell writes CRLF; readline keeps the CR, so trim before compare.
        const line = String(raw).trim()
        if (!settled && line === 'READY') { settled = true; clearTimeout(timer); resolve(true); return }
        const next = this.waiting.shift()
        if (!next) return
        if (line.startsWith('TEXT|')) next.resolve(line.slice(5))
        else if (line.startsWith('ERR|')) next.reject(new Error(line.slice(4)))
        else next.resolve('')
      })
      this.child.stderr.on('data', (d) => log('ocr worker stderr: ' + String(d).slice(0, 300)))
      this.child.on('exit', (code) => {
        log('ocr worker exited ' + code)
        this.child = null
        this.ready = null
        for (const p of this.waiting.splice(0)) p.reject(new Error('ocr worker exited'))
      })
    }).catch((e) => { this.ready = null; throw e })
    return this.ready
  }

  async read(path) {
    await this.start()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ocr timeout')), 15000)
      this.waiting.push({
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      // WinRT's GetFileFromPathAsync rejects forward slashes with a misleading
      // "path too long" error, so normalise to backslashes here.
      const win = String(path).replace(/\//g, '\\')
      this.child.stdin.write('OCR|' + win + '\n')
    })
  }

  stop() {
    try { this.child?.stdin.write('QUIT\n') } catch { /* gone */ }
    try { this.child?.kill() } catch { /* gone */ }
    this.child = null
    this.ready = null
  }
}
