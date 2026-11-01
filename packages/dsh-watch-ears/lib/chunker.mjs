// Split a streaming LLM response into speakable chunks, as it arrives.
//
// The problem this solves: the mouth takes one whole line per /say, so every reply
// waits for the LAST token before the FIRST sound. Measured end-to-end, that wait
// is 0.5-2s of pure latency - far more than any TTS model choice is worth.
//
// The rules come from RealtimeTTS and from what a listener actually tolerates:
//
//   * never cut mid-phrase. "这集其实挺无" reads with a broken tone, and the
//     listener hears it as a glitch, not as a pause.
//   * the first chunk may be SHORTER than the rest: time-to-first-sound is the
//     number people judge, and a short opener costs nothing.
//   * a chunk under ~8 characters sounds clipped even at a boundary.
//   * if no punctuation arrives for a long time, cut anyway - silence is worse
//     than a slightly awkward join.
//
// Usage:
//   const feed = createChunker()
//   for (const token of tokens) for (const c of feed(token)) speak(c)
//   for (const c of feed.end()) speak(c)

const HARD_BREAK = /[。！？!?\n]/
const SOFT_BREAK = /[，,、；;：:]/

export function createChunker(opts = {}) {
  // 40 is deliberately larger than the "40 characters" the mouth accepts: the
  // chunker's job is natural speech units, and a long comma-spliced sentence
  // should still go out in two audible pieces.
  const maxLen = Math.min(Math.max(Number(opts.maxLen) || 40, 12), 120)
  // The opener may be half the normal length. Anything below 6 characters gets
  // clipped by the synthesiser's own attack.
  const firstMax = Math.min(Math.max(Number(opts.firstMax) || Math.round(maxLen / 2), 8), maxLen)
  const minLen = Math.max(2, Number(opts.minLen) || 6)

  let buf = ''
  let emitted = 0
  let done = false

  // A chunk of pure punctuation ("！", "，。") is not speakable. The synthesiser
  // either reads it as silence or emits a stray noise, and it burns a round trip
  // on the mouth's queue. Content is what makes a chunk real.
  const speakable = (s) => /[\p{L}\p{N}]/u.test(s)

  function take(len) {
    const out = buf.slice(0, len).trim()
    buf = buf.slice(len)
    if (out && speakable(out)) emitted += 1
    return out
  }

  function* drain() {
    // Emit as many natural units as the buffer currently allows.
    for (;;) {
      const limit = emitted === 0 ? firstMax : maxLen
      // 1. a sentence end inside the limit
      let cut = -1
      for (let i = 0; i < buf.length && i < limit; i++) {
        if (HARD_BREAK.test(buf[i])) {
          cut = i + 1
          break
        }
      }
      // 2. otherwise a clause end, but only if it leaves a chunk worth speaking
      if (cut < 0) {
        let soft = -1
        for (let i = 0; i < buf.length && i < limit; i++) {
          if (SOFT_BREAK.test(buf[i])) soft = i + 1
        }
        if (soft >= minLen) cut = soft
      }
      // 3. otherwise overrun the limit and cut at the last space/clause we have
      if (cut < 0 && buf.length > limit) {
        let soft = buf.lastIndexOf('，')
        if (soft < minLen) soft = buf.lastIndexOf(' ')
        cut = soft > minLen ? soft + 1 : limit
      }
      if (cut < 0) return
      const piece = take(cut)
      if (piece && speakable(piece)) yield piece
    }
  }

  return {
    feed(token) {
      if (done) return []
      buf += String(token)
      return [...drain()]
    },
    // Flush what is left. Call exactly once, when the response ends.
    end() {
      if (done) return []
      done = true
      const rest = buf.trim()
      buf = ''
      // A trailing fragment with no letters or digits is punctuation left over
      // from a sentence already emitted; speaking it would be a noise, not a word.
      if (!rest || !speakable(rest)) return []
      emitted += 1
      return [rest]
    },
    get pending() {
      return buf
    },
  }
}

// Split a finished string with the same rules. Used by the offline benchmark and
// by any caller that has the whole reply already (a cached line, a test).
export function chunkText(text, opts = {}) {
  const c = createChunker(opts)
  const out = []
  for (const ch of String(text)) out.push(...c.feed(ch))
  out.push(...c.end())
  return out
}
