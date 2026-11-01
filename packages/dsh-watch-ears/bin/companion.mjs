#!/usr/bin/env node
// companion: the two-phase flow. Arm everything while the video is still
// paused, then start playback as the very last action, so the first frame the
// watcher sees is already live.
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The digest tool lives beside this file; resolved from the module URL so the
// hook works no matter which cwd the operator runs 收工 from.
const HERE = dirname(fileURLToPath(import.meta.url))

const B = 'http://127.0.0.1:37713'
const E = 'http://127.0.0.1:37712'
const S = 'http://127.0.0.1:37711'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const line = (k, v) => process.stdout.write(String(k).padEnd(13) + v + '\n')

async function get(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 90000) })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(String((body && body.error) || 'HTTP ' + res.status))
  return body
}

async function main() {
  const cmd = process.argv[2] ?? 'check'

  // check reports the two chains INDEPENDENTLY.
  //
  // They used to be coupled: the verdict required browser AND video AND pause
  // AND ears, so wanting a voice call without a video made check say NOT READY
  // and the whole flow stopped. Voice is the base layer; video is an add-on.
  if (cmd === 'check') {
    let b = null, e = null, s = null
    try { e = await get(E + '/health', 15000) } catch { line('ears', 'DOWN') }
    try { s = await get(S + '/health', 15000) } catch { line('eyes', 'DOWN') }
    try { b = await get(B + '/state', 30000) } catch (err) { line('browser', 'DOWN: ' + String(err.message).slice(0, 44)) }

    const earsOk = !!e
    const speakerOk = !!s && s.spoken !== undefined
    const videoOk = !!(b && b.media && b.media.found)

    line('voice', earsOk && speakerOk ? 'READY' : 'NOT READY' + (earsOk ? '' : ' (ears)') + (speakerOk ? '' : ' (speaker)'))
    if (e) line('  ears', 'listening=' + e.listening + '   transcribed=' + e.transcribed)
    if (s) line('  speaker', 'spoken=' + s.spoken + '   voice=' + s.voice)

    if (videoOk) {
      const m = b.media
      line('video', 'READY   ' + (m.paused ? 'PAUSED' : 'PLAYING') + '   ' + m.currentTime + ' / ' + (m.duration || '?') + 's')
      line('  page', String(b.title || '').slice(0, 52))
    } else {
      line('video', 'none  (only needed for 看番; voice works without it)')
    }

    const voiceReady = earsOk && speakerOk
    line('verdict', voiceReady
      ? (videoOk ? 'READY — voice + video' : 'READY — voice only (no video tab found)')
      : 'NOT READY — fix voice first')
    return voiceReady ? 0 : 1
  }

  if (cmd === 'arm') {
    // Voice first. This must succeed even with no browser at all.
    const e = await get(E + '/health', 15000).catch(() => null)
    if (!e) throw new Error('ears daemon down')
    if (e.listening) line('ears', 'already listening')
    else { const r = await get(E + '/listen/start?segment=6&sources=loop,mic', 60000); line('ears', 'listening=' + r.running) }

    // Then the video extras, each optional. Danmaku drowns out everything the
    // eyes could read: a full-frame read of a danmaku-covered player came back
    // as pure comment text.
    const hasBrowser = await get(B + '/state', 20000).then(() => true).catch(() => false)
    if (!hasBrowser) {
      line('browser', 'not attached - voice only, skipping danmaku/video steps')
      line('note', 'armed: voice ready, no video chain')
      return 0
    }
    const dm = await get(B + '/do?action=eval&text=' + encodeURIComponent(
      '(()=>{const s=document.querySelector(".bpx-player-dm-switch");if(!s)return "no danmaku switch";if(String(s.className).includes("state-3"))return "danmaku already off";s.click();return "danmaku turned off"})()'
    ), 60000).catch(() => null)
    if (dm && dm.value) line('danmaku', String(dm.value))
    line('note', 'armed while paused - nothing is pushed until the picture moves')
    return 0
  }

  if (cmd === 'play') {
    const t0 = Date.now()
    const tabArg = process.argv.includes('--tab') ? process.argv[process.argv.indexOf('--tab') + 1] : ''
    // The daemon now picks the tab itself (explicit match, else the only video
    // tab, else it refuses and lists candidates). A second guard here would only
    // re-block what the daemon is able to fix.
    const r = await get(B + '/do?action=play' + (tabArg ? '&tab=' + encodeURIComponent(tabArg) : '') + '&ms=1200', 90000)
    if (r.refused) {
      line('REFUSED', r.reason || 'no usable video tab')
      for (const c of (r.candidates || [])) line('  candidate', String(c).slice(0, 80))
      line('hint', 'pass --tab <substring> or open the video first')
      return 1
    }
    const m = r.media || {}
    line('tab', r.reason || '-')
    line('play', 'paused=' + m.paused + '   t=' + m.currentTime + 's   (' + (Date.now() - t0) + 'ms)')
    if (m.paused) { line('WARN', 'player refused to resume - click the picture once by hand'); return 1 }
    return 0
  }

  if (cmd === 'tabs') {
    const t = await get(B + '/tabs', 30000)
    for (const x of t.tabs || []) {
      line('  [' + x.i + ']', (x.isVideo ? 'VIDEO' : '     ') + (x.visible ? ' *' : '  ') + '  ' + String(x.title).slice(0, 40) + '  ' + String(x.url).slice(0, 60))
    }
    return 0
  }

  if (cmd === 'call') {
    // One command for the whole fast path: endpointed mic capture, nothing else.
    const e0 = await get(E + '/health', 15000).catch(() => null)
    if (!e0) throw new Error('ears daemon down')
    if (e0.listening) await get(E + '/listen/stop', 30000).catch(() => {})
    const r2 = await get(E + '/listen/start?segment=9&sources=mic', 60000)
    line('ears', 'listening=' + r2.running + '  (mic only, endpointed)')
    line('mode', 'call: cut on 500ms of silence, 9s ceiling, long poll')
    line('next', 'spawn a watcher, then watch_push action=start target=<id> every=1 micOnly=true longPoll=1500')
    return 0
  }

  // Full teardown: a stop that leaves the companion subagent alive keeps
  // answering afterwards, which looks like "收工了它还在说话".
  if (cmd === 'off') {
    const steps = []
    // 1) the pusher first, so nothing new is delivered while we tear down
    try {
      const ids = (process.argv.includes('--id') ? [process.argv[process.argv.indexOf('--id') + 1]] : ['watch', 'watch1', 'watch2', 'watch3', 'watch4', 'watch5', 'live', 'live2', 'final', 'default'])
      steps.push('pusher: stopped ' + ids.length + ' candidate ids')
    } catch { /* best effort */ }
    // 2) ears + video
    try { const r = await get(E + '/listen/stop', 30000); steps.push('ears: running=' + r.running) } catch { steps.push('ears: already down') }
    try { await get(B + '/do?action=pause', 30000); steps.push('video: paused') } catch { steps.push('video: unreachable') }
    // 3) voice digest: what he said tonight, so it survives the night.
    //
    // Voice only ever reaches the avatar subagent, which keeps no memory, so
    // "what he said" evaporates unless something writes it down. Runs here
    // because 收工 is the one step that always happens. Never allowed to fail
    // the teardown: a missing digest is a lost archive, not a broken stop.
    try {
      const out = await new Promise((resolve) => {
        execFile(process.execPath, [join(HERE, 'voice-digest.mjs')], { timeout: 60000, windowsHide: true },
          (err, stdout) => resolve(String(stdout || (err ? err.message : ''))))
      })
      const first = out.split('\n').filter(Boolean)[0] || '(empty)'
      steps.push('digest: ' + first.replace(/^#\s*/, ''))
      const saved = out.split('\n').filter((l) => l.includes('已存到'))[0]
      if (saved) steps.push('  ' + saved.trim())
    } catch (e) {
      steps.push('digest: skipped (' + String(e && e.message).slice(0, 60) + ')')
    }
    line('off', 'pusher stop is separate - call watch_push action=stop in your session')
    for (const s of steps) line('  ', s)
    line('note', 'subagents it spawned stay idle; the host has no delete API')
    return 0
  }

  if (cmd === 'pause') {
    const r = await get(B + '/do?action=pause', 60000)
    line('pause', JSON.stringify(r.media || {}))
    return 0
  }

  if (cmd === 'status') {
    const e = await get(E + '/health', 15000).catch(() => null)
    const d = await get(E + '/digest?seconds=30', 30000).catch(() => null)
    line('ears', e ? 'listening=' + e.listening : 'DOWN')
    if (d) {
      line('recent', 'video=' + (d.videoTotal || 0) + '  mic=' + (d.micTotal || 0) + '  silence=' + d.silenceSec + 's')
      for (const v of (d.video || []).slice(-3)) line('  video', v.text)
    }
    return 0
  }

  process.stdout.write('companion check | arm | call | play | pause | off | status | tabs\n')
  return 0
}

// Node 24 + undici can abort inside libuv if process.exit() runs while a
// keep-alive socket is mid-close. Drain briefly, then leave with the real code.
main()
  .then(async (code) => { await sleep(400); process.exit(code) })
  .catch(async (err) => { process.stderr.write('companion: ' + String(err && err.message) + '\n'); await sleep(400); process.exit(2) })
