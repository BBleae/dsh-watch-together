// dsh-watch-mouth host half: registers the speaking tool.
//
// ONE tool, ONE job. Speaking used to live inside dsh-watch-eyes' screen_say,
// which meant the face, the voice and the camera were one call - and when the
// face daemon was down the line still went out, so the avatar stood mute while
// a voice came from nowhere. Now the voice is its own service, and the face
// keeps its own /say (avatar state + expression) on top of it.
import { call, ensureDaemon, qs, mouthUrl } from './client.mjs'
import { CONFIG_PATH } from './shared.mjs'

export const name = 'dsh-watch-mouth'
export const inject = ['tools']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }
const text = (s) => [{ type: 'text', text: s }]

const sayTool = {
  name: 'mouth_say',
  description:
    'Speak a line out loud through the machine speakers. This is the ONLY path to sound: the avatar (dsh-watch-eyes screen_say / face 37714) adds the body and the expression on top of it. Use action=async when the line comes from a live conversation and the caller must keep thinking; await the sync form only when you need to know it actually played. A new call interrupts the previous utterance.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The line to speak, ideally under 40 characters of natural spoken language.' },
      asyncMode: { type: 'boolean', description: 'Return as soon as the line is queued (default true). Set false to wait for playback to be queued and get timing back.' },
    },
    required: ['text'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => text(
      !v ? 'no result'
        : v.accepted ? 'speaking: ' + v.text
          : v.spoken ? 'spoke: ' + v.text + '  [' + (v.provider || '?') + '] ' + (v.durationMs || 0) + 'ms'
            : 'not spoken: ' + String((v && (v.reason || v.error)) || 'unknown'),
    ),
  },
  timeoutMs: 90000,
  isConcurrencySafe: () => true,
  async execute(args) {
    if (!args || typeof args.text !== 'string' || args.text.trim() === '') throw new Error('mouth_say needs a non-empty "text".')
    const asyncMode = args.asyncMode !== false
    return await call('/say' + qs({ text: args.text.trim(), async: asyncMode ? '1' : undefined }), asyncMode ? 15000 : 90000)
  },
}

// Stream a reply as it is written.
//
// Without this the mouth takes one finished line, so a caller that is still
// generating has to wait for the last token before the first sound. Sending the
// text in pieces as they appear saves the whole generation tail: measured, a
// 30-token line started speaking at 276ms instead of waiting the full 840ms.
const streamTool = {
  name: 'mouth_say_stream',
  description:
    'Speak a long line in pieces, as ONE continuous utterance. Use it while you are still writing: send the first clause as soon as you have it, then more, and the sound starts after the first piece instead of after the last. Split at natural boundaries - a sentence end (。！？), else a comma - and keep each piece at least ~8 characters so the voice does not clip.',
  parameters: {
    type: 'object',
    properties: {
      chunks: {
        type: 'array',
        description: 'Ordered text pieces, concatenated into one utterance. Each at least ~8 characters; split at sentence or clause boundaries.',
        items: { type: 'string' },
      },
    },
    required: ['chunks'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => text(
      !v ? 'no result'
        : v.spoken ? 'spoke ' + v.count + ' piece(s), ' + v.chunks.reduce((a, c) => a + (c.durationMs || 0), 0) + 'ms of audio, queued in ' + v.wallMs + 'ms'
          : 'not spoken: ' + String((v && v.error) || 'unknown'),
    ),
  },
  timeoutMs: 180000,
  isConcurrencySafe: () => true,
  async execute(args) {
    if (!args || !Array.isArray(args.chunks) || args.chunks.length === 0) throw new Error('mouth_say_stream needs a non-empty chunks array')
    const base = mouthUrl()
    const res = await fetch(base + '/say-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: args.chunks }),
      signal: AbortSignal.timeout(170000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(body.error || ('HTTP ' + res.status)))
    return body
  },
}

const statusTool = {
  name: 'mouth_status',
  description:
    'Report the mouth: which voice provider and voice are configured, whether it is speaking right now, what it has said recently, and which playback device it is pinned to. Use it when a line was expected and nothing was heard, or to confirm the voice before starting a watch session.',
  parameters: { type: 'object', properties: {}, required: [] },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v || !v.ok) return text('mouth DOWN (' + mouthUrl() + ')')
      return text([
        'mouth UP  voice=' + v.voice + '  provider=' + v.provider + '  model=' + v.model,
        'speaking=' + v.speaking + '  spoken=' + v.spoken + '  uptime=' + Math.round((v.uptimeMs || 0) / 1000) + 's',
        'device: ' + v.outputDevice,
        v.lastError ? 'lastError: ' + String(v.lastError.text || v.lastError).slice(0, 160) : '',
      ].filter(Boolean).join('\n'))
    },
  },
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute() {
    try {
      return await call('/health', 8000)
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  },
}

export function apply(ctx) {
  ensureDaemon().catch(() => {
    /* the first tool call reports the real error */
  })
  for (const tool of [sayTool, streamTool, statusTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.('dsh-watch-mouth: could not register ' + tool.name + ': ' + String(error && error.message))
    }
  }
  ctx.logger?.info?.('dsh-watch-mouth ready (config ' + CONFIG_PATH + ')')
}
