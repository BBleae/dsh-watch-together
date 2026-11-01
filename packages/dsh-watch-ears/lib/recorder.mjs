// One resident PowerShell worker per audio source: recording is blocking inside
// the worker, so loopback and microphone need separate processes to run at the
// same time.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { log } from './shared.mjs'

const WORKER = fileURLToPath(new URL('./worker.ps1', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

export class Recorder {
  constructor(source) {
    this.source = source
    this.child = null
    this.starting = null
    this.waiting = []
    this.segments = 0
    this.lastError = null
  }

  ensure() {
    if (this.child) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      log('starting ' + this.source + ' recorder')
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER, '-Root', ROOT],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      this.child = child
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        if (line === 'READY') return resolve(true)
        const next = this.waiting.shift()
        if (!next) return
        if (line.startsWith('OK|')) {
          const p = line.split('|')
          this.segments += 1
          next.resolve({
            bytes: Number(p[1]),
            peak: Number(p[2]),
            rms: Number(p[3]),
            ms: Number(p[4]),
            format: p[5] ?? '',
            silenceCut: p[6] === 'True',
            speechMs: Number(p[7]) || 0,
            noiseFloor: Number(p[8]) || 0,
            threshold: Number(p[9]) || 0,
          })
        } else if (line.startsWith('ERR|')) {
          this.lastError = line.slice(4)
          next.reject(new Error(this.lastError))
        } else if (line.startsWith('DEVICES|')) {
          next.resolve({ devices: line.slice(8) })
        }
      })
      child.stderr.on('data', (d) => log(this.source + ' recorder stderr: ' + String(d).slice(0, 400)))
      child.on('exit', (code) => {
        log(this.source + ' recorder exited ' + code)
        this.child = null
        this.starting = null
        for (const p of this.waiting.splice(0)) p.reject(new Error('recorder exited'))
      })
      setTimeout(() => reject(new Error(this.source + ' recorder never became ready')), 60000)
    })
    return this.starting
  }

  // silenceMs > 0 endpoint: stop as soon as the speaker pauses, instead of
  // always burning the full window. This is the difference between a call and a
  // walkie-talkie; the transcript can reach the brain 2-3 seconds sooner.
  async record(seconds, outPath, opts = {}) {
    await this.ensure()
    const silenceMs = Number(opts.silenceMs) || 0
    const threshold = Number(opts.threshold) || 0
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('record timeout')), (seconds + 60) * 1000)
      this.waiting.push({
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.child.stdin.write('REC|' + this.source + '|' + seconds + '|' + outPath + '|' + silenceMs + '|' + threshold + '\n')
    })
  }

  async devices() {
    await this.ensure()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('devices timeout')), 30000)
      this.waiting.push({
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.child.stdin.write('DEVICES\n')
    })
  }

  stop() {
    try { if (this.child) this.child.stdin.write('QUIT\n') } catch { /* gone */ }
    try { if (this.child) this.child.kill() } catch { /* gone */ }
    this.child = null
    this.starting = null
  }
}
