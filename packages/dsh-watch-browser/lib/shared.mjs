// dsh-watch-browser shared paths and config. Node builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Data lands in the project workspace, not the home directory: screenshots are
// per-run artefacts the user wants to inspect and delete, not settings.
export const STATE_DIR = join(homedir(), '.dsh-watch-browser')
// Data (recordings, screenshots, frames) is a per-run artefact, not a setting,
// but a published plugin cannot assume a workspace path that only exists on the
// machine it was written on. It lives beside the config, and the env var moves
// it for anyone who wants it elsewhere.
export const DATA_DIR = process.env.DSH_BROWSER_DATA || join(STATE_DIR, 'data')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const LOG_PATH = join(STATE_DIR, 'daemon.log')
export const USER_DATA_DIR = join(STATE_DIR, 'profile')
export const SHOT_DIR = join(DATA_DIR, 'shots')
export const DEFAULT_PORT = 37713

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(SHOT_DIR, { recursive: true })
}

// Read a JSON file that may carry a UTF-8 BOM.
//
// PowerShell's `Set-Content -Encoding UTF8` on Windows PowerShell 5.1 writes a
// BOM, and a user editing config.json in Notepad may too. JSON.parse rejects
// the leading U+FEFF, and the loader then silently falls back to DEFAULTS -
// so "I set the port/key and it ignored me" is the symptom, with no error
// logged anywhere the user would look.
function readJson(file) {
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
}

// Append one line, rotating first if the file has grown past `MAX_LOG_BYTES`.
//
// These logs are append-only and nobody prunes them: the browser daemon's log
// reached 13.9 MB, and a 429 storm or a capture loop can add a line per frame.
// A log that big is not read carefully, it is skipped - which is the same as not
// having one. Rotation keeps the last ~2 MB and one previous file, which is
// enough to explain an outage and small enough to open.
const MAX_LOG_BYTES = 2 * 1024 * 1024

function rotateIfBig() {
  try {
    const st = statSync(LOG_PATH)
    if (st.size < MAX_LOG_BYTES) return
    // Keep exactly one generation: .1 is the previous file, overwritten each
    // time. A dated chain of archives would need a policy for deleting them,
    // and there is no operator here to run one.
    renameSync(LOG_PATH, LOG_PATH + '.1')
  } catch {
    /* no file yet, or a rename race with another writer: appending still works */
  }
}

export function log(line) {
  try {
    ensureStateDir()
    rotateIfBig()
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* diagnostics must never break the browser */
  }
}

export function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    headless: false,
    // "msedge" reuses the installed Edge instead of a downloaded Chromium.
    channel: 'msedge',
    // When false the subtitle crop returns instantly without touching the
    // vision model. Call mode does not need subtitles at all, and the OCR call
    // (1.5-6.5s) was blocking the pusher and delaying voice replies by 10-20s.
    subtitles: true,
    // When set (e.g. http://127.0.0.1:9222) the daemon attaches to an ALREADY
    // RUNNING browser over CDP instead of launching its own. That is the only
    // way to reuse a profile a human is logged into. It also means full control
    // of that browser, so it stays empty unless the operator asks for it.
    cdpUrl: '',
    startUrl: 'about:blank',
    // Credentials live here, never in the repo and never in a log line.
    accounts: { bilibili: { user: '', password: '' } },
  }
}

export function loadConfig() {
  const base = defaultConfig()
  try {
    if (!existsSync(CONFIG_PATH)) {
      saveConfig(base)
      return base
    }
    const user = readJson(CONFIG_PATH)
    return { ...base, ...user, accounts: { ...base.accounts, ...(user.accounts ?? {}) } }
  } catch (e) {
    log('config load failed: ' + String(e && e.message))
    return base
  }
}

export function saveConfig(cfg) {
  ensureStateDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}
