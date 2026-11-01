// dsh-watch-hands client — for OTHER programs, not for this plugin.
//
// Two ways to use the hands from outside:
//
//   1. Import this file and call it (same machine, Node 18+).
//   2. Speak HTTP directly against /api/v1 (see api.md + GET /api/v1).
//
// Both talk to the same daemon. The daemon is a separate process on purpose: a
// program that drives the desktop must not die with the program that asked, and
// two programs must not each keep their own keyboard driver.
//
//   import { Hands } from 'dsh-watch-hands/lib/sdk.mjs'
//   const hands = new Hands()                    // loopback, no token needed
//   await hands.focus({ hint: '记事本' })
//   await hands.type({ text: '你好', hint: '记事本' })
//   console.log((await hands.read({ hint: '记事本' })).text)
//
//   const remote = new Hands({ base: 'http://192.168.1.9:37717', token: '...' })
//
// Every method returns the daemon's JSON and throws HandsError on a refusal, so a
// caller can tell "policy said no" (403/409) from "it broke" (500).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const API_VERSION = '1'

export class HandsError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'HandsError'
    this.status = status
    this.body = body
    // A refusal is a decision, not a fault: callers should show it, not retry it.
    this.refused = !!(body && (body.refused || body.blocked))
  }
}

// The token the local daemon generated for itself. Reading it from the config is
// how a same-machine client proves it is allowed to drive the desktop without
// anyone copying a secret by hand.
function localToken() {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.dsh-watch-hands', 'config.json'), 'utf8'))
    return (cfg.api && cfg.api.token) || ''
  } catch {
    return ''
  }
}

export class Hands {
  constructor(opts = {}) {
    this.base = String(opts.base || process.env.DSH_HANDS_URL || 'http://127.0.0.1:37717').replace(/\/+$/, '')
    this.token = opts.token !== undefined ? opts.token : localToken()
    this.prefix = (opts.base ? '/api/v1' : '/api/v1')
    this.timeoutMs = opts.timeoutMs || 60000
  }

  async call(name, params = {}, timeoutMs) {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const qs = sp.toString()
    const url = this.base + this.prefix + '/' + name + (qs ? '?' + qs : '')
    const headers = {}
    if (this.token) headers['x-dsh-watch-hands-token'] = this.token
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs || this.timeoutMs) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new HandsError(String(body.error || ('HTTP ' + res.status)), res.status, body)
    return body
  }

  // --- discovery -------------------------------------------------------
  descriptor() { return this.call('descriptor') }
  health() { return this.call('health', {}, 8000) }

  // --- windows ---------------------------------------------------------
  displays() { return this.call('displays') }
  apps() { return this.call('apps') }
  find(params) { return this.call('find', params, 45000) }
  read(params = {}) { return this.call('read', params, 45000) }
  shot(params = {}) { return this.call('shot', params, 45000) }
  focus(params) { return this.call('focus', params, 30000) }
  window(params) { return this.call('window', params, 30000) }

  // --- acting ----------------------------------------------------------
  click(params) { return this.call('click', params) }
  clickAt(params) { return this.call('clickat', params, 30000) }
  type(params) { return this.call('type', params, 120000) }
  key(params) { return this.call('key', params, 30000) }
  wait(params) { return this.call('wait', params, Math.max(15000, Number(params && params.timeout || 3000) + 15000)) }
  run(params) { return this.call('run', params, 45000) }

  // Several steps, one round trip. The reason the hands are usable at all: a step
  // sequence costs one turn, not one turn per step.
  batch(actions, params = {}) { return this.call('batch', { actions, ...params }, 300000) }

  history() { return this.call('history', {}, 15000) }

  // Waits until the daemon answers, so a caller starting a program does not have
  // to sleep an arbitrary amount before its first action.
  async ready(ms = 30000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { return await this.health() } catch { await new Promise((r) => setTimeout(r, 250)) }
    }
    throw new Error('dsh-watch-hands is not reachable at ' + this.base)
  }
}

// Convert a pixel read off a /shot image into a physical screen coordinate.
// The map is returned BY the daemon so a caller never re-derives the scaling (and
// never gets it wrong on a 150% display or a second monitor).
export function imageToScreen(shot, x, y) {
  return {
    x: shot.physical.x + Math.round((x * shot.physical.w) / shot.width),
    y: shot.physical.y + Math.round((y * shot.physical.h) / shot.height),
  }
}

export default Hands
