// Shared paths, config load/save, logging. Node builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Audio and captures belong to the project, not the home directory.
export const STATE_DIR = join(homedir(), '.dsh-watch-eyes')
// Data (recordings, screenshots, frames) is a per-run artefact, not a setting,
// but a published plugin cannot assume a workspace path that only exists on the
// machine it was written on. It lives beside the config, and the env var moves
// it for anyone who wants it elsewhere.
export const DATA_DIR = process.env.DSH_EYES_DATA || join(STATE_DIR, 'data')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const LOG_PATH = join(STATE_DIR, 'daemon.log')
export const PID_PATH = join(STATE_DIR, 'daemon.pid')
export const DEFAULT_PORT = 37711
const MODLENS_CONFIG = join(homedir(), '.modlens', 'config.json')

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
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
    /* diagnostics must never break a frame */
  }
}

// A credential has to come from somewhere on a fresh install. Two places, in
// order: the environment (a CI or a shell profile), then the modlens config, so
// a machine that already had a vision key configured does not need it pasted
// twice. Nothing is invented here - an empty key produces a 401 that the daemon
// reports as "not configured", not as a network failure.
function seedFromEnv() {
  const key = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || process.env.DSH_VISION_API_KEY || ''
  if (!key) return null
  return {
    baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: key,
  }
}

function seedFromModlens() {
  try {
    const j = readJson(MODLENS_CONFIG)
    const p = j.providers?.[j.provider ?? 'openai'] ?? j.providers?.openai
    if (!p || typeof p.apiKey !== 'string' || p.apiKey === '') return null
    return {
      baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: p.apiKey,
    }
  } catch {
    return null
  }
}

export function defaultConfig() {
  const seed = seedFromEnv() ?? seedFromModlens() ?? { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' }
  return {
    port: DEFAULT_PORT,
    provider: {
      baseUrl: seed.baseUrl,
      apiKey: seed.apiKey,
      model: 'glm-4.6v',
      // Ordered by "costs money first, free last". 2026-10-26 lesson: the paid
      // models all answered 429 "余额不足或无可用资源包" while glm-4v-flash still
      // worked, so a stack with no free entry point goes completely blind the
      // day the balance runs out. The free model is weaker, but a weaker read
      // beats no read.
      fallbackModels: ['glm-5v-turbo', 'glm-4.6v-flashx', 'glm-4v-flash'],
      maxTokens: 80,
      temperature: 0.2,
    },
    capture: { width: 960, quality: 75, window: '', region: null, diffThreshold: 0 },
    prompt: '用一句话说屏幕上在干什么，25字以内，直接说，不要解释。',
    thinking: false,
    // Voice settings moved to ~/.dsh-watch-mouth/config.json with the speaker itself.
    // What stays here is the mouth's address: narration speaks through it.
    mouth: {
      base: 'http://127.0.0.1:37716',
      voice: 'zh-CN-XiaoyiNeural',
    },
    narrate: {
      every: 8,
      prompt: '你是视频实时解说员。用一句自然口语说你看到的画面，像现场解说，不超过25字，口语化，直接说，不要书面语。',
    },
  }
}

// An empty key in the config is not "off": it is "not filled in yet". If the
// environment has one, use it, so exporting a key works without editing JSON.
function applyEnvKey(cfg) {
  if (cfg.provider.apiKey) return cfg
  const env = seedFromEnv()
  if (!env) return cfg
  cfg.provider.apiKey = env.apiKey
  if (!cfg.provider.baseUrl) cfg.provider.baseUrl = env.baseUrl
  return cfg
}

export function loadConfig() {
  const base = defaultConfig()
  try {
    if (!existsSync(CONFIG_PATH)) {
      saveConfig(base)
      return applyEnvKey(base)
    }
    const user = readJson(CONFIG_PATH)
    // A config written before the mouth was split still carries voice/prosody/
    // tts/output. Keeping them here would be dead weight and a second place to
    // change the voice, so the loader ignores them; the mouth seeds itself from
    // this file once on first run and owns them after that.
    const { voice: _v, prosody: _p, tts: _t, output: _o, ...rest } = user
    return applyEnvKey({
      ...base,
      ...rest,
      provider: { ...base.provider, ...(user.provider ?? {}) },
      capture: { ...base.capture, ...(user.capture ?? {}) },
      mouth: { ...base.mouth, ...(user.mouth ?? {}) },
      narrate: { ...base.narrate, ...(user.narrate ?? {}) },
    })
  } catch (e) {
    log('config load failed, using defaults: ' + String(e && e.message))
    return base
  }
}

export function saveConfig(cfg) {
  ensureStateDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

// Hamming distance between two aHash hex strings (64-bit-ish perceptual hash).
export function hashDistance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return 999
  let d = 0
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}
