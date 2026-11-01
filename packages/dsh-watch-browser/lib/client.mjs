// Thin client: make sure the browser daemon is up, then talk to it over loopback.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, loadConfig, log } from './shared.mjs'

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))

async function request(pathname, timeoutMs) {
  const cfg = loadConfig()
  const port = cfg.port ?? DEFAULT_PORT
  const res = await fetch('http://127.0.0.1:' + port + pathname, { signal: AbortSignal.timeout(timeoutMs ?? 120000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(String((body && body.error) || 'HTTP ' + res.status))
  return body
}

export async function health(timeoutMs) {
  try { return await request('/health', timeoutMs ?? 2000) } catch { return null }
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
  log('browser daemon not running, starting it')
  startDaemonDetached()
  const budget = waitMs ?? 40000
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    const h = await health()
    if (h) return h
  }
  throw new Error('browser daemon did not start within ' + Math.round(budget / 1000) + 's; see ~/.dsh-watch-browser/daemon.log')
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
