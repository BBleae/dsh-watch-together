// Salience pump. It lives in the DSH HOST, not in the ears daemon, because only
// the host owns the inbox delivery seam (ctx.subagents). The daemon owns the
// senses; this decides when a sense is worth interrupting the agent for.
//
// Why not a reminder loop: a reminder wakes a whole session, which re-reads its
// entire history. At a 10 second tick that is ~100M input tokens over two hours
// (quadratic), against ~0.4M for stateless pushes (linear). Waking only on
// salient events is what makes "always listening, occasionally speaking"
// affordable at all.
import { readFileSync } from 'node:fs'
import { CONFIG_PATH, log } from './shared.mjs'
import { scoreMoment, isSalient, looksLikeOpEd, MotionBaseline, pictureTension } from './salience.mjs'
import { StoryState } from './story.mjs'
import { LocalOcr } from './ocr.mjs'

const EARS_SELF = 'http://127.0.0.1:37712'
const DIGEST_URL = 'http://127.0.0.1:37712/digest'
const BROWSER_URL = 'http://127.0.0.1:37713'
const EYES_URL = 'http://127.0.0.1:37711'
const MOUTH_URL = process.env.DSH_MOUTH_URL || 'http://127.0.0.1:37716'
// Name the position. A generic "transcribe the subtitle" prompt failed on a
// frame whose background was covered in English interface text: the model
// answered "无" or read the English instead of the Chinese line at the bottom.
const SUB_PROMPT = '画面最下方有中文字幕。只转写那一行中文，不要理会画面其他位置的所有文字（英文界面、水印、弹幕提示）。底部没有中文就回答：无'

// The brain's ONLY input. The subagent writes this line at the end of every turn
// that spoke, and the session (docs/FINAL-ARCH.md §四) reads it to build the story.
//
// It is one constant on purpose. The three call sites used to each spell the
// requirement slightly differently, so the format was a convention rather than a
// contract - and a convention drifts the moment someone edits one branch. The
// brain parses, so the shape must be identical everywhere.
const REPORT_LINE = '\n说完补一行，格式固定：看到了<这一拍发生了什么、谁说了什么>，说了<你刚说的那句>。只一行，不要分点。'

// Hamming distance between two 64-bit luminance hashes expressed as strings.
function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return 99
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1
  return d
}

function joinLines(lines, max) {
  return lines.slice(-max).map((l) => String(l.text)).filter(Boolean).join(' / ')
}

export class Pusher {
  constructor(ctx, cfg) {
    this.ctx = ctx
    this.id = String((cfg && cfg.id) || 'default')
    this.cfg = cfg
    this.timer = null
    this.running = false
    this.target = null
    this.every = 4
    this.micOnly = false
    // Every push wakes the target session, and that wake is the expensive part
    // (a session turn re-reads its whole context). 120s keeps the disturbance
    // sane while still commenting on a scene that has genuinely moved on.
    this.videoEveryMs = 120000
    this.since = 0
    this.lastVideoPush = 0
    this.stats = { ticks: 0, injected: 0, skipped: 0, errors: 0, coldPushes: 0, subHit: 0, subSame: 0, subMiss: 0, subErr: 0 }
    this.lastError = null
    this.delivery = null
    this.pushes = []
    // Everything the status snapshot reads must exist before the first start(),
    // otherwise asking for status of a pusher that was never started throws.
    this.subs = []
    this.frames = []
    this.lastFrameAt = 0
    // Watch densely, pay sparsely.
    //
    // A hash read is ~10ms and free; a vision description costs ~1.5s and money.
    // So the hash runs as often as the tick loop allows (0.5s), while vision is
    // rate-limited to a budget. A fight scene changing every 300ms still gets
    // covered at the vision budget instead of being sampled once.
    this.frameEveryMs = 2000
    this.frameHashEveryMs = 500
    this.frameChangeThreshold = 4
    this.lastFrameHash = null
    this.lastVisionAt = 0
    this.lastVideoTime = 0
    this.lastPaused = null
    this.framePrompt = '这是动画画面。用一句话描述画面里正在发生什么、有哪些人物、表情和动作。20字内，直接说。'
    // Screen mode keeps its own prompt: describing a spreadsheet and describing a
    // fight scene need different words, and the wrong one reads as nonsense.
    this.screenPrompt = '这是电脑屏幕上当前活动窗口的画面。用一句话说清：这是什么程序或页面、正在展示什么内容。25字内，直接说。'
    this.mode = 'video'
    this.lastScreenAt = 0
    this.lastScreenHash = null
    this.lastWindow = null
    this.lastSubAt = 0
    this.lastSubText = null
    this.subPollMs = 700
    // Cheap hash poll stays fast (0.7s); the expensive OCR is rate-limited
    // separately. A line stays on screen for 2-4 seconds, so reading it every
    // 1.8s still catches it while freeing the vision endpoint for pictures.
    this.subOcrEveryMs = 1800
    this.lastSubOcrAt = 0
    this.subChangeThreshold = 2
    this.lastSubHash = null
    this.windowSec = 100
    this.longPollMs = 1500
    this.lastDecision = 'idle'
    // Two outgoing channels: a slow regular digest and instant salient events.
    this.salientThreshold = 35
    this.salientCooldownMs = 25000
    // Measured turn time is 2-8s, so an 8s settle window let a new push land
    // just as the previous turn was finishing - the two pushes then collided and
    // the second waited 12-26s. 12s covers the slow tail without being so long
    // that a real moment gets swallowed.
    this.settleMs = 12000
    this.pendingSince = 0
    this.spoken = []
    this.lastSpokeAt = 0
    this.stillChecks = 0
    this.silentSec = 0
    this.lastSubAtMs = Date.now()
    this.events = []
    this.lastRegularAt = 0
    this.regularEveryMs = 45000
    // Cold timer, taken from kimjammer/Neuro's Prompter.PATIENCE.
    //
    // Every other branch in this file fires because something NEW happened. A
    // reaction stream's whole problem is the opposite: a quiet stretch of a scene
    // is still time on air, and a host who says nothing for 40 seconds reads as
    // broken to someone who just walked in. This fires on the ABSENCE of news.
    this.patienceMs = 40000
    this.lastSpeechAt = Date.now()
    this.coldPushes = 0
    this.lastColdAt = 0
    this.moments = []
    // The watcher keeps ONE evolving summary of the scene, not a history.
    this.story = new StoryState()
    // One warm OCR worker for the whole pusher: a cold PowerShell start costs
    // ~400ms, which is most of the subtitle latency we are eliminating.
    this.ocr = new LocalOcr()
    // 'Big change' is judged against what this show normally does, not a constant.
    this.motion = new MotionBaseline(40)
    this.regularDeferred = 0
    this.busyTick = false
    this.callerAgent = null
  }

  start(opts = {}) {
    // Shorter poll window: the digest long-poll returns the moment content
    // appears, so a smaller ceiling only costs extra requests while idle. At
    // 1500ms a reply could sit for up to 1.5s before the pusher noticed it.
    this.longPollMs = Math.min(Math.max(Number(opts.longPoll) || 800, 0), 5000)
    this.target = String(opts.target || '').trim()
    if (!this.target) throw new Error('watch_push needs target=<session id to wake>')
    this.chatTargetId = opts.chatTarget ? String(opts.chatTarget) : ''
    // 1s is allowed now: with a long poll the loop mostly wakes on content.
    this.every = Math.min(Math.max(Number(opts.every) || 2, 1), 60)
    this.micOnly = opts.micOnly === true || opts.micOnly === '1'
    // The receiver is a silent bell: it only wakes the parent, never speaks.
    this.bell = opts.bell === true || opts.bell === '1'
    // Two mutually exclusive subjects. 'video' watches the player's <video> and
    // reads burned-in subtitles; 'screen' watches the foreground window and has
    // no subtitle channel at all.
    this.mode = opts.mode === 'screen' ? 'screen' : 'video'
    this.lastScreenAt = 0
    this.lastScreenHash = null
    this.lastWindow = null
    this.videoEveryMs = Math.min(Math.max(Number(opts.videoEvery) || 120, 10), 600) * 1000
    this.windowSec = Math.min(Math.max(Number(opts.windowSec) || 100, 20), 600)
    // Subtitles are read from the page itself, so a window that moves cannot
    // break them the way a calibrated screen region did.
    this.subs = []
    this.lastSubAt = 0
    this.lastSubText = null
    // Subtitles change as fast as dialogue does: a short line can be on screen
    // for under a second. 2s is the practical floor at ~1.5s per read.
    // Poll often, read rarely: the band hash is ~20ms, one OCR is ~1.4s.
    this.subPollMs = Math.min(Math.max(Number(opts.subEvery) || 0.7, 0.4), 60) * 1000
    this.subOcrEveryMs = Math.min(Math.max(Number(opts.subOcrEvery) || 1.8, 0.8), 60) * 1000
    this.lastSubOcrAt = 0
    this.subChangeThreshold = Math.min(Math.max(Number(opts.subChange) || 2, 1), 20)
    this.lastSubHash = null
    this.frameEveryMs = Math.min(Math.max(Number(opts.frameEvery) || 2, 0.5), 120) * 1000
    this.frameHashEveryMs = Math.min(Math.max(Number(opts.hashEvery) || 0.5, 0.3), 30) * 1000
    this.frameChangeThreshold = Math.min(Math.max(Number(opts.changeThreshold) || 4, 1), 40)
    this.salientThreshold = Math.min(Math.max(Number(opts.salient) || 35, 10), 100)
    this.salientCooldownMs = Math.min(Math.max(Number(opts.salientCooldown) || 25, 8), 120) * 1000
    this.settleMs = Math.min(Math.max(Number(opts.settle) || 12, 2), 60) * 1000
    // A turn costs ~4s (measured), so the push rate must stay well under
    // 1 push / 4s or the watcher falls behind and comments arrive stale. With
    // salient at a 25s cooldown, 45s here keeps the combined rate near
    // 3 pushes/minute - still frequent, but drainable.
    this.regularEveryMs = Math.min(Math.max(Number(opts.regularEvery) || 45, 10), 300) * 1000
    // 40s default. Neuro uses 60 for a one-on-one chat; a stream has viewers
    // arriving constantly and needs to keep making noise. Under 25s turns into
    // filler, past 90s the room is silent.
    // Precedence: explicit option > config.json watch.patienceSec > 40s.
    // A streamer tuning this should not have to pass it on every watch_push call.
    const cfgPatience = (() => {
      try {
        return Number(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).watch?.patienceSec) || 0
      } catch { return 0 }
    })()
    this.patienceMs = Math.min(Math.max(Number(opts.patience) || cfgPatience || 40, 10), 180) * 1000
    // Danmaku: how often to read one comment and answer it. 25s keeps replies
    // conversational without turning the stream into a Q&A machine; a live room
    // produces far more comments than a host can answer and picking one at a
    // human pace is what makes it feel like she is reading the chat.
    this.danmakuUrl = opts.danmakuUrl || (() => {
      try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).watch?.danmakuUrl || '' } catch { return '' }
    })()
    this.danmakuEnabled = this.danmakuUrl && opts.danmaku !== '0'
    this.danmakuEveryMs = Math.min(Math.max(Number(opts.danmakuEvery) || 25, 8), 300) * 1000
    this.lastDanmakuAt = 0
    this.danmakuLog = []
    this.danmakuAnswered = 0
    this.lastSpeechAt = Date.now()
    this.coldPushes = 0
    this.lastColdAt = 0
    this.moments = []
    this.story = new StoryState()
    this.motion = new MotionBaseline(40)
    this.regularDeferred = 0
    this.events = []
    this.stillChecks = 0
    this.silentSec = 0
    this.lastRegularAt = 0
    if (opts.parent) this.parentId = String(opts.parent)
    if (this.timer) clearInterval(this.timer)
    this.since = Date.now()
    this.running = true
    // A fresh start must be a fresh measurement. Without this, the throttle
    // timer and the counters carry over from whatever run came before, so a new
    // session can be silently blocked for up to videoEvery seconds and its
    // stats are polluted by the previous run.
    this.lastVideoPush = 0
    this.subs = []
    this.frames = []
    this.lastFrameAt = 0
    this.lastFrameHash = null
    this.lastVisionAt = 0
    this.lastSubText = null
    this.lastSubAt = 0
    this.lastDecision = 'starting'
    this.lastSalientAt = 0
    // A new run must not inherit the previous episode's "already announced its
    // ending" marker, or the next ending is silently swallowed.
    this.endedFor = null
    this.pendingEnded = null
    this.stats = { ticks: 0, injected: 0, skipped: 0, errors: 0, coldPushes: 0, subHit: 0, subSame: 0, subMiss: 0, subErr: 0, subPolls: 0, subBlank: 0, subOcrHeld: 0, subLocal: 0, subLocalErr: 0, frameHit: 0, frameMiss: 0, frameErr: 0, hashChecks: 0, frameSame: 0, framePaused: 0, salientPushes: 0, regularPushes: 0, salientDeferred: 0 }
    this.timer = setInterval(() => {
      this.tick().catch((e) => log('push tick failed: ' + String(e && e.message)))
    }, this.every * 1000)
    return this.status()
  }

  stop() {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.status()
  }

  status() {
    const snap = {
      id: this.id,
      running: this.running,
      target: this.target,
      chatTarget: this.chatTargetId || '(same as target)',
      every: this.every,
      micOnly: this.micOnly,
      bell: !!this.bell,
      pace: this.pace || null,
      effective: {
        regularSec: Math.round((this.regularEveryMs || 0) / 1000),
        salientSec: Math.round((this.salientCooldownMs || 0) / 1000),
        coalesceSec: Math.round((this.coalesceMs || 0) / 1000),
      },
      patienceSec: Math.round((this.patienceMs || 0) / 1000),
      danmakuUrl: this.danmakuUrl || null,
      danmakuEverySec: Math.round((this.danmakuEveryMs || 0) / 1000),
      danmakuAnswered: this.danmakuAnswered || 0,
      silentSec: this.lastSpeechAt ? Math.round((Date.now() - this.lastSpeechAt) / 1000) : null,
      coldPushes: this.coldPushes || 0,
      mode: this.mode || 'video',
      watching: this.lastWindow ? (this.lastWindow.process + ' — ' + String(this.lastWindow.title).slice(0, 46)) : null,
      delivery: this.delivery,
      stats: this.stats,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
      salientPushes: this.stats.salientPushes || 0,
      regularPushes: this.stats.regularPushes || 0,
      // The host validates tool output as lossless JSON; round-trip it.
      moments: JSON.parse(JSON.stringify(this.moments.slice(-6))),
      story: this.story ? JSON.parse(JSON.stringify(this.story.snapshot())) : null,
      motion: this.motion ? JSON.parse(JSON.stringify(this.motion.stats())) : null,
      paceMs: this.paceMs || null,
      subLocal: this.stats.subLocal || 0,
      subCloudErr: this.stats.subCloudErr || 0,
      regularDeferred: this.regularDeferred || 0,
      subsBuffered: this.recentSubs().length,
      last: this.pushes.slice(-8),
    }
    try {
      return JSON.parse(JSON.stringify(snap))
    } catch {
      return { id: this.id, running: this.running, stats: this.stats, error: 'status not serialisable' }
    }
  }

  // Read whatever subtitle is on screen right now. This is the primary story
  // source: complete sentences with context, unlike a 12 second ASR fragment of
  // Japanese audio. Falls back to ASR when a video has no subtitles.
  // Fire-and-forget with an in-flight guard: a sampler that is still running
  // when its next interval arrives must not start a second copy.
  fire(fn) {
    // Sampler activity right after a push is the only visible signal that the
    // previous turn was consumed, so remember the gap as a pacing estimate.
    if (this.pendingSince) {
      const gap = Date.now() - this.pendingSince
      if (gap > 500 && gap < 60000) {
        this.paceMs = Math.round(this.paceMs ? this.paceMs * 0.7 + gap * 1.3 * 0.3 : gap * 1.3)
        this.paceMs = Math.min(Math.max(this.paceMs, 3000), 20000)
      }
    }
    const key = fn.name || 'anon'
    if (!this.inflight) this.inflight = new Set()
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    Promise.resolve()
      .then(() => fn.call(this))
      // New material arrived: evaluate NOW instead of waiting for the next 2s
      // tick. That wait was up to 2 seconds of pure latency between "the line is
      // readable" and "the watcher is told about it".
      .then(() => {
        if (!this.micOnly && this.running) {
          this.tick().catch((e) => log('post-sample tick failed: ' + String(e && e.message).slice(0, 120)))
        }
      })
      .catch((e) => log('sampler ' + key + ' failed: ' + String(e && e.message).slice(0, 120)))
      .finally(() => this.inflight.delete(key))
  }

  // Poll the subtitle band often, pay for OCR only when there is text to read.
  //
  // A full subtitle read costs ~1.4s (crop 180ms + OCR 1200ms), so polling it
  // every 1.5s saturates the vision endpoint and starves the picture path. The
  // band hash costs ~20ms and answers two questions: is there text at all, and
  // did it change. Measured on a real episode: a frame WITH a subtitle shows
  // brightRatio ~0.24, a frame without shows 0.001-0.004. That gap is decisive.
  async sampleSubtitle() {
    // Adaptive poll interval.
    //
    // 0.7s is right for a video whose subtitles are readable: a line on screen
    // lasts ~1-3 seconds, so a slower poll misses lines entirely. But on a video
    // with no readable track that is a crop every 0.7 seconds for nothing -
    // measured over one episode: 1700 polls, 0 hits.
    //
    // After a long run of blanks the interval stretches to just under the
    // "declare it unavailable" threshold, and a single hit resets it. Catching a
    // line late is acceptable; never catching one is not.
    const blankRun = this.stats.subBlank || 0
    const pollMs = this.subtitleUnavailable ? 5000 : (blankRun > 60 ? Math.max(this.subPollMs, 2500) : this.subPollMs)
    if (Date.now() - this.lastSubAt < pollMs) return
    this.lastSubAt = Date.now()
    try {
      const h = await fetch(BROWSER_URL + '/do?action=subhash&frac=0.2', { signal: AbortSignal.timeout(15000) }).then((r) => r.json())
      if (!h || !h.found) { this.stats.subMiss += 1; return }
      this.stats.subPolls += 1
      if (!h.hasText) {
        // Nothing on screen: clear the "current line" so the next identical
        // line is treated as new rather than as a repeat.
        this.lastSubText = null
        this.stats.subBlank += 1
        // A video with no subtitle track at all is not a transient blank.
        //
        // Every poll returning "no text" was indistinguishable from "the band
        // is between two lines", so the sampler kept paying for a crop every
        // 1.5s on a video that will never produce a subtitle - and the watcher
        // was told nothing, which is why it kept reporting the picture while
        // the dialogue went unheard. After a sustained run of blanks the path
        // is declared unavailable: one log line, and the pushed prompt tells
        // the watcher to work from picture + sound instead of waiting for text.
        if (!this.subtitleUnavailable && this.stats.subBlank >= 120) {
          this.subtitleUnavailable = true
          log('subtitles unavailable on this video after ' + this.stats.subBlank + ' blank polls; continuing on picture + audio')
        }
        return
      }
      const dist = this.lastSubHash === null ? 99 : hamming(h.hash, this.lastSubHash)
      this.lastSubHash = h.hash
      if (dist <= (this.subChangeThreshold || 2)) { this.stats.subSame += 1; return }
      // Rate-limit the OCR itself. Detecting the band is ~20ms; reading it costs
      // ~770ms on the vision endpoint, and at one read per 2 seconds subtitles
      // alone were saturating it. Skipping a read does not lose the line: the
      // next poll sees the same change and reads it then.
      if (Date.now() - this.lastSubOcrAt < this.subOcrEveryMs) {
        this.stats.subOcrHeld = (this.stats.subOcrHeld || 0) + 1
        return
      }
      this.lastSubOcrAt = Date.now()
      // The band changed and holds text: now the expensive call is justified.
      // Use the canvas crop, not a screenshot. page.screenshot forces the browser
      // to re-composite the page, which flashes and briefly stalls playback; at
      // one read every couple of seconds that was a dozen visible hiccups a
      // minute. drawImage on the <video> element is 33ms versus 170ms and does
      // not repaint anything the user can see.
      // Cloud is the PRIMARY subtitle reader, and that is deliberate.
      //
      // Windows OCR was measured at 80-110ms against the cloud's ~2200ms - 25x
      // faster - but on 20 real frames it returned garbage on half of them
      // ('它在！ 中的 00 回 00 户、' for '它现在正在用你的口吻回答用户') and missed
      // others entirely. A wrong line is worse than a slow one: the companion
      // would speak the garbage as if it were dialogue.
      //
      // So local OCR runs only as a LAST resort when the cloud call fails, and
      // never with the 2x crop that made it slower to produce.
      const crop = await fetch(BROWSER_URL + '/do?action=subcanvas&frac=0.2&width=1460', { signal: AbortSignal.timeout(20000) }).then((r) => r.json())
      if (!crop || !crop.found || !crop.path) { this.stats.subMiss += 1; return }
      let t = ''
      try {
        const url = EYES_URL + '/read?path=' + encodeURIComponent(crop.path) + '&prompt=' + encodeURIComponent(SUB_PROMPT)
        const v = await fetch(url, { signal: AbortSignal.timeout(45000) }).then((r) => r.json())
        t = String((v && v.text) || '').replace(/\s+/g, ' ').trim()
      } catch (e) {
        this.stats.subCloudErr = (this.stats.subCloudErr || 0) + 1
      }
      if (!t) {
        try {
          const so = await fetch(BROWSER_URL + '/do?action=subocr&frac=0.2&scale=2', { signal: AbortSignal.timeout(20000) }).then((r) => r.json())
          if (so && so.found && so.path) { t = String(await this.ocr.read(so.path)).replace(/\s+/g, ' ').trim(); if (t) this.stats.subLocal += 1 }
        } catch { this.stats.subLocalErr = (this.stats.subLocalErr || 0) + 1 }
      }
      if (!t || /^无/.test(t) || t.length < 2) { this.stats.subMiss += 1; return }
      if (t === this.lastSubText) { this.stats.subSame += 1; return }
      this.lastSubText = t
      this.stats.subHit += 1
      // A hit proves this video DOES carry subtitles: clear both the failure
      // latch and the blank run, so a single silent stretch earlier in the
      // episode cannot keep the sampler throttled for the rest of it.
      if (this.subtitleUnavailable) { this.subtitleUnavailable = false; log('subtitles readable again') }
      this.stats.subBlank = 0
      this.subs.push({ at: Date.now(), text: t, loud: this.currentLoud || 0 })
      this.story.observe('subtitle', { at: Date.now(), text: t })
      if (this.subs.length > 300) this.subs.shift()
    } catch (e) {
      this.stats.subErr += 1
      log('subtitle sample failed: ' + String(e && e.message).slice(0, 120))
    }
  }

  // The picture matters as much as the words: a scene can turn, a face can
  // change, a fight can start, with no dialogue at all. Watching only the
  // subtitles is why this felt like it was not really looking.
  // Watch the picture CONTINUOUSLY, pay for vision only on change.
  //
  // A screenshot-and-describe every N seconds samples the episode: you see one
  // frame in fifteen and miss the reaction shot in between. Instead this reads
  // an 8x8 luminance hash out of the <video> element every couple of seconds
  // (~10ms, no screenshot, no vision), and only asks for a description when the
  // hash says the scene actually moved. Cost per hour stays tiny while the
  // coverage becomes effectively continuous.
  // Screen mode: watch whatever window is in front.
  //
  // The video path has two sources because a player gives you subtitles AND
  // pictures. A document, a spreadsheet or a game gives you only pictures, so
  // there is one sampler here and the subtitle channel is simply absent. The
  // hash keeps it cheap: a vision call happens only when the window actually
  // changes, and a still page costs nothing.
  // Adopt live tuning values.
  //
  // Only overwrite when the panel actually expressed a preference: a null means
  // "leave what the pusher was started with", so removing the dial restores the
  // start-time behaviour instead of pinning whatever it last saw.
  applyTuning(t) {
    if (!t) return
    const seen = this.tuningSeen || (this.tuningSeen = {})
    const note = (key) => {
      const v = t[key]
      if (v === null || v === undefined) return false
      if (seen[key] === v) return false
      seen[key] = v
      return true
    }
    if (note('regular') && Number(t.regular) > 0) this.regularEveryMs = Number(t.regular) * 1000
    if (note('salient') && Number(t.salient) > 0) this.salientCooldownMs = Number(t.salient) * 1000
    if (note('coalesce') && Number(t.coalesce) > 0) this.coalesceMs = Number(t.coalesce) * 1000
    if (note('pace')) this.pace = t.pace
  }

  async sampleScreen(force) {
    if (Date.now() - this.lastScreenAt < this.frameHashEveryMs) return
    this.lastScreenAt = Date.now()
    try {
      // 480, not 960: screen mode asks "what page is this and what is it showing",
      // which survives downscaling, and the smaller image measurably cuts the
      // vision call (960 -> ~1400ms, 480 -> ~1180ms on the same frame).
      const shot = await fetch(EYES_URL + '/fgscreen?width=480', { signal: AbortSignal.timeout(20000) }).then((r) => r.json())
      if (!shot || !shot.found) { this.stats.frameMiss += 1; return }
      this.stats.hashChecks += 1
      const win = shot.window || {}
      // Read the previous identity BEFORE writing the new one: assigning first
      // made identityChanged compare the new value against itself and never fire.
      const prev = this.lastWindow
      const dist = this.lastScreenHash === null ? 99 : hamming(shot.hash, this.lastScreenHash)
      this.lastScreenHash = shot.hash
      this.motion.push(dist)
      this.lastMotion = this.motion.rank(dist)

      // React first: a switched window is worth saying before it is described.
      //
      // Only an IDENTITY change (process or title) qualifies, not every pixel
      // change - otherwise this would double every push. The description for
      // this frame arrives moments later and enriches the following one, so the
      // companion reacts at ~90ms instead of ~750ms and still learns what it was.
      const identityChanged = !!prev && (prev.process !== (win.process || '') || prev.title !== (win.title || ''))
      if (identityChanged && !this.micOnly) {
        const quick = '【换窗口了】' + String(win.process || '') + ' — ' + String(win.title || '').slice(0, 50) +
          '\n（描述还没回来，先按这个说一句，下一轮再补细节）'
        this.lastDecision = 'pushed: window switched (react first)'
        this.fire(async () => {
          try { await this.inject(quick, this.speakTarget()) } catch (e) { log('react-first push failed: ' + String(e && e.message).slice(0, 100)) }
        })
      }
      this.lastWindow = { process: win.process || '', title: win.title || '' }

      if (!force && (this.lastMotion.level || 0) < 1) { this.stats.frameSame += 1; return }
      if (Date.now() - this.lastVisionAt < this.frameEveryMs) return
      this.lastVisionAt = Date.now()
      const url = EYES_URL + '/read?path=' + encodeURIComponent(shot.path) + '&prompt=' + encodeURIComponent(this.screenPrompt)
      const v = await fetch(url, { signal: AbortSignal.timeout(45000) }).then((r) => r.json())
      const t = String((v && v.text) || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length < 2) { this.stats.frameMiss += 1; return }
      this.stats.frameHit += 1
      this.frames.push({ at: Date.now(), text: t, hash: shot.hash, hashDist: dist, motionLevel: (this.lastMotion && this.lastMotion.level) || 0, motionRatio: (this.lastMotion && this.lastMotion.ratio) || 1 })
      this.story.observe('frame', { at: Date.now(), text: t })
      if (this.frames.length > 400) this.frames.shift()
    } catch (e) {
      this.stats.frameErr += 1
      log('screen sample failed: ' + String(e && e.message).slice(0, 120))
    }
  }

  async sampleFrame(force) {
    if (Date.now() - this.lastFrameAt < this.frameHashEveryMs) return
    this.lastFrameAt = Date.now()
    try {
      const h = await fetch(BROWSER_URL + '/do?action=videohash', { signal: AbortSignal.timeout(15000) }).then((r) => r.json())
      if (!h || !h.found) { this.stats.frameMiss += 1; return }
      this.stats.hashChecks += 1
      const dist = this.lastFrameHash === null ? 99 : hamming(h.hash, this.lastFrameHash)
      this.lastFrameHash = h.hash
      this.lastVideoTime = h.t
      this.lastPaused = h.paused
      // An episode that reached its end is a scene change, not a paused frame.
      // Without this branch the watcher waits forever for a video that already
      // finished, and the last (often strongest) beat of the series gets no
      // comment at all. It fires once per episode: the ended flag stays true, so
      // a marker keeps it from repeating every hash tick.
      if (h.ended && this.endedFor !== h.duration) {
        this.endedFor = h.duration
        this.pendingEnded = { at: Date.now(), duration: h.duration, t: h.t }
      }
      if (h.paused) { this.stats.framePaused += 1; return }
      this.motion.push(dist)
      this.lastMotion = this.motion.rank(dist)
      if (!force && (this.lastMotion.level || 0) < 1) { this.stats.frameSame += 1; return }
      if (Date.now() - this.lastVisionAt < this.frameEveryMs) return
      this.lastVisionAt = Date.now()
      const j = await fetch(BROWSER_URL + '/do?action=videojpeg&width=960', { signal: AbortSignal.timeout(25000) }).then((r) => r.json())
      if (!j || !j.found || !j.path) { this.stats.frameMiss += 1; return }
      const url = EYES_URL + '/read?path=' + encodeURIComponent(j.path) + '&prompt=' + encodeURIComponent(this.framePrompt)
      const v = await fetch(url, { signal: AbortSignal.timeout(45000) }).then((r) => r.json())
      const t = String((v && v.text) || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length < 2) { this.stats.frameMiss += 1; return }
      this.stats.frameHit += 1
      this.frames.push({ at: Date.now(), text: t, hash: h.hash, hashDist: dist, motionLevel: (this.lastMotion && this.lastMotion.level) || 0, motionRatio: (this.lastMotion && this.lastMotion.ratio) || 1 })
      this.story.observe('frame', { at: Date.now(), text: t })
      if (this.frames.length > 400) this.frames.shift()
    } catch (e) {
      this.stats.frameErr += 1
      log('frame sample failed: ' + String(e && e.message).slice(0, 120))
    }
  }

  recentFrames() {
    const cut = Date.now() - (this.windowSec || 100) * 1000
    return this.frames.filter((f) => f.at >= cut)
  }

  recentSubs() {
    const cut = Date.now() - (this.windowSec || 100) * 1000
    return this.subs.filter((s) => s.at >= cut)
  }

  async tick() {
    // Never let tick bodies overlap: they mutate shared buffers. But DO remember
    // that another pass was requested - a sample landing while a tick is running
    // must not simply be dropped, or the fresh material waits for the next timer
    // (up to 2 seconds, which is exactly the latency we are trying to remove).
    if (this.busyTick) { this.tickQueued = true; return }
    this.busyTick = true
    try {
      await this.tickBody()
    } finally {
      this.busyTick = false
      if (this.tickQueued) {
        this.tickQueued = false
        if (this.running) {
          setTimeout(() => { this.tick().catch((e) => log('queued tick failed: ' + String(e && e.message).slice(0, 120))) }, 0)
        }
      }
    }
  }

  async tickBody() {
    this.stats.ticks += 1
    // Subtitles are only worth reading when the video is actually being
    // commented on. In call mode (micOnly) this OCR loop was blocking the
    // pusher for seconds at a time, which is where the 10-20 second replies
    // came from: the user's sentence was queued behind an OCR call it did not
    // even need.
    if (!this.micOnly) {
      // Run both samplers concurrently and WITHOUT awaiting them.
      //
      // They used to be awaited one after the other, so a 1.8s subtitle read plus
      // a 1.5s picture read made the whole loop ~3.8s per pass and subtitles that
      // stayed on screen for only 2s were missed. Now each sampler guards itself
      // with its own interval and they overlap; the decision below always runs on
      // whatever has already arrived.
      // Two mutually exclusive subjects: a player gives subtitles AND pictures,
      // any other window gives pictures only. Same cheap-hash discipline either
      // way, so a still screen costs nothing.
      if (this.mode === 'screen') {
        this.fire(this.sampleScreen)
      } else {
        this.fire(this.sampleSubtitle)
        this.fire(this.sampleFrame)
      }
    }
    // Fetch the WHOLE window, not a delta.
    //
    // The previous version filtered by "since the last 4 second tick", so every
    // push carried a single ASR fragment of 10-20 characters with no context.
    // The watcher was handed 13 disconnected fragments across a whole episode
    // and correctly refused to comment on any of them. A push must carry a
    // scene, not a syllable.
    const win = Math.min(Math.max(Number(this.windowSec) || 100, 20), 600)
    const url = DIGEST_URL + '?seconds=' + win + '&max=60' + (this.since ? '&since=' + this.since + '&wait=' + (this.longPollMs || 1500) : '')
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('digest HTTP ' + res.status)
    const d = await res.json()
    const sinceMs = this.since
    if (d.now) this.since = d.now

    // Live speaking frequency, pushed down by the panel. Applied every tick so a
    // change takes effect within one poll instead of needing a restart.
    this.applyTuning(d.tuning)

    // The microphone is a conversation: only what is NEW matters - but "new" is
    // decided by TIME, never by text. A person repeating himself is asking again
    // (or was not heard, or is annoyed); swallowing it because we have "already
    // heard that sentence" makes the companion look deaf. Text-level de-dup is
    // for the video channel only.
    const mic = (d.mic || []).filter((l) => l.text && String(l.text).trim().length > 1 && Date.parse(l.at) > sinceMs)
    // No hint channel here. The session that owns the story messages its avatar
    // subagent directly (same tree, so the host allows it); the pusher's job is
    // only to carry what the sensors observed.
    // The video is a story: the whole window is the context.
    const video = (d.video || []).filter((l) => l.text && String(l.text).trim().length > 1)
    // Loudness of the most recent video segment: 'said quietly' and 'shouted'
    // produce the same transcript, so the picture cannot carry this alone.
    // Drop the companion's own voice coming back through the loopback.
    //
    // Speaking aloud feeds the system-audio capture, so the watcher was
    // transcribing its own lines and treating them as plot: "收工了" and
    // "我也歇着" were stored as video dialogue and commented on again. Compare
    // against what we actually spoke and discard near-duplicates.
    // Refresh the list of what the mouth recently said, straight from the mouth
    // (37716). It used to ask the eyes, which proxies the same answer - one hop
    // and one timeout nobody needs on a path that runs every tick.
    try {
      const said = await fetch(MOUTH_URL + '/said', { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
      if (said && Array.isArray(said.recent)) {
        this.spoken = said.recent
        const last = said.recent[said.recent.length - 1]
        if (last && last.at) this.lastSpokeAt = last.at
      }
    } catch { /* mouth down: no echo filter this tick (it cannot be speaking either) */ }
    const spoken = this.spoken || []
    const isEcho = (line) => {
      const s = String(line.text || '')
      if (!s) return false
      for (const sp of spoken) {
        if (!sp || !sp.text) continue
        // containment either way catches partial ASR of the same utterance
        if (sp.text.includes(s.slice(0, 8)) || s.includes(sp.text.slice(0, 8))) return true
        // same opening characters within the last minute is close enough
        if (s.slice(0, 6) === sp.text.slice(0, 6)) return true
      }
      return false
    }
    const before = video.length
    const clean = video.filter((l) => {
      if (Date.now() - (l.at ? Date.parse(l.at) : 0) < 12000 && this.lastSpokeAt && Date.now() - this.lastSpokeAt < 12000) return false
      return !isEcho(l)
    })
    if (clean.length !== before) {
      this.stats.echoDropped = (this.stats.echoDropped || 0) + (before - clean.length)
    }
    video.length = 0
    video.push(...clean)
    if (video.length > 0) {
      const lastLoud = video[video.length - 1]
      this.currentLoud = lastLoud.loud || 0
      this.currentPeak = lastLoud.peak === null || lastLoud.peak === undefined ? null : lastLoud.peak
    }

    // The user speaking always wins: that is a conversation, not a broadcast.
    //
    // But a person speaking is not a stream of separate remarks. Without coalescing
    // the pusher fired after every 6-second segment, so a sentence split across two
    // segments got two replies - which reads as "she talks too much" even though
    // each reply was fine. Holding briefly lets a run of fragments become one turn.
    if (mic.length > 0) {
      const gap = this.coalesceMs || 0
      const newest = Date.parse(mic[mic.length - 1].at)
      if (gap > 0 && Date.now() - newest < gap) {
        // Still possibly mid-sentence: hold, and let the next tick pick up the rest.
        if (!this.coalesceSince) this.coalesceSince = Date.now()
        if (Date.now() - this.coalesceSince < gap * 2) {
          this.lastDecision = 'held: coalescing speech (' + Math.round((gap - (Date.now() - newest)) / 1000) + 's left)'
          this.stats.coalesced = (this.stats.coalesced || 0) + 1
          return
        }
        // Cap reached: say it now rather than swallow the whole run.
      }
      this.coalesceSince = 0
      this.lastDecision = 'pushed: user spoke'
      await this.inject(this.compose(mic, video, 'user'), this.chatTarget())
      return
    }
    this.coalesceSince = 0
    if (this.micOnly) { this.lastDecision = 'skipped: micOnly'; this.stats.skipped += 1; return }

    // ------- two channels out -------
    //
    // Channel A (instant): a moment scored salient by cheap rules is reported
    // immediately, with the dialogue and picture around it. This is what catches
    // the fight that turns in two seconds, instead of sampling past it.
    // Channel B (regular): everything else is packed and reported every 30s so
    // the plot state keeps advancing without a call per observation.
    const frames = this.recentFrames()
    const subsNow = this.recentSubs()
    const scored = []
    for (const f of frames.slice(-6)) {
      const dist = f.hashDist || 0
      scored.push({ kind: 'frame', at: f.at, text: f.text, s: scoreMoment('frame', { hashDist: f.hashDist || dist, motionLevel: f.motionLevel || 0, motionRatio: f.motionRatio || 1 }, { stillChecks: this.stillChecks, silentSec: this.silentSec }) })
    }
    // The newest picture supplies the facial/body tension that the line alone
    // cannot express.
    const latestPic = frames.length > 0 ? frames[frames.length - 1].text : ''
    const picInfo = pictureTension(latestPic)
    for (const s of subsNow.slice(-8)) {
      scored.push({
        kind: 'subtitle',
        at: s.at,
        text: s.text,
        s: scoreMoment('subtitle', {
          text: s.text,
          picTension: picInfo.score,
          picMarks: picInfo.marks,
          loud: s.loud || 0,
        }, { silentSec: this.silentSec }),
      })
    }
    this.story.roll(subsNow, frames, Date.now())
    const top = scored.sort((a, b) => b.s.score - a.s.score)[0]

    // Video observations go to whoever can SPEAK about them.
    //
    // The watcher's job is recording, and a recorder has no mouth: routing video
    // beats there produced accurate notes that nobody ever heard. The talker has
    // screen_say, so that is where a scene worth commenting on must land. The
    // watcher still receives them (for its own record) by way of its regular
    // digest, but the line that gets spoken is the talker's.
    if (top && isSalient(top.s, this.salientThreshold) && Date.now() - this.lastSalientAt > (this.salientCooldownMs || 25000)) {
      // Do not stack beats on top of a backlog. If the last push is still
      // sitting unprocessed, this one joins the next window instead of queueing
      // behind it - that queue is what made replies land 15 seconds late.
      // Pace to the OBSERVED turn time, not a fixed guess.
      //
      // Measured turns ran 2-8 seconds, so any push arriving near the end of one
      // collided with it and the loser waited 12-26s. The pusher cannot see when
      // a turn finishes, but it can watch how long the gap between its own
      // pushes and the next sign of activity usually is, and hold off that long.
      const holdMs = this.paceMs || this.settleMs || 12000
      if (this.pendingSince && Date.now() - this.pendingSince < holdMs) {
        this.stats.salientDeferred = (this.stats.salientDeferred || 0) + 1
        this.lastDecision = 'salient held: previous push still settling'
        return
      }
      this.pendingSince = Date.now()
      this.lastSalientAt = Date.now()
      const around = subsNow.slice(-6).map((x) => x.text)
      const pic = frames.slice(-3).map((x) => x.text)
      this.lastDecision = 'pushed: salient ' + top.s.score + ' (' + top.s.reasons.join(',') + ')'
      this.stats.salientPushes += 1
      this.moments.push({ at: new Date().toISOString(), score: top.s.score, reasons: top.s.reasons })
      if (this.moments.length > 200) this.moments.shift()
      // A salient beat must not starve the regular channel: if a regular digest
      // is already due, push it out by one interval instead of discarding it.
      if (Date.now() - this.lastRegularAt >= this.regularEveryMs) {
        this.regularDeferred += 1
      }
      await this.inject(this.composeMoment(top, around, pic, video), this.speakTarget())
      return
    }

    // The episode ended. This outranks every other branch: it happens once per
    // episode, it is usually the emotional peak, and the regular channel would
    // otherwise keep "collecting" against a video that stopped playing.
    if (this.pendingEnded && Date.now() - this.pendingEnded.at < 30000) {
      const ended = this.pendingEnded
      this.pendingEnded = null
      this.pendingSince = Date.now()
      this.lastDecision = 'pushed: episode ended at ' + ended.t + 's'
      this.stats.endedPushes = (this.stats.endedPushes || 0) + 1
      const pic = frames.slice(-3).map((x) => x.text)
      const subs = this.recentSubs().slice(-6).map((x) => x.text)
      const head = '【这一集播完了】时长 ' + (ended.duration || '?') + ' 秒，画面停在最后一帧。\n'
      const body = (pic.length ? '最后几个画面：\n' + pic.map((t) => '  · ' + t).join('\n') + '\n' : '') +
        (subs.length ? '最后几句对白：\n' + subs.map((t, i) => '  ' + (i + 1) + '. ' + t).join('\n') + '\n' : '')
      await this.inject(
        head + body + '\n这是整集的收尾——说一句就是这一集的总结或感受（25字内，口语），带上 emotion。' + REPORT_LINE,
        this.speakTarget(),
      )
      return
    }

    // ---- danmaku branch: read the chat, answer one comment ----
    //
    // Separate from the scene branches on purpose. Chat is aimed AT the host; the
    // scene is what she is watching. Answering a viewer is a different act from
    // commenting on the picture, and mixing them produced replies that addressed
    // nobody ("这集好看" in response to "主播几岁").
    //
    // One line per turn, not the whole queue: a wall of ten comments answered at
    // once reads as a bot, and the audio for it runs for a minute.
    if (this.danmakuEnabled && this.danmakuUrl && Date.now() - (this.lastDanmakuAt || 0) >= this.danmakuEveryMs) {
      if (!this.pendingSince || Date.now() - this.pendingSince >= (this.settleMs || 8000)) {
        this.lastDanmakuAt = Date.now()
        try {
          const reset = this.danmakuAnswered ? '' : '&reset=1'
          const r = await fetch(EARS_SELF + '/danmaku?limit=25' + reset + '&url=' + encodeURIComponent(this.danmakuUrl), { signal: AbortSignal.timeout(20000) }).then((x) => x.json())
          const fresh = (r && r.fresh) || []
          if (fresh.length) {
            // Newest first: a viewer who just asked something is still watching,
            // while a comment from two minutes ago may have been answered or left.
            const pick = fresh[fresh.length - 1]
            this.danmakuAnswered = (this.danmakuAnswered || 0) + 1
            this.pendingSince = Date.now()
            this.lastSpeechAt = Date.now()
            this.lastDecision = 'pushed: danmaku from ' + pick.user
            const recent = (this.danmakuAnswered > 1 && this.danmakuLog) ? this.danmakuLog.slice(-3).map((x) => '  · ' + x.user + '：' + x.text).join('\n') : ''
            this.danmakuLog = (this.danmakuLog || []).concat([pick]).slice(-10)
            await this.inject(
              '【弹幕】' + pick.user + '：' + pick.text + '\n' +
              (recent ? '刚才回过的几条（别重复）：\n' + recent + '\n' : '') +
              '\n这是观众在跟你说话。' +
              (this.story && this.story.summary() ? '当前画面：' + this.story.summary() + '\n' : '') +
              '回他一句，20字内，口语，直接对着他说。' +
              '**如果他在问问题就回答问题**，别只顾着点评画面。' +
              '看不懂的内容（纯表情、乱码）就顺着接一句，不用硬猜。' + REPORT_LINE,
              this.speakTarget(),
            )
            return
          }
          this.lastDecision = 'skipped: danmaku, nothing new'
        } catch (e) {
          this.stats.danmakuErr = (this.stats.danmakuErr || 0) + 1
          this.lastDecision = 'skipped: danmaku fetch failed'
        }
      }
    }

    // ---- cold branch: nobody has said anything for a while ----
    //
    // Reads BEFORE the material-based branches on purpose: every branch below
    // requires something new to have happened, and this one exists precisely for
    // when nothing has.
    //
    // The guard on lastColdAt stops it re-entering while a cold push is still
    // being consumed - pendingSince alone would cover that, but pendingSince is
    // also cleared by paths this branch does not own, and a cold line every tick
    // would be worse than silence.
    const silentFor = Date.now() - (this.lastSpeechAt || this.startedAt || Date.now())
    const coldCooldownOk = !this.lastColdAt || Date.now() - this.lastColdAt >= this.patienceMs
    if (!this.pendingSince && coldCooldownOk && silentFor > this.patienceMs) {
      this.lastSpeechAt = Date.now()
      this.lastColdAt = Date.now()
      this.pendingSince = Date.now()
      this.coldPushes += 1
      this.stats.coldPushes = this.coldPushes
      this.lastDecision = "pushed: cold, silent for " + Math.round(silentFor / 1000) + "s"
      const body = this.composeCold(silentFor)
      if (this.recentColdSame === body) {
        this.lastDecision = "skipped: cold message identical to last one"
        this.pendingSince = 0
        return
      }
      this.recentColdSame = body
      await this.inject(body, this.speakTarget())
      return
    }

    // regular packed digest
    const due = Date.now() - this.lastRegularAt >= this.regularEveryMs && (!this.pendingSince || Date.now() - this.pendingSince >= (this.settleMs || 8000))
    const hasMaterial = subsNow.length >= 2 || video.length >= 3 || frames.length >= 2
    if (due && hasMaterial) {
      this.lastRegularAt = Date.now()
      // Mark the queue busy so the next cycle waits for this turn to be consumed.
      this.pendingSince = Date.now()
      this.lastDecision = 'pushed: regular digest'
      this.stats.regularPushes += 1
      await this.inject(this.compose([], video, 'video'), this.speakTarget())
      return
    }
    this.lastDecision = 'skipped: collecting (due in ' + Math.max(0, Math.round((this.regularEveryMs - (Date.now() - this.lastRegularAt)) / 1000)) + 's)'
    // The old body referenced waitMs and subs, neither of which exists in this
    // scope, so every tick that reached this branch threw and the pusher sat
    // there logging "push tick failed" instead of pushing. A start with no long
    // poll and nothing buffered simply has nothing to say yet.
    this.stats.skipped += 1
  }

  // Read the mood of the current stretch.
  //
  // "压抑" is not one number. It is quiet audio that stays quiet, few or no
  // lines, and faces the picture describes as heavy. Compute those three and
  // say them plainly; the model can judge what they add up to.
  atmosphere(subs, frames) {
    const quiet = (this.currentLoud || 0) === 0
    const loudPeak = this.currentPeak
    const silentLong = (this.silentSec || 0) >= 8
    const heavy = frames.filter((f) => /低头|皱眉|沉默|发红|苍白|凝视|呆住|难过|哭|压抑|沉|紧|暗/.test(f.text)).length
    const bright = frames.filter((f) => /笑|阳光|亮|温暖|轻松|愉快/.test(f.text)).length
    const few = subs.length <= 3
    const parts = []
    if (quiet && (loudPeak === null || loudPeak < 0.15)) parts.push('声音很轻')
    if (silentLong) parts.push('长时间没对白')
    if (few) parts.push('台词少')
    if (heavy >= 2) parts.push('画面沉重(' + heavy + '帧)')
    if (bright >= 2) parts.push('画面明亮(' + bright + '帧)')
    if (parts.length === 0) return ''
    return '【氛围】' + parts.join('、')
  }

  // A salient moment is reported as "here is what just happened", not as a
  // verdict. The parent decides what it means; the watcher only reports.
  // The cold message, and the one thing it must get right.
  //
  // It states out loud that NOTHING happened. Give a model only "you should
  // speak now" and it will invent a scene it never saw - and the audience is
  // looking at the same picture. "Why did she say someone fell over?" is the one
  // mistake on a live stream that cannot be explained away afterwards.
  composeCold(silentMs) {
    const secs = Math.round(silentMs / 1000)
    const story = this.story ? this.story.summary() : ""
    const lastSubs = this.recentSubs().slice(-3).map((s) => "  · " + s.text).join("\n")
    const pic = this.recentFrames().slice(-2).map((x) => "  · " + x.text).join("\n")
    const mids = this.moments.length
      ? "刚才说过的几个点：" + this.moments.slice(-3).map((m) => String(m.reasons || []).join(",")).join(" / ") + "\n"
      : ""

    return "【冷场】已经 " + secs + " 秒没有值得说的事了 —— 不是你没看见，是真的没发生什么。\n" +
      (story ? "剧情到这里：" + story + "\n" : "") +
      (lastSubs ? "最后几句对白（可能已经说过）：\n" + lastSubs + "\n" : "") +
      (pic ? "画面还停在这里：\n" + pic + "\n" : "") +
      mids +
      "\n说一句不代表剧情的话：吐槽节奏太慢、问问观众还在不在、聊点跟这集不相干的。" +
      "**不要编造刚才发生的事**——观众看得见画面，编了就露馅。25字内，口语。" + REPORT_LINE
  }
  composeMoment(top, around, pic, video) {
    const lines = around.filter(Boolean).slice(-6).map((t, i) => '  ' + (i + 1) + '. ' + t).join('\n')
    const pictures = pic.filter(Boolean).slice(-3).map((t) => '  · ' + t).join('\n')
    // The story state travels WITH the moment. A key beat without its context
    // is exactly what made the parent misread plots before.
    const story = this.story ? this.story.summary() : ''
    return '【关键点 · ' + top.kind + ' · 分值 ' + top.s.score + '】' + (top.s.reasons.length ? '（' + top.s.reasons.join('、') + '）' : '') + '\n' +
      '【剧情进展到】\n' + story + '\n' +
      '【这一刻】' + String(top.text).slice(0, 60) + '\n' +
      (pictures ? '画面：\n' + pictures + '\n' : '') +
      (lines ? '前后对白：\n' + lines + '\n' : '') +
      (this.atmosphere(around, pic.map((t) => ({ text: t }))) ? this.atmosphere(around, pic.map((t) => ({ text: t }))) + '\n' : '') +
      '\n看完再决定要不要开口，25字内，口语。'
  }

  compose(mic, video, kind) {
    if (kind === 'user') {
      const head = '【耳朵·用户刚说话】' + joinLines(mic, 3)
      const ctxLine = video.length > 0 ? '\n【视频最近在放】' + joinLines(video, 12) : ''
      // A spoken command belongs to the session that holds the hands.
      //
      // The companion can talk, but playback is the operator's call. When the
      // user says "可以播放了", the companion must hand that over as a command
      // from the user - not act on it, and not let the operator mistake it for
      // the companion deciding on its own.
      const isCommand = /播放|开播|开始|停|暂停|放|收工|结束|关/.test(head)
      // Who owns the hands is the operator, not the companion, and the name is
      // whatever this install calls its user - never a hard-coded person.
      const OWNER = process.env.DSH_WATCH_OWNER || '用户'
      const relay = isCommand
        ? '\n【这是' + OWNER + '的指令，不是你自己的决定】请在回复里原样转达给操作会话：' +
          '「' + OWNER + '说：' + head.replace('【耳朵·用户刚说话】', '').trim().slice(0, 40) + '，' +
          '该你操作了」。同时用 screen_say 应一声（10 字内）。\n' +
          '不要自己执行播放/暂停/收工，那是操作会话的权限。'
        : ''
      return head + ctxLine + relay + '\n【立刻用 screen_say 回一句】20 字内，口语，像打电话。\n' +
        '表情：按这句的情绪选 emotion —— 高兴 happy、难过 cry、被震住 stunned、好笑 big-laugh / small-laugh。拿不准就不传，保持当前表情。\n' +
        // User speech is also a beat the brain should know about, so the report
        // line is required here too - a reply with no context is how the brain
        // ends up integrating a conversation it never saw.
        REPORT_LINE
    }
    const span = Math.round((this.windowSec || 100))
    const subs = this.recentSubs()
    const frames = this.recentFrames()
    // Subtitles win when present: they are whole sentences, not ASR fragments.
    // Keep the payload small. A turn took ~4 seconds and pushes arrived every
    // 3-18, so the watcher could never catch up and replies landed up to 30s
    // late. Cutting the body directly shortens every turn.
    const source = subs.length >= 2 ? subs.map((s) => s.text) : video.map((l) => l.text)
    const lines = source.slice(-8).map((t, i) => '  ' + (i + 1) + '. ' + t).join('\n')
    const pic = frames.slice(-3).map((f) => '  · ' + f.text).join('\n')
    const story = this.story ? this.story.summary() : ''
    const mood = this.atmosphere(subs, frames)
    // In screen mode the subject is whatever window is in front, and naming it
    // is most of the context: "a spreadsheet" and "a game" get different
    // reactions from the same pixels.
    const isScreen = this.mode === 'screen'
    const win = this.lastWindow
    const winLine = isScreen && win && win.title
      ? '【在看】' + String(win.process || '') + ' — ' + String(win.title).slice(0, 60) + '\n'
      : ''
    const head = isScreen ? '【屏幕 最近 ' + span + ' 秒】' : '【视频 ' + span + ' 秒】'
    // When this video has no readable subtitle track, say so in the payload.
    // Otherwise the watcher is told "对白：" with audio fragments under it and
    // reads them as dialogue - which is how it ends up commenting on watermark
    // text and guessing at lines nobody said.
    const noSubLine = !isScreen && this.subtitleUnavailable
      ? '【这一集没有可读字幕】下面的"对白"是耳朵从画面里听到的声音（转写可能有错字），不是字幕原文。\n'
      : ''
    const body = head + '\n' +
      winLine +
      noSubLine +
      (story ? story + '\n' : '') +
      (mood ? mood + '\n' : '') +
      (lines ? '对白：\n' + lines + '\n' : '') +
      (pic ? '画面：\n' + pic + '\n' : '')

    // Bell mode: the receiver is a stateless bell, not a speaker.
    //
    // The normal body ends with "用 screen_say 说一句", which a bell faithfully
    // obeys - measured: it talked over the parent three times in a row, because
    // the push's instruction outranked its own "do nothing" prompt. So in bell
    // mode the payload carries no speaking instruction at all, only the fact that
    // something arrived.
    if (this.bell) {
      return body + '\n【有新观察。读完就结束回合，不要说话。】'
    }

    return body +
      '\n用 screen_say 说一句（20字内，口语），带上 emotion。' +
      // The brain reads only this line: it cannot see the picture, and it must
      // know both what happened and what was already said. Without it the two
      // halves of the stack ("understands" vs "speaks") have no channel at all.
      REPORT_LINE
  }

  // Who receives user speech?
  //
  // Video observations belong to the watcher (it only records). But when the
  // user SPEAKS they are talking to the operator - "可以播放啦" is a command, not
  // a scene. Sending it to the watcher meant the command was acknowledged by a
  // session that cannot act on it, and playback never started.
  // Where does user speech go?
  //
  // Delivering to the operator session itself is IMPOSSIBLE: the host rejects a
  // message whose recipient is not a child of the given parent
  // ("belongs to another parent session"). Measured directly. So speech needs a
  // second child - a talker subagent - that answers with screen_say. The
  // operator keeps the hands (start/stop/play), the talker keeps the mouth.
  // Who talks about the video?
  //
  // The session that understands the scene is the one that should say something
  // about it. Splitting "understands" and "speaks" across two sessions meant the
  // sentence was generated by one model and then re-spoken by another - a whole
  // extra turn to say words that already existed. One session, one turn.
  speakTarget() {
    return this.chatTargetId || this.target
  }

  chatTarget() {
    // Same session by default: whoever hears the user is also whoever watches
    // the video, so the reply has the scene in context.
    if (this.chatTargetId) return this.chatTargetId
    return this.target
  }

  resolveParent() {
    if (this.callerAgent) return this.callerAgent
    const agents = this.ctx && this.ctx.agents
    if (!agents) return undefined
    if (this.parentId && typeof agents.get === 'function') {
      const p = agents.get(this.parentId)
      if (p) return p
    }
    if (typeof agents.list === 'function' && typeof agents.get === 'function') {
      try {
        for (const a of agents.list()) {
          const sid = a && a.session && a.session.id
          const hdr = a && a.session && a.session.header
          if (String(sid) === String(this.target) && hdr && hdr.parentSession) {
            const p = agents.get(hdr.parentSession)
            if (p) return p
          }
        }
      } catch (e) {
        log('resolveParent list failed: ' + String(e && e.message))
      }
    }
    return undefined
  }

  // A watcher that reports "done" after every single push floods its parent with
  // a notice per observation. The parent is the operator session, so the user's
  // own speech gets buried under "记录：..." lines. The fix is to make the pushed
  // message the END of what the watcher says: instruct it to stay silent when it
  // has nothing to add, so its turn ends without a completion message.
  async inject(text, overrideTarget) {
    const s = this.ctx && this.ctx.subagents
    if (!s) throw new Error('this host has no subagents service')
    const parent = this.resolveParent()
    const target = overrideTarget || this.target
    const content = [{ type: 'text', text }]
    const signal = new AbortController().signal
    const attempts = [
      ['followup', () => s.followup(parent, target, content, { signal })],
      ['deliver', () => s.deliver(parent, target, content, undefined, signal, 'queue')],
      ['queue', () => s.queue(parent, target, content, undefined, signal)],
      ['sendMessage', () => s.sendMessage(parent, target, content, { signal })],
    ]
    let lastErr = null
    for (const [name, fn] of attempts) {
      if (typeof s[name] !== 'function') continue
      try {
        await fn()
        this.delivery = name
        this.stats.injected += 1
        // Any real push resets the cold clock: the host just said something.
        this.lastSpeechAt = Date.now()
        // Any injection resets the video throttle: never talk twice in a row.
        this.lastVideoPush = Date.now()
        this.lastError = null
        this.pushes.push({ at: new Date().toISOString(), via: name, chars: text.length, text: text.slice(0, 90) })
        if (this.pushes.length > 40) this.pushes.shift()
        log('push injected via ' + name + ' (' + text.length + ' chars)')
        return true
      } catch (e) {
        lastErr = name + ': ' + String(e && e.message)
      }
    }
    this.stats.errors += 1
    this.lastError = lastErr || ('no delivery method on subagents; keys=' + Object.keys(s).join(','))
    return false
  }
}
