// dsh-watch-hands host half: drive the whole desktop, not just a browser.
//
// TWO tools, in the same shape as the browser plugin (one dispatcher, one state
// reader), because schema cost is paid on every request. The dispatcher speaks
// in INTENT - "click the button called 保存" - rather than in coordinates, so the
// caller does not have to know where anything is.
import { call, ensureDaemon, qs, handsUrl } from './client.mjs'
import { CONFIG_PATH } from './shared.mjs'

export const name = 'dsh-watch-hands'
export const inject = ['tools']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }
const text = (s) => [{ type: 'text', text: s }]

const ACTIONS = [
  'apps', 'focus', 'window', 'find', 'read', 'click', 'clickat', 'type', 'key', 'run', 'menu', 'wait', 'displays', 'shot',
]

function renderResult(v) {
  if (!v) return 'no result'
  if (Array.isArray(v.apps)) {
    return v.apps.map((a) => (a.fg ? '* ' : '  ') + String(a.process).padEnd(20) + ' ' + String(a.title).slice(0, 56) + '  [' + a.hwnd + ']').join('\n') || '(no windows)'
  }
  if (Array.isArray(v.windows)) return v.windows.length + ' window(s): ' + v.windows.map((w) => w.process + ' — ' + String(w.title).slice(0, 34)).join(' | ')
  if (Array.isArray(v.elements)) {
    if (v.elements.length === 0) return 'no matching controls'
    return v.elements.slice(0, 40).map((e) => String(e.role || e.type).padEnd(13) + ' ' + String(e.name || '').slice(0, 48) + (e.value ? '  = ' + String(e.value).slice(0, 24) : '') + (e.disabled ? '  (disabled)' : '')).join('\n') + (v.elements.length > 40 ? '\n... ' + (v.elements.length - 40) + ' more' : '')
  }
  if (typeof v.text === 'string') {
    const head = 'read ' + (v.window && v.window.title ? '"' + String(v.window.title).slice(0, 40) + '"' : '') + ' via ' + (v.source || '?')
    return head + '\n' + v.text.slice(0, 2500)
  }
  if (Array.isArray(v.items)) return v.items.length ? v.items.slice(0, 30).join(' | ') : '(no menu items)'
  if (v.clicked !== undefined) return 'clicked "' + v.clicked + '" via ' + v.how + (v.window ? '  in ' + String(v.window.title).slice(0, 40) : '')
  if (v.typed !== undefined) return 'typed ' + v.typed + ' characters'
  if (v.key !== undefined) return 'sent ' + v.key
  if (v.launched !== undefined) return 'launched ' + String(v.launched).slice(0, 80)
  if (v.focused !== undefined) {
    if (v.focused) return 'focused: ' + String(v.title || '').slice(0, 60)
    return 'could not focus: ' + String(v.title || '').slice(0, 60) + (v.reason ? '\n' + v.reason : '')
  }
  if (v.op !== undefined) return v.op + ' -> ' + (v.iconic ? 'minimised' : v.w + 'x' + v.h + ' at ' + v.x + ',' + v.y)
  if (v.physical !== undefined) {
    return 'screenshot ' + v.width + 'x' + v.height + ' -> ' + v.path + '\n' +
      'physical ' + v.physical.w + 'x' + v.physical.h + ' at ' + v.physical.x + ',' + v.physical.y + '  (scale ' + v.scale + ')' + (v.window ? '\nwindow: ' + String(v.window).slice(0, 50) : '') + '\n' +
      'read a pixel off the image, then: ' + v.toScreen
  }
  return JSON.stringify(v).slice(0, 700)
}

const actTool = {
  name: 'hands_act',
  description:
    'Drive the whole Windows desktop the way a person does: list open apps, focus/minimise/move a window, READ what a window is showing, find controls inside it by their visible label, click a control by name, type text (CJK safe) into any application, send key chords, launch a program. Prefer the name-based actions: they survive window moves, DPI and scroll, and they can be verified by reading the window back. Use hands_state first if you do not know what is on screen. Pair with screen_look / screen_watch when you need to see the result.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do. apps = list windows; focus = bring one forward; window = minimise/maximise/restore/close/move; find/read = inspect; click = click a control by its accessible name; clickat = click screen coordinates (escape hatch); type = type text; key = send a chord; run = launch; menu = list the menu bar.' },
      hint: { type: 'string', description: 'Which window: a case-insensitive substring of its process name OR title, e.g. "记事本" or "Chrome". Omit to use whatever is in front.' },
      hwnd: { type: 'string', description: 'Exact window handle from hands_act action=apps. Overrides hint.' },
      name: { type: 'string', description: "For action=click/find: the control's visible label, e.g. 保存 / 確定 / 开始. Matching is exact first, then substring." },
      text: { type: 'string', description: 'For action=type: the text to type. Chinese and any unicode are fine.' },
      combo: { type: 'string', description: 'For action=key: a chord like "ctrl+s", "alt+f4", "win+r", "enter", "tab", "f5".' },
      op: { type: 'string', enum: ['minimise', 'maximise', 'restore', 'close', 'move'], description: 'For action=window.' },
      rect: { type: 'string', description: 'For action=window op=move: "x,y,w,h" in screen pixels.' },
      target: { type: 'string', description: 'For action=run: a program path or a command line, e.g. "notepad" or "C:\\Windows\\notepad.exe".' },
      timeout: { type: 'number', description: 'For action=wait: how long to wait for the control, in ms (default 3000).' },
      gone: { type: 'boolean', description: 'For action=wait: wait for the control to DISAPPEAR instead of appear.' },
      width: { type: 'number', description: 'For action=shot: downscale the capture to this pixel width (default 1366).' },
      x: { type: 'number', description: 'For action=clickat.' },
      y: { type: 'number', description: 'For action=clickat.' },
    },
    required: ['action'],
  },
  output: { schema: OUTPUT_SCHEMA, render: (_a, v) => text(renderResult(v)) },
  timeoutMs: 120000,
  // The OS input layer is a single serial resource: two concurrent actions would
  // interleave keystrokes into each other's windows.
  isConcurrencySafe: () => false,
  async execute(args) {
    if (!args || typeof args.action !== 'string') throw new Error('hands_act needs an action')
    const { action } = args
    if (action === 'apps') return await call('/apps', 30000)
    if (action === 'displays') return await call('/displays', 20000)
    if (action === 'shot') {
      // Returns the image path AND the map from its pixels to screen pixels.
      // Local capture is ~160ms; the vision model is ~6000ms, so seeing the
      // screen this way is 30x cheaper than asking the eyes to describe it.
      return await call('/shot' + qs({ hint: args.hint, width: args.width }), 45000)
    }
    if (action === 'wait') {
      if (!args.name) throw new Error('action=wait needs name (the control to wait for)')
      return await call('/wait' + qs({ hint: args.hint, hwnd: args.hwnd, name: args.name, timeout: args.timeout, gone: args.gone ? '1' : undefined }), Math.max(15000, Number(args.timeout || 3000) + 15000))
    }
    if (action === 'focus') return await call('/focus' + qs({ hint: args.hint, hwnd: args.hwnd }), 30000)
    if (action === 'window') {
      if (!args.op) throw new Error('action=window needs op (minimise|maximise|restore|close|move)')
      return await call('/window' + qs({ op: args.op, hint: args.hint, hwnd: args.hwnd, rect: args.rect }), 30000)
    }
    if (action === 'find') return await call('/find' + qs({ hint: args.hint, hwnd: args.hwnd, name: args.name, text: '1' }), 45000)
    if (action === 'read') return await call('/read' + qs({ hint: args.hint, hwnd: args.hwnd }), 45000)
    if (action === 'menu') return await call('/menu' + qs({ hint: args.hint, hwnd: args.hwnd }), 45000)
    if (action === 'click') {
      if (!args.name) throw new Error('action=click needs name (the control\'s visible label)')
      return await call('/click' + qs({ hint: args.hint, hwnd: args.hwnd, name: args.name }), 60000)
    }
    if (action === 'clickat') {
      if (args.x === undefined || args.y === undefined) throw new Error('action=clickat needs x and y')
      return await call('/clickat' + qs({ x: args.x, y: args.y }), 30000)
    }
    if (action === 'type') {
      if (typeof args.text !== 'string' || args.text === '') throw new Error('action=type needs text')
      return await call('/type' + qs({ text: args.text, hint: args.hint, hwnd: args.hwnd }), 120000)
    }
    if (action === 'key') {
      if (!args.combo) throw new Error('action=key needs combo, e.g. "ctrl+s"')
      return await call('/key' + qs({ combo: args.combo, hint: args.hint, hwnd: args.hwnd }), 30000)
    }
    if (action === 'run') {
      if (!args.target) throw new Error('action=run needs target')
      return await call('/run' + qs({ target: args.target }), 45000)
    }
    throw new Error('unknown action ' + action)
  },
}

const batchTool = {
  name: 'hands_batch',
  description:
    'Run several desktop steps in ONE call: click / type / key / focus / wait, in order, stopping at the first failure. Use this whenever you already know the sequence - it costs one turn instead of one turn per step, which is where nearly all the latency in desktop automation comes from. Prefer names over coordinates so a step can act on a control that only appears along the way (a menu item, a dialog button), and use action=wait to WAIT FOR IT instead of guessing a sleep. finish=text (default) returns what the window then says, which is cheaper and exact compared with a screenshot. Example: [{action:"focus",hint:"记事本"},{action:"type",text:"hello"},{action:"key",combo:"ctrl+s"},{action:"wait",name:"保存",timeout:3000}].',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Ordered steps. Each item: {action, hint?, hwnd?, name?, text?, combo?, x?, y?, timeout?, gone?}.',
        items: { type: 'object', additionalProperties: true, properties: {} },
      },
      hint: { type: 'string', description: 'Window for the trailing read (finish=text). Defaults to the window the steps used.' },
      finish: { type: 'string', enum: ['text', 'none'], description: 'text (default) appends what the window says afterwards; none skips it.' },
    },
    required: ['actions'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v) return text('no result')
      const lines = (v.steps || []).map((s) => '  #' + s.step + ' ' + s.action + ' ok ' + s.ms + 'ms' + (s.clicked ? ' -> "' + String(s.clicked).slice(0, 30) + '"' : '') + (s.chars ? ' (' + s.chars + ' chars)' : '') + (s.waitedMs !== undefined ? ' waited ' + s.waitedMs + 'ms' : ''))
      const head = v.ok ? 'batch ok: ' + (v.steps || []).length + ' steps, ' + v.totalMs + 'ms total' : 'batch STOPPED at step ' + v.failed.step + ' (' + v.failed.action + '): ' + v.failed.error
      return text([head].concat(lines).join('\n') + (v.text !== undefined ? '\n--- window now says ---\n' + String(v.text).slice(0, 2000) : ''))
    },
  },
  timeoutMs: 300000,
  isConcurrencySafe: () => false,
  async execute(args) {
    if (!args || !Array.isArray(args.actions) || args.actions.length === 0) throw new Error('hands_batch needs a non-empty actions array')
    return await call('/batch' + qs({ actions: JSON.stringify(args.actions), hint: args.hint, finish: args.finish }), 300000)
  },
}

const stateTool = {
  name: 'hands_state',
  description:
    'Report the hands: whether the input worker is alive, how many actions it has performed, what they were, and any last error. Call it when an action seemed to do nothing - it tells you whether the command reached the OS at all, and what it last touched.',
  parameters: { type: 'object', properties: {}, required: [] },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v || !v.ok) return text('hands DOWN (' + handsUrl() + ')' + (v && v.lastError ? '  last error: ' + v.lastError.text : ''))
      const lines = ['hands UP  actions=' + v.actions + '  worker uptime=' + Math.round((v.workerUptimeMs || 0) / 1000) + 's' + (v.queued ? '  queued=' + v.queued : '')]
      if (v.history && v.history.length) {
        lines.push('recent:')
        for (const h of v.history.slice(0, 8)) lines.push('  ' + String(h.at ? new Date(h.at).toTimeString().slice(0, 8) : '') + '  ' + h.action + (h.window ? '  @' + String(h.window).slice(0, 34) : ''))
      }
      if (v.lastError) lines.push('lastError: ' + String(v.lastError.text || v.lastError).slice(0, 140))
      return text(lines.join('\n'))
    },
  },
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  async execute() {
    try {
      const h = await call('/health', 8000)
      const hist = await call('/history', 8000).catch(() => ({ history: [] }))
      return { ...h, history: hist.history || [] }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  },
}

export function apply(ctx) {
  ensureDaemon().catch(() => {
    /* the first tool call reports the real error */
  })
  for (const tool of [actTool, batchTool, stateTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.('dsh-watch-hands: could not register ' + tool.name + ': ' + String(error && error.message))
    }
  }
  ctx.logger?.info?.('dsh-watch-hands ready (config ' + CONFIG_PATH + ')')
}
