// dsh-watch-eyes host half: registers screen_look / screen_watch / screen_doctor.
//
// Registration stays a plain descriptor object on purpose: this file imports
// nothing but its own modules plus node builtins, so it loads from a linked
// plugin directory without needing the host's package tree on the resolution
// path. All the work happens in the resident daemon (lib/daemon.mjs), which
// keeps the PowerShell capture worker and a warm connection to the vision
// endpoint alive between tool calls.
import { call, ensureDaemon, qs } from './client.mjs'
import { CONFIG_PATH } from './shared.mjs'

export const name = 'dsh-watch-eyes'
export const inject = ['tools']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }

// Where the daemons live.
//
// FACE_URL and MOUTH_URL are used by screen_say. Since 2026-10-26 the VOICE is
// its own service (dsh-watch-mouth, 37716) and the face only adds the body: bubble,
// expression, motion. Two paths, one owner each.
//
// Missing a constant here was a real runtime failure once - the fallback threw
// "EYES_URL is not defined" and speech died with a confusing "both down" message
// instead of a plain one.
const MOUTH_URL = process.env.DSH_MOUTH_URL || 'http://127.0.0.1:37716'
const FACE_URL = process.env.DSH_FACE_URL || 'http://127.0.0.1:37714'

function renderText(value) {
  if (value && typeof value.text === 'string') return value.text
  return JSON.stringify(value ?? null)
}

function renderWatch(value) {
  if (!value || !Array.isArray(value.frames)) return renderText(value)
  const lines = value.frames.map((f) => {
    const stamp = typeof f.at === 'string' ? f.at.slice(11, 19) : ''
    return stamp + '  ' + (f.error ? ('[error] ' + f.error) : f.text)
  })
  return lines.join('\n') + '\n\n(' + value.frames.length + ' frames over ' + value.seconds + 's, ' + value.skipped + ' skipped as unchanged)'
}

const lookTool = {
  name: 'screen_look',
  description:
    'Look at the screen right now and get one short sentence back. Captures the desktop (or a titled window) and runs it through a vision model. Use it when the user asks what is on their screen, when a message refers to something visible, or to follow along while they watch or play something. Each call is roughly one second; consecutive calls on an unchanged screen are skipped for free. Prefer screen_watch when following along over several seconds.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Optional question to ask about the frame, e.g. "字幕写了什么". Defaults to a one-line "what is happening" prompt.' },
      window: { type: 'string', description: 'Optional case-insensitive substring of a window title to capture instead of the whole desktop, e.g. "PotPlayer".' },
      region: { type: 'string', description: 'Optional explicit capture rectangle as "x,y,w,h" in screen pixels.' },
      width: { type: 'number', description: 'Downscale the capture to this pixel width before sending (default 960; larger is slower and costs more tokens).' },
      force: { type: 'boolean', description: 'Describe even if the frame looks identical to the previous one.' },
    },
    required: [],
  },
  output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderText(value) }] },
  timeoutMs: 90000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return await call(
      '/look' +
        qs({
          prompt: args?.prompt,
          window: args?.window,
          region: args?.region,
          width: args?.width,
          force: args?.force ? '1' : undefined,
        }),
      60000,
    )
  },
}

const watchTool = {
  name: 'screen_watch',
  description:
    'Watch the screen for several seconds and return a timestamped line per frame. This is the cheap way to follow something moving: one tool call covers many frames instead of one call per frame. Use it while the user watches a video or plays a game and wants a running commentary. Frames that did not change are collapsed. Keep it short: a handful of frames at a time, then report what you saw.',
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'How long to watch, in seconds (2-300, default 20).' },
      every: { type: 'number', description: 'Seconds between frames (0.5-60, default 3).' },
      max: { type: 'number', description: 'Hard cap on frames (default 40).' },
      prompt: { type: 'string', description: 'Optional per-frame question, e.g. "画面里发生了什么，15字内".' },
      window: { type: 'string', description: 'Optional window title substring to capture.' },
    },
    required: [],
  },
  output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderWatch(value) }] },
  timeoutMs: 330000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const seconds = Number(args?.seconds) || 20
    return await call(
      '/watch' +
        qs({
          seconds,
          every: args?.every,
          max: args?.max,
          prompt: args?.prompt,
          window: args?.window,
        }),
      seconds * 1000 + 60000,
    )
  },
}

const doctorTool = {
  name: 'screen_doctor',
  description:
    'Diagnose the screen-eyes vision setup: which model is configured (and whether it answers right now), where the config lives, how many frames the capture worker has served, and the list of visible window titles with their rectangles. Use it to pick a window to watch, or when screen_look fails.',
  parameters: { type: 'object', properties: {}, required: [] },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      if (!value || !value.provider) return renderText(value)
      const lines = [
        'model: ' + value.provider.model + '  fallbacks: ' + (value.provider.fallbacks ?? []).join(', '),
        'endpoint: ' + value.provider.baseUrl + '  key: ' + (value.provider.hasKey ? 'present' : 'MISSING'),
        'probe: primary ' + value.probe.model + ' HTTP ' + value.probe.status + ' in ' + value.probe.ms + 'ms ' + (value.probe.ok ? '(ok)' : '(' + value.probe.detail + ')'),
        value.probe.serving
          ? 'serving: ' + value.probe.serving + (value.probe.degraded ? '  ← FALLBACK, primary is down' : '  (primary)')
          : 'serving: NOTHING - every vision model refused, frames will fail',
        ...(value.probe.models || []).slice(1).map((m) => '  alt ' + m.model + ': ' + (m.ok ? 'ok ' + m.ms + 'ms' : m.status + ' ' + String(m.detail).slice(0, 60))),
        'capture: width ' + value.capture.defaultWidth + ', q' + value.capture.quality + ', window "' + value.capture.window + '", diff<= ' + value.capture.diffThreshold,
        'worker: ' + value.worker.frames + ' frames served' + (value.worker.error ? '  ERROR ' + value.worker.error : ''),
        'windows:',
      ]
      for (const w of value.windows ?? []) {
        lines.push('  [' + w.x + ',' + w.y + ' ' + w.w + 'x' + w.h + '] ' + w.process + ' - ' + w.title)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  timeoutMs: 90000,
  isConcurrencySafe: () => true,
  async execute() {
    return await call('/doctor', 60000)
  },
}

function renderNarrate(value) {
  if (!value) return 'no result'
  if (Array.isArray(value.last)) {
    const head =
      'narration ' + (value.running ? 'RUNNING' : 'stopped') + ' every ' + value.every + 's, spoken ' + value.spoken + ', voice ' + value.voice + (value.error ? ' (error: ' + value.error + ')' : '')
    return [head].concat(value.last.map((l) => '  ' + String(l.at).slice(11, 19) + '  ' + l.text)).join('\n')
  }
  return 'narration ' + (value.running ? 'started' : 'stopped') + ' every ' + value.every + 's, voice ' + value.voice
}

// Speech goes through the FACE daemon (37714) FIRST, then the MOUTH (37716).
//
// The face owns the avatar: it speaks through the mouth and additionally drives
// the on-screen character - bubble, expression, body motion. Calling the mouth
// directly would leave the character standing mute and expressionless while a
// voice came out of nowhere, which is exactly what used to happen when the face
// was skipped.
//
// The direct mouth path is the DEGRADED fallback: sound without a face beats no
// sound at all, and the reply says so.
//
// It must be async. The synchronous path blocks until the audio is queued,
// measured at up to 14.6 seconds on a vendor hiccup, which stalls the whole turn.
const EMOTIONS = ['happy', 'joy', 'cry', 'sad', 'scared', 'fear', 'stunned', 'laugh', 'excited', 'smile', 'idle', 'speak', 'small-laugh', 'big-laugh']

async function faceCall(path, ms) {
  const res = await fetch(FACE_URL + path, { signal: AbortSignal.timeout(ms || 8000) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error('face ' + res.status + ': ' + String(body && body.error ? body.error : 'unknown'))
  return body
}

// Fall back to the mouth on its own if the face daemon is not running, so speech
// still happens when only half the stack is up. The line is heard, the avatar
// is not animated - a trade that is always worth making over silence.
async function mouthSay(text) {
  const res = await fetch(MOUTH_URL + '/say?async=1&text=' + encodeURIComponent(text), { signal: AbortSignal.timeout(8000) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error('mouth ' + res.status + ': ' + String(body && body.error ? body.error : 'unknown'))
  return { ...body, via: 'mouth' }
}

const sayTool = {
  name: 'screen_say',
  description:
    'Speak a short line OUT LOUD through the machine speakers, with the on-screen character moving her body, showing a matching expression and typing it out in a speech bubble. Use this so the user can listen instead of reading while their eyes are busy. A new call interrupts the previous utterance. Keep the line short and spoken-sounding.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The line to speak, ideally under 40 characters of natural spoken language.' },
      emotion: {
        type: 'string',
        enum: EMOTIONS,
        description: 'How she looks while saying it: happy / cry / stunned / big-laugh / small-laugh / idle. Omit to keep the current face. Matches the meaning of the line - a sad beat deserves cry, not happy.',
      },
    },
    required: ['text'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) =>
      [{ type: 'text', text: value && value.via === 'mouth'
          ? 'spoke (voice only, face daemon down): ' + value.text
          : value && value.accepted
            ? 'speaking: ' + value.text + (value.expr && value.expr !== 'none' ? '  [' + value.expr + ']' : '')
            : 'not spoken: ' + String((value && (value.reason || value.error)) || 'unknown') }],
  },
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute(args) {
    if (!args || typeof args.text !== 'string' || args.text.trim() === '') throw new Error('screen_say needs a non-empty "text".')
    const text = args.text.trim()
    const emo = args.emotion ? String(args.emotion) : ''
    try {
      const q = '/say?async=1&text=' + encodeURIComponent(text) + (emo ? '&emotion=' + encodeURIComponent(emo) : '')
      return await faceCall(q, 8000)
    } catch (faceErr) {
      // Face daemon down: the mouth still works on its own.
      try {
        const out = await mouthSay(text)
        return { ...out, faceError: String(faceErr.message).slice(0, 120) }
      } catch (mouthErr) {
        return { spoken: false, reason: 'both down: face=' + String(faceErr.message).slice(0, 60) + ' mouth=' + String(mouthErr.message).slice(0, 60) }
      }
    }
  },
}

const narrateTool = {
  name: 'screen_narrate',
  description:
    'Start or stop autonomous live commentary. While it runs the resident daemon keeps capturing the screen, describing each frame with the vision model and SPEAKING the line aloud, with NO agent turn in the loop - so it reacts every few seconds instead of every ~35s. Use action=start to begin a spoken commentary track the user can listen to while watching, action=stop to end it, action=status to read back what it has said.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start, stop, or status.' },
      every: { type: 'number', description: 'Seconds between commentary frames (2-120, default 8).' },
      prompt: { type: 'string', description: 'Optional custom per-frame instruction, e.g. focus on the plot or read the subtitles.' },
    },
    required: ['action'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    // The harness expects an array of content parts here; a bare string makes
    // it throw "content.some is not a function" at call time.
    render: (_args, value) => [{ type: 'text', text: renderNarrate(value) }],
  },
  timeoutMs: 60000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const action = args && args.action
    if (action === 'start') return await call('/narrate/start' + qs({ every: args.every, prompt: args.prompt }), 45000)
    if (action === 'stop') return await call('/narrate/stop', 45000)
    return await call('/narrate/status', 45000)
  },
}

export function apply(ctx) {
  ensureDaemon().catch(() => {
    /* the first tool call reports the real error */
  })
  for (const tool of [lookTool, watchTool, doctorTool, sayTool, narrateTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.('dsh-watch-eyes: could not register ' + tool.name + ': ' + String(error && error.message))
    }
  }
  ctx.logger?.info?.('dsh-watch-eyes ready (config ' + CONFIG_PATH + ')')
}
