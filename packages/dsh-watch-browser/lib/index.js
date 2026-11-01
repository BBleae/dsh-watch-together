// dsh-watch-browser host half: drive a real Chromium window.
//
// Two tools only, so the schema stays cheap on every request: one action
// dispatcher and one state reader.
import { call, ensureDaemon, qs } from './client.mjs'
import { CONFIG_PATH } from './shared.mjs'

export const name = 'dsh-watch-browser'
export const inject = ['tools']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }
const text = (s) => [{ type: 'text', text: s }]

const doTool = {
  name: 'browser_do',
  description:
    'Drive a real Chromium window: open pages, click, type, run javascript, control the page video, take screenshots. The browser profile is persistent, so logins survive. Use it to put content on screen for the hearing and vision tools to check, e.g. open a video and let it play. action=login-bilibili signs in with the stored account; a captcha may still need a human.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['goto', 'click', 'fill', 'press', 'eval', 'wait', 'play', 'pause', 'seek', 'mute', 'volume', 'screenshot', 'back', 'reload', 'login-bilibili'],
        description: 'What to do.',
      },
      url: { type: 'string', description: 'Target url for action=goto.' },
      selector: { type: 'string', description: 'CSS selector for click / fill / press.' },
      text: { type: 'string', description: 'Text for fill, key name for press, javascript source for eval.' },
      value: { type: 'number', description: 'Seconds for seek, 0..1 for volume.' },
      ms: { type: 'number', description: 'Extra settle time in milliseconds after the action.' },
      full: { type: 'boolean', description: 'Full page screenshot.' },
    },
    required: ['action'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v) return text('no result')
      if (v.path) return text('screenshot saved: ' + v.path)
      if (v.action === 'login-bilibili') return text((v.ok ? 'logged in to bilibili' : 'bilibili login incomplete') + '  url=' + v.url + (v.note ? '  (' + v.note + ')' : ''))
      if (v.value !== undefined) return text('eval -> ' + JSON.stringify(v.value).slice(0, 800))
      if (v.media) return text(v.action + ' -> paused=' + v.media.paused + ' t=' + v.media.currentTime)
      if (v.title) return text(v.action + ' -> ' + v.title + '\n' + v.url)
      return text(JSON.stringify(v).slice(0, 600))
    },
  },
  timeoutMs: 200000,
  isConcurrencySafe: () => false,
  async execute(args) {
    if (!args || typeof args.action !== 'string') throw new Error('browser_do needs an action')
    return await call('/do' + qs({ action: args.action, url: args.url, selector: args.selector, text: args.text, value: args.value, ms: args.ms, full: args.full ? '1' : undefined }), 190000)
  },
}

const stateTool = {
  name: 'browser_state',
  description:
    'Report the browser window right now: current url, page title, and the state of the first <video> element (paused, currentTime, duration, volume, source). Use it to confirm a video actually started before trusting what the hearing tool reports.',
  parameters: { type: 'object', properties: {}, required: [] },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v) return text('no state')
      const m = v.media ?? {}
      return text(v.title + '\n' + v.url + '\nvideo: ' + (m.found ? 'paused=' + m.paused + ' t=' + m.currentTime + '/' + m.duration + ' vol=' + m.volume + ' muted=' + m.muted : 'none found'))
    },
  },
  timeoutMs: 140000,
  isConcurrencySafe: () => true,
  async execute() {
    return await call('/state', 130000)
  },
}

export function apply(ctx) {
  ensureDaemon().catch(() => {
    /* the first tool call reports the real error */
  })
  for (const tool of [doTool, stateTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.('dsh-watch-browser: could not register ' + tool.name + ': ' + String(error && error.message))
    }
  }
  ctx.logger?.info?.('dsh-watch-browser ready (config ' + CONFIG_PATH + ')')
}
