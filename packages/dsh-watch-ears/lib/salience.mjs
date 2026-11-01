// Salience detection for continuous watching.
//
// A fixed sampling interval cannot find the moments that matter: a fight can
// turn in 2 seconds and a stare can hold for 20. The question is not 'when do I
// look' (look constantly) but 'when is something actually happening'.
//
// Two lessons are baked in here, both learned from real runs:
//
//   1. Motion is normal. Consecutive frames of any animated show differ by
//      8-31 bits (median 13). A fixed 'change >= 22' threshold therefore fires
//      on everything, because the actual gap depends on the sampling interval.
//      Thresholds are now RELATIVE to the recent distribution.
//
//   2. Short emotional lines are everywhere in dialogue. 'emotion + short line'
//      scored 44 on nearly every line of one episode, so every beat looked
//      identical. Short lines now contribute little on their own.

const EMOTION_PUNCT = /[!！?？…—~～]|啊|呀|呢|吧|呜|哭|笑|喊|叫|救命/
const BATTLE_WORDS = /打|杀|冲|跑|躲|攻击|防御|血|死|爆炸|赢|输/
const NAME_HINT = /[\u4e00-\u9fa5]{2,4}(?:酱|桑|君|姐|哥|老师|前辈)/

// Keep a rolling window of recent hash distances so 'big change' can mean
// 'bigger than this show usually does' instead of a magic number.
export class MotionBaseline {
  constructor(capacity) {
    this.cap = capacity || 40
    this.samples = []
  }

  push(dist) {
    if (typeof dist !== 'number' || dist < 0) return
    this.samples.push(dist)
    while (this.samples.length > this.cap) this.samples.shift()
  }

  // Median and p85 of the recent window. Median is robust to a single cut.
  stats() {
    if (this.samples.length < 5) return { median: 12, p85: 18, ready: false, n: this.samples.length }
    const s = this.samples.slice().sort((a, b) => a - b)
    return {
      median: s[Math.floor(s.length / 2)],
      p85: s[Math.floor(s.length * 0.85)],
      ready: true,
      n: s.length,
    }
  }

  // How unusual is this distance for this show right now?
  rank(dist) {
    const st = this.stats()
    if (!st.ready) return { ratio: 1, level: 0 }
    const ratio = dist / Math.max(1, st.median)
    let level = 0
    if (ratio >= 2.2 || dist >= st.p85 * 1.6) level = 3      // a real cut
    else if (ratio >= 1.6) level = 2                          // clearly moving on
    else if (ratio >= 1.25) level = 1                         // noticeable
    return { ratio, level, median: st.median, p85: st.p85 }
  }
}

// Physical tension in a shot. These are the words a vision model actually
// produces when something is happening on a face, and they matter more than the
// length of a line: a four character "爸爸抱抱" delivered in tears outranks a
// calm paragraph.
const FACE_TENSION = /哭|泪|哽咽|抽泣|皱眉|咬牙|睁大|瞪|颤抖|发红|通红|苍白|惨白|怒吼|大喊|咆哮|凝视|呆住|惊恐|痛苦|绝望|失神|握拳|紧握|低头|别过头|咬唇|喘/g
const BODY_TENSION = /冲|扑|摔|砸|撞|倒|抓住|抱住|推开|拉起|转身|背对|逼近|后退|逃|跑|扑倒/g

export function pictureTension(text) {
  const t = String(text || '')
  const face = (t.match(FACE_TENSION) || []).slice(0, 3)
  const body = (t.match(BODY_TENSION) || []).slice(0, 3)
  let score = 0
  if (face.length > 0) score += 12 + face.length * 5
  if (body.length > 0) score += 6 + body.length * 3
  // A held, quiet shot with a strong expression is often the loudest beat.
  if (face.length > 0 && /静止|不动|沉默|静默|凝视|呆住/.test(t)) score += 10
  return { score, marks: face.concat(body) }
}

// Rank one observation. Dialogue drives this; motion is only a modifier.
export function scoreMoment(kind, payload, state) {
  const reasons = []
  let score = 0

  if (kind === 'frame') {
    // Relative, not absolute: level 3 means 'bigger cut than this show normally
    // does', which is what an interruption should be based on.
    const lvl = payload.motionLevel || 0
    if (lvl === 3) { score += 26; reasons.push('异常大转场 x' + (payload.motionRatio || 0).toFixed(1)) }
    else if (lvl === 2) { score += 12; reasons.push('明显转场') }
    else if (lvl === 1) { score += 4 }
    if (state && state.stillChecks >= 6) { score += 20; reasons.push('长镜头静止(' + state.stillChecks + ')') }
  }

  if (kind === 'subtitle') {
    const t = String(payload.text || '')
    const pic = payload.picTension || 0
    const loud = payload.loud || 0
    if (EMOTION_PUNCT.test(t)) { score += 20; reasons.push('情绪表达') }
    if (BATTLE_WORDS.test(t)) { score += 14; reasons.push('动作冲突') }
    if (NAME_HINT.test(t)) { score += 12; reasons.push('称呼') }
    if (/[!！?？…]{1,}$/.test(t)) { score += 8 }
    if (/别|不要|不可能|为什么|怎么会|难道|资格|凭什么/.test(t)) { score += 14; reasons.push('转折/对抗') }
    if (EMOTION_PUNCT.test(t) && /别|不要|不可能|为什么|怎么会|难道|资格|凭什么/.test(t)) {
      score += 10; reasons.push('情绪+对抗')
    }
    // Short does not mean weak. A brief line only scores when the delivery or
    // the picture around it carries weight - which is exactly how a person reads
    // "爸爸抱抱" said through tears.
    if (t.length <= 6) {
      if (pic >= 15 || loud >= 1) { score += 18; reasons.push('短促但有张力') }
      else if (/抱|妈|爸|痛|怕|别|走|死|救|爱/.test(t)) { score += 10; reasons.push('短促且触及情感词') }
      else { score += 2 }
    }
    // The picture carries half the meaning: tears, a clenched fist, a stare.
    if (pic > 0) { score += Math.min(24, pic); reasons.push('画面对应张力') }
    // Volume: someone shouting or a score swelling under the line.
    if (loud >= 2) { score += 24; reasons.push('音量高') }
    else if (loud >= 1) { score += 12; reasons.push('音量偏强') }
  }

  if (kind === 'audio') {
    const peak = Number(payload.peak || 0)
    if (peak >= 0.5) { score += 30; reasons.push('音量突增') }
    else if (peak >= 0.3) { score += 14 }
  }

  if (state && state.silentSec >= 10) { score += 20; reasons.push('长静默(' + state.silentSec + 's)') }

  return { score, reasons }
}

export function isSalient(scored, threshold) {
  return scored.score >= (threshold || 35)
}

export function looksLikeOpEd(info) {
  const { t, hasDialogue, hashRepeatRate } = info
  if (t === undefined || t === null) return false
  const nearEdges = t < 100 || (info.duration && t > info.duration - 120)
  if (!nearEdges) return false
  if (hasDialogue) return false
  return (hashRepeatRate || 0) > 0.5 || (info.stillChecks || 0) >= 6
}
