// dsh-watch-hands shared paths and config. Node builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_DIR = join(homedir(), '.dsh-watch-hands')
// Data (recordings, screenshots, frames) is a per-run artefact, not a setting,
// but a published plugin cannot assume a workspace path that only exists on the
// machine it was written on. It lives beside the config, and the env var moves
// it for anyone who wants it elsewhere.
export const DATA_DIR = process.env.DSH_HANDS_DATA || join(STATE_DIR, 'data')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const LOG_PATH = join(STATE_DIR, 'daemon.log')
export const PID_PATH = join(STATE_DIR, 'daemon.pid')
export const DEFAULT_PORT = 37717

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(DATA_DIR, { recursive: true })
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

// Append one line, rotating first if the file has grown past the cap. The same
// rule the four other daemons use: an oversized log is skipped, not read.
const MAX_LOG_BYTES = 2 * 1024 * 1024

function rotateIfBig() {
  try {
    if (statSync(LOG_PATH).size < MAX_LOG_BYTES) return
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
    /* diagnostics must never break a click */
  }
}

export function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    // The HTTP surface other programs are allowed to call.
    //
    // Loopback-only was enough while this was a plugin talking to itself. The
    // moment another program is a client, two things change: the contract needs
    // a version (so a client can refuse to talk to an incompatible daemon), and
    // the surface needs a token (so "anything on this machine" is not the same
    // as "anything allowed to drive my desktop").
    api: {
      // Versioned base path. Old clients keep working when the version bumps;
      // an unversioned one silently breaks them.
      base: '/api/v1',
      // Loopback callers do not need a token: they are this machine's own tools,
      // and forcing a secret there only makes local use awkward. Anything else
      // MUST present it.
      requireTokenForLoopback: false,
      // Empty = generate one on first start and store it here.
      token: '',
    },
    // Windows the hands must never touch. Its own host is first on the list: an
    // agent that can type into its own conversation can rewrite its own input,
    // and "the AI decided to say something else" is not a recoverable state.
    // Password managers are the other obvious category: reading one is bad, but
    // clicking in one is how a credential ends up in the wrong field.
    guard: {
      deny: ['DeepSeek Harness', '1Password', 'Bitwarden', 'KeePass', 'LastPass'],
      // Substring match against process name + window title, case-insensitive.
      denyProcesses: ['1password', 'bitwarden', 'keepass', 'lastpass'],
    },
    // Actions that are allowed to happen. The hands can reach every window on
    // this machine, which is a lot of authority for a tool that a model calls.
    // The default is full control because that is the point, but every action
    // is logged with the window it touched, so "what did it do" is answerable
    // after the fact rather than only during.
    allow: {
      // Destructive keystrokes are opt-in: a stray alt+f4 loses unsaved work and
      // cannot be undone by looking at the screen.
      destructiveKeys: true,
      // Launching programs. Kept on; turn off to make the hands drive-only.
      run: true,
    },
    // A pause between the key-down and the app's reaction, in ms. Some apps drop
    // the first key of a chord when it arrives in the same frame as focus.
    settleMs: 180,
    // Type speed. A person types with gaps; a machine that pastes 200 characters
    // with no delay trips "are you a robot" heuristics in some apps and gets
    // dropped characters in others.
    typeDelayMs: 6,
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
    return { ...base, ...user, allow: { ...base.allow, ...(user.allow ?? {}) } }
  } catch (e) {
    log('config load failed, using defaults: ' + String(e && e.message))
    return base
  }
}

export function saveConfig(cfg) {
  ensureStateDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}
