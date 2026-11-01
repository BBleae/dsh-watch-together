// dsh-watch-ears shared paths and config. Node builtins only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Recordings and show state live with the project.
export const STATE_DIR = join(homedir(), '.dsh-watch-ears')
// Data (recordings, screenshots, frames) is a per-run artefact, not a setting,
// but a published plugin cannot assume a workspace path that only exists on the
// machine it was written on. It lives beside the config, and the env var moves
// it for anyone who wants it elsewhere.
export const DATA_DIR = process.env.DSH_EARS_DATA || join(STATE_DIR, 'data')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const LOG_PATH = join(STATE_DIR, 'daemon.log')
export const AUDIO_DIR = join(DATA_DIR, 'audio')
export const DEFAULT_PORT = 37712
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
    /* diagnostics must never break listening */
  }
}

function seedFromEnv() {
  const key = process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || ''
  if (!key) return null
  return { baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4', apiKey: key }
}

function seedKey() {
  try {
    const j = readJson(MODLENS_CONFIG)
    const p = j.providers?.[j.provider ?? 'openai'] ?? j.providers?.openai
    if (!p || typeof p.apiKey !== 'string' || p.apiKey === '') return null
    return { baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : 'https://open.bigmodel.cn/api/paas/v4', apiKey: p.apiKey }
  } catch {
    return null
  }
}

export function defaultConfig() {
  const seed = seedFromEnv() ?? seedKey() ?? { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' }
  return {
    port: DEFAULT_PORT,
    asr: {
      // 'auto' | 'local' | 'cloud' | 'cloud-sf' - see below.
      backend: 'auto',
      baseUrl: seed.baseUrl,
      apiKey: seed.apiKey,
      model: 'glm-asr-2512',
      timeoutMs: 90000,
    },
    capture: {
      sampleRate: 16000,
      // 12s instead of 6s: a 6 second window guillotines most sentences in half.
      segmentSeconds: 12,
      // Endpointing. >0 means "stop as soon as the speaker pauses this long",
      // instead of always burning the whole window. Call mode wants ~700ms.
      silenceCutMs: 0,
      // Level that counts as speech. Measured on this machine: talking 0.035+,
      // quiet room 0.011.
      speechThreshold: 0.03,
      // Call mode uses a short window plus endpointing.
      callSegmentSeconds: 8,
      // Below this peak the segment is room tone: skip the upload entirely.
      // A microphone in a quiet room still floats above zero, so it gets its
      // own, higher floor.
      silencePeak: 0.004,
      // A microphone floor of 0.02 was measured on a room where the user sits
      // close to the mic. On this machine his peak sits at 0.008-0.015 and that
      // floor skipped him roughly half the time. 0.008 keeps room tone out
      // (rooms measure 0.002-0.004) while catching a normal speaking voice.
      silencePeakMic: 0.008,
      // Longest silent gap that still counts as one utterance, and the minimum
      // amount of actual speech that makes a segment worth transcribing.
      minSpeechMs: 300,
      sources: ['loop', 'mic'],
    },
    hotwords: [],
    // No brain block: the ears hear, they do not answer. Speaking belongs to the
    // mouth (37716) and thinking to the session's own subagent - see
    // docs/FINAL-ARCH.md. A leftover brain.* section in an existing config is
    // ignored, not merged.
  }
}

function applyEnvKey(cfg) {
  if (cfg.asr.apiKey) return cfg
  const env = seedFromEnv()
  if (!env) return cfg
  cfg.asr.apiKey = env.apiKey
  if (!cfg.asr.baseUrl) cfg.asr.baseUrl = env.baseUrl
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
    return applyEnvKey({
      ...base,
      ...user,
      asr: { ...base.asr, ...(user.asr ?? {}) },
      capture: { ...base.capture, ...(user.capture ?? {}) },
    })
  } catch (e) {
    log('config load failed: ' + String(e && e.message))
    return base
  }
}

export function saveConfig(cfg) {
  ensureStateDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}
