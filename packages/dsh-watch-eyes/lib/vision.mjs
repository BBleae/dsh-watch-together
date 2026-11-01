// Direct vision call to the Zhipu (OpenAI-compatible) endpoint.
// No CLI wrapper, no structured-output schema: we want one short sentence,
// not 17 fields of evidence, so the round trip stays under a second.
import { log } from './shared.mjs'

export async function describe(cfg, imageB64, promptOverride) {
  const p = cfg.provider
  if (!p.apiKey) throw new Error('no apiKey configured; run: eyes config set provider.apiKey <key>')
  const models = [p.model, ...(p.fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i)
  const text = promptOverride && promptOverride.trim() !== '' ? promptOverride : cfg.prompt
  // A "say it in 20 characters" instruction is followed by the paid models and
  // broadly ignored by the free fallback, which answers with a paragraph. Every
  // consumer here (narration, subtitle reads, the watcher's push body) is
  // downstream of a short line, so the cap is enforced rather than requested.
  // The limit is parsed out of the prompt itself (中文: N字 / english: Nchar).
  const cap = (() => {
    const m = /(\d+)\s*(?:个)?(?:字|词|char)/.exec(text)
    return m ? Math.max(8, Number(m[1])) : 0
  })()
  let lastError = null
  const attempts = []
  for (const model of models) {
    const t0 = Date.now()
    try {
      const res = await fetch(String(p.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.apiKey },
        body: JSON.stringify({
          model,
          max_tokens: p.maxTokens,
          temperature: p.temperature,
          thinking: cfg.thinking ? { type: 'enabled' } : { type: 'disabled' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageB64 } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      })
      const body = await res.json().catch(() => null)
      const ms = Date.now() - t0
      if (res.status === 200 && body) {
        const answer = String(body.choices?.[0]?.message?.content ?? '').trim()
        if (answer !== '') {
          attempts.push(model + ':' + ms + 'ms')
          // Say it out loud when the paid model did not serve the frame. A silent
          // downgrade to the free model looks identical to "the picture is
          // simply less detailed", and the quality drop is real (weaker OCR on
          // burned-in subtitles). Callers can then decide to re-read or not.
          if (model !== p.model) log('vision served by fallback ' + model + ' (primary ' + p.model + ' unavailable)')
          // Keep the first clause when the model overruns: a paragraph's opening
          // is what the caller wanted, and a hard slice can cut mid-phrase.
          let out = answer
          let truncated = false
          if (cap && out.length > cap) {
            // Prefer a natural boundary: the first sentence/clause that fits in
            // 1.5x the cap. A hard slice at exactly N characters leaves hanging
            // fragments like "穿西装戴眼镜的男人在", which read as a bug.
            const parts = out.split(/(?<=[。！？.!?，,；;])/).map((s) => s.trim()).filter(Boolean)
            let picked = ''
            for (const part of parts) {
              if ((picked + part).length > Math.round(cap * 1.5)) break
              picked += part
            }
            out = (picked || out.slice(0, cap)).replace(/[，,、；;]$/, '').trim()
            truncated = true
          }
          return {
            text: out,
            model,
            truncated,
            degraded: model !== p.model,
            ms,
            tokens: body.usage?.total_tokens ?? null,
            attempts,
          }
        }
      }
      lastError = new Error(model + ' -> HTTP ' + res.status + ' ' + String(body?.error?.message ?? '').slice(0, 120))
      attempts.push(model + ':fail(' + res.status + ')')
    } catch (e) {
      lastError = new Error(model + ' -> ' + String(e && e.message))
      attempts.push(model + ':error')
    }
    log('vision attempt failed: ' + String(lastError && lastError.message))
  }
  throw lastError ?? new Error('no vision model configured')
}

// Probe the configured primary AND each fallback, so the doctor answers the
// question an operator actually has: "will a frame get read right now, and by
// which model?" A single probe on glm-4.6v used to report "429" beside an ok:true
// answer path, because glm-4v-flash still worked - technically true, useless.
export async function probe(cfg) {
  const p = cfg.provider
  const primary = p.model
  const models = [p.model, ...(p.fallbackModels ?? [])].filter((m, i, a) => m && a.indexOf(m) === i)
  const results = []
  for (const model of models) {
    const t0 = Date.now()
    try {
      const res = await fetch(String(p.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.apiKey },
        body: JSON.stringify({
          model,
          max_tokens: 4,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(20000),
      })
      const body = await res.json().catch(() => null)
      results.push({
        model,
        status: res.status,
        ok: res.status === 200,
        ms: Date.now() - t0,
        detail: res.status === 200 ? 'ok' : String(body?.error?.message ?? '').slice(0, 120),
      })
    } catch (e) {
      results.push({ model, status: 0, ok: false, ms: Date.now() - t0, detail: String(e && e.message) })
    }
  }
  const serving = results.find((r) => r.ok) || null
  return {
    // Keep the old shape for the existing renderer: the primary's own result.
    model: primary,
    status: results[0] ? results[0].status : 0,
    ok: !!(results[0] && results[0].ok),
    ms: results[0] ? results[0].ms : 0,
    detail: results[0] ? results[0].detail : 'no provider',
    // The new, useful part.
    serving: serving ? serving.model : null,
    degraded: !!(serving && serving.model !== primary),
    models: results,
  }
}
