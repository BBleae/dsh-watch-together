// Rolling story state.
//
// The watcher must not accumulate. If every observation were appended, the
// parent would eventually receive thousands of fragments and still have no idea
// what is going on. So the watcher keeps ONE evolving summary of the current
// scene, rebuilt from the last window of observations every so often, and ships
// that summary alongside every push.
//
// This is deliberately rule-based, not a model call: it costs nothing, it never
// blocks a push, and it only has to answer 'what has happened in the last
// couple of minutes' - the meaning is still the parent's job.

const MAX_ROLL_LINES = 8
const ROLL_WINDOW_MS = 120000

// Words that are never names. A naive [\u4e00-\u9fa5]{2,3} match produced
// "暗房间", "在床边" and "鱼玩偶" as recurring characters.
// Extracting character names from Chinese by regex does not work: a naive
// 2-3 character scan produced "我叫久", "爸爸你", "她只要" as characters. Rather
// than guess, only accept tokens with strong evidence:
//   1. an explicit address suffix (久留美酱 / 康震老师)
//   2. the same 2-3 character token repeated across DIFFERENT lines
// Store the evidence, let the parent interpret it.
const STOP = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '什么', '怎么', '为什么',
  '现在', '刚才', '已经', '可以', '应该', '可是', '但是', '然后', '因为', '所以',
  '不是', '没有', '就是', '还是', '一样', '真的', '好像', '觉得', '知道', '看到',
  '一个', '两个', '时候', '地方', '东西', '事情', '样子', '感觉', '这里', '那里',
  '自己', '别人', '大家', '一边', '一直', '一下', '不要', '不会', '不能', '不会',
  '爸爸', '妈妈', '孩子', '朋友', '老师', '医生', '叔叔', '阿姨', '哥哥', '姐姐',
])

// Tokens worth counting: only address-suffixed names, plus any 2-3 char run
// that survives the stop list AND shows up again later.
export function nameCandidates(line) {
  const out = []
  const suffixed = line.match(/[\u4e00-\u9fa5]{2,3}(?:酱|桑|君|姐|哥|老师|前辈)/g) || []
  for (const s of suffixed) out.push({ token: s, strong: true })
  const runs = line.match(/[\u4e00-\u9fa5]{2,3}/g) || []
  for (const r of runs) {
    if (STOP.has(r)) continue
    if (/^[的了着呢吧啊呀吗哦嗯我你他她它这那]/.test(r)) continue
    if (/[的了着呢吧啊呀吗哦嗯]$/.test(r)) continue
    out.push({ token: r, strong: false })
  }
  const seen = new Set()
  return out.filter((x) => { if (seen.has(x.token)) return false; seen.add(x.token); return true }).slice(0, 3)
}


export class StoryState {
  constructor() {
    this.lines = []      // rolled-up beats, oldest first
    this.people = new Map() // token -> { n, strong, lastLine }
    this.lineNo = 0
    this.scene = null
    this.lastRollAt = 0
    this.episodeMarks = []
  }

  // Feed one observation. kind: 'subtitle' | 'frame'
  observe(kind, obs) {
    const t = String(obs.text || '').trim()
    if (t === '') return
    if (kind === 'frame') {
      // Picture descriptions never contain names worth tracking: "他低头" and
      // "床边" would become characters. Only remember the scene.
      this.scene = t
      return
    }
    // Dialogue is the only source of names.
    //
    // The previous version compared lastLine against this.lineNo and then
    // stamped lastLine with the SAME value, so the guard rejected every line
    // after the first and no token could ever reach a count of two.
    this.lineNo += 1
    for (const cand of nameCandidates(t)) {
      const key = cand.token
      const cur = this.people.get(key) || { n: 0, strong: false, lastLine: -1 }
      if (cur.lastLine === this.lineNo) continue
      this.people.set(key, {
        n: cur.n + 1,
        strong: cur.strong || cand.strong,
        lastLine: this.lineNo,
      })
    }
  }


  // Compress the recent window into a few beat lines. Cheap and idempotent:
  // calling it often does not grow anything.
  roll(subtitles, frames, nowMs) {
    if (nowMs - this.lastRollAt < 15000) return this
    this.lastRollAt = nowMs
    const cut = nowMs - ROLL_WINDOW_MS
    const recentSubs = (subtitles || []).filter((s) => s.at >= cut).map((s) => s.text)
    const recentFrames = (frames || []).filter((f) => f.at >= cut).map((f) => f.text)
    const beats = []
    if (recentFrames.length > 0) {
      // The picture sequence reads like a shot list.
      beats.push('画面：' + recentFrames.slice(-3).join(' → '))
    }
    if (recentSubs.length > 0) {
      beats.push('对白：' + recentSubs.slice(-4).map((s) => '「' + s.slice(0, 24) + '」').join(' '))
    }
    if (beats.length > 0) {
      this.lines.push({ at: nowMs, text: beats.join('；') })
      while (this.lines.length > MAX_ROLL_LINES) this.lines.shift()
    }
    return this
  }

  // The one-line answer to 'where are we in the story'.
  summary() {
    const parts = []
    if (this.scene) parts.push('当前画面：' + this.scene.slice(0, 60))
    const recent = this.lines.slice(-3).map((l) => l.text)
    if (recent.length > 0) parts.push(recent.join('\n         '))
    const topPeople = [...this.people.entries()]
      .filter(([, v]) => v.n >= 2 || v.strong)
      // A token seen once in one line is a phrase, not a person.
      .filter(([, v]) => v.n >= 2 || v.strong)
      .sort((a, b) => (b[1].strong ? 1 : 0) - (a[1].strong ? 1 : 0) || b[1].n - a[1].n)
      .slice(0, 5)
      .map(([name, v]) => name + (v.strong ? '*' : '') + '(' + v.n + ')')
    if (topPeople.length > 0) parts.push('反复出现的人：' + topPeople.join('、'))
    return parts.length > 0 ? parts.join('\n') : '(剧情刚开始，还没有累积)'
  }

  // End of an episode: keep a compact archive, drop the working lines.
  archive(label) {
    const brief = this.lines.slice(-4).map((l) => l.text).join(' / ')
    this.episodeMarks.push({ label: label || '本集', brief: brief.slice(0, 240) })
    if (this.episodeMarks.length > 12) this.episodeMarks.shift()
    this.lines = []
    this.scene = null
    return this.episodeMarks[this.episodeMarks.length - 1]
  }

  snapshot() {
    return {
      summary: this.summary(),
      lines: this.lines.length,
      people: this.people.size,
      archive: this.episodeMarks.slice(-3),
    }
  }
}
