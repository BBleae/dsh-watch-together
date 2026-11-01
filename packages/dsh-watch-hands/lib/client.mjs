// Thin client: make sure the hands daemon is up, then talk to it over loopback.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, loadConfig, log } from './shared.mjs'

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))

export function handsUrl() {
  return process.env.DSH_HANDS_URL || 'http://127.0.0.1:' + (loadConfig().port ?? DEFAULT_PORT)
}

async function request(pathname, timeoutMs) {
  const res = await fetch(handsUrl() + pathname, { signal: AbortSignal.timeout(timeoutMs ?? 30000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(String((body && body.error) || 'HTTP ' + res.status))
  return body
}

export async function health(timeoutMs) {
  try {
    return await request('/health', timeoutMs ?? 2000)
  } catch {
    return null
  }
}

export function startDaemonDetached() {
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  })
  child.unref()
  return child.pid
}

export async function ensureDaemon(waitMs) {
  const up = await health()
  if (up) return up
  log('hands daemon not running, starting it')
  startDaemonDetached()
  const budget = waitMs ?? 30000
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const h = await health()
    if (h) return h
  }
  throw new Error('hands daemon did not start within ' + Math.round(budget / 1000) + 's; see ~/.dsh-watch-hands/daemon.log')
}

export async function call(pathname, timeoutMs) {
  await ensureDaemon()
  return await request(pathname, timeoutMs)
}

export function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s === '' ? '' : '?' + s
}
