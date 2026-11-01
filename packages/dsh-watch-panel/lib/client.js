// dsh-watch-panel — browser half.
//
// Puts a small "看番" trigger into the conversation header corner, exactly like
// the power menu and coop-launch do: the slot (`shell.overlay`) is only a mount
// point, and the actual button is portalled into the element DSH marks with
// [data-conversation-header-corner]. That keeps it inside the header's own
// layout instead of floating over content.
//
// Clicking opens a panel. The panel itself is a body portal so it can extend
// past the header without being clipped by it.
window.__ModuleLoader__.load({
  id: 'dsh-watch-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement
    const reactDom = require('react-dom')

    const inject = ['slots']

    const BASE = '/dsh-watch'
    const ORDER = ['mouth', 'eyes', 'ears', 'browser', 'face', 'chrome']
    const NAMES = {
      mouth: '嘴 · 合成与播放',
      eyes: '眼 · 抓屏与视觉',
      ears: '耳 · 听觉与推送',
      browser: '手 · 浏览器',
      face: '脸 · 形象与气泡',
      chrome: 'Chrome · 隔离实例',
    }

    const CSS_ID = 'dsh-watch-panel-css'
    const CSS = [
      // trigger: sized to the header's own controls so it sits in the row
      '.dwp-trigger{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-secondary,#5f5f66);font:12px/1 "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;transition:background .14s ease,color .14s ease}',
      '.dwp-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dwp-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-accent,#4a8cff);outline-offset:1px}',
      '.dwp-dots{display:inline-flex;gap:2px}',
      '.dwp-dots i{width:5px;height:5px;border-radius:50%;background:#d9534f;display:block}',
      '.dwp-dots i.on{background:#3ddc84}',
      // panel: floats under the trigger
      '.dwp-panel{position:fixed;z-index:2147482000;width:344px;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));box-shadow:0 14px 40px rgba(0,0,0,.28);font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;max-height:74vh;overflow-y:auto}',
      '.dwp-head{display:flex;align-items:center;padding:10px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.dwp-head b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dwp-head .x{margin-left:auto;color:#8b93a3;cursor:pointer;padding:0 4px}',
      '.dwp-head .x:hover{color:var(--dsw-alias-label-primary,#1b1b20)}',
      '.dwp-sec{padding:10px 13px}',
      '.dwp-sec+.dwp-sec{border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.dwp-lbl{color:#8b93a3;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}',
      '.dwp-svc{display:flex;align-items:center;gap:8px;padding:4px 0}',
      '.dwp-svc .n{flex:1;color:var(--dsw-alias-label-primary,#333);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dwp-svc .p{color:#8b93a3;font-size:11px}',
      '.dwp-sw{padding:3px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:transparent;color:var(--dsw-alias-label-primary,#333);cursor:pointer;font-size:11.5px}',
      '.dwp-sw:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dwp-sw.danger{color:#d9534f}',
      '.dwp-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.dwp-grid button{padding:7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:transparent;color:var(--dsw-alias-label-primary,#333);cursor:pointer;font-size:12.5px}',
      '.dwp-grid button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dwp-grid button.primary{background:#4a8cff;border-color:#4a8cff;color:#fff}',
      '.dwp-grid button.danger{color:#d9534f}',
      '.dwp-say{display:flex;gap:6px}',
      '.dwp-say input{flex:1;padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#333);font-size:12.5px;outline:none}',
      '.dwp-say input:focus{border-color:#4a8cff}',
      '.dwp-say button{padding:6px 12px;border-radius:7px;border:1px solid #4a8cff;background:#4a8cff;color:#fff;cursor:pointer;font-size:12.5px}',
      '.dwp-out{margin:0;padding:8px 13px;max-height:140px;overflow-y:auto;background:rgba(0,0,0,.03);color:#6d7686;font-size:11.5px;white-space:pre-wrap;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));font-family:Consolas,monospace}',
      '.dwp-out:empty{display:none}',
      // Press feedback. A click must feel acknowledged even when the request takes
      // seconds: :active sinks the control and dims it, and the transition makes
      // the press and the release both visible.
      '.dwp-grid button,.dwp-say button,.dwp-sw,.dwp-trigger{transition:transform .09s ease,opacity .12s ease,background .14s ease,color .14s ease}',
      '.dwp-grid button:active,.dwp-say button:active,.dwp-sw:active,.dwp-trigger:active{transform:translateY(1px) scale(.97);opacity:.72}',
      '.dwp-grid button:disabled:active,.dwp-say button:disabled:active,.dwp-sw:disabled:active{transform:none;opacity:1}',
      // A busy control keeps a subtle pulse so "working" is distinguishable from
      // "not responding" during the multi-second calls.
      '@keyframes dwp-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.dwp-grid button:disabled{animation:dwp-pulse 1.1s ease-in-out infinite;cursor:progress}',
      // The hint line under each section. This class was referenced by the JSX from
      // the start but never defined, so every hint rendered as unstyled body text.
      '.dwp-hint{color:#8b93a3;font-size:11px;margin-top:6px;line-height:1.45}',
      // The flow list: one row per step, state carried by the marker on the left.
      '.dwp-flow{margin:0;padding:0;list-style:none}',
      '.dwp-flow li{display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:12px;line-height:1.45;color:#8b93a3}',
      '.dwp-flow li .m{flex:none;width:14px;text-align:center;font-weight:700}',
      '.dwp-flow li.done{color:var(--dsw-alias-label-primary,#333)}',
      '.dwp-flow li.done .m{color:#3ddc84}',
      '.dwp-flow li.now{color:var(--dsw-alias-label-primary,#333)}',
      '.dwp-flow li.now .m{color:#4a8cff}',
      '.dwp-flow li .t{flex:1}',
      '.dwp-flow li .sub{display:block;color:#8b93a3;font-size:11px;margin-top:1px}',
      '.dwp-flow-tip{margin-top:9px;padding:8px 10px;border-radius:7px;background:rgba(74,140,255,.10);color:var(--dsw-alias-label-primary,#333);font-size:11.5px;line-height:1.55}',
    ].join('')

    function ensureCss() {
      if (document.getElementById(CSS_ID)) return
      const style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, ms) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), ms || 120000)
      try {
        const res = await fetch(BASE + path, { signal: ctrl.signal })
        return await res.json().catch(() => ({ ok: false, error: 'bad json' }))
      } finally {
        clearTimeout(timer)
      }
    }

    function stamp() {
      return new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }

    function Panel(props) {
      const { onClose, anchorRect } = props
      const [status, setStatus] = react.useState({})
      const [out, setOut] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [sayText, setSayText] = react.useState('')
      // Which subject the user picked. Mirrored to the host so a reload remembers it;
      // the actual pusher mode is set by the session, which the panel cannot do.
      const [mode, setMode] = react.useState('video')
      // Which speech backend the ears are actually using right now: 'local' when
      // the GPU is free, 'cloud-sf' while gaming. Read from the daemon, not guessed.
      const [asr, setAsr] = react.useState('local')
      // How talkative she is: quiet / normal / chatty. Owned by the ears daemon.
      const [pace, setPaceState] = react.useState('normal')
      const boxRef = react.useRef(null)

      const push = react.useCallback(function (line) {
        setOut(function (prev) {
          const next = stamp() + '  ' + line + '\n' + prev
          return next.length > 6000 ? next.slice(0, 4000) : next
        })
      }, [])

      const refresh = react.useCallback(async function () {
        try {
          const st = await api('/status', 8000)
          setStatus(st || {})
        } catch (e) { /* daemon down: dots stay red */ }
        // The backend is owned by the ears daemon, so read it rather than assume:
        // a manual CLI switch outside the panel must show up here too.
        try {
          const b = await api('/asr', 8000)
          if (b && b.current) setAsr(b.current)
        } catch (e) { /* keep the last known value */ }
        // The pace is owned by the ears daemon too, so read it rather than cache it.
        try {
          const p = await api('/pace', 8000)
          if (p && p.tuning && p.tuning.pace) setPaceState(p.tuning.pace)
        } catch (e) { /* keep the last known value */ }
      }, [])

      react.useEffect(function () {
        refresh()
        const timer = setInterval(refresh, 8000)
        return function () { clearInterval(timer) }
      }, [refresh])

      // close on outside click and on Escape, like a real popover
      react.useEffect(function () {
        function onDown(ev) {
          if (boxRef.current && !boxRef.current.contains(ev.target) && !ev.target.closest('[data-dwp-trigger]')) onClose()
        }
        function onKey(ev) { if (ev.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [onClose])

      // The panel cannot start a pusher (only a session can spawn the subagent
      // that receives pushes), so picking a mode here records the choice and
      // prints the exact sentence to say in the conversation. Showing a promise
      // the panel cannot keep would be worse than showing the instruction.
      // Speaking frequency. Live like gaming mode: the pusher picks the new value
      // up on its next poll (~2s), so no restart and no re-spawn.
      const setPace = async function (p) {
        if (busy) return
        const before = pace
        setPaceState(p)
        try {
          const j = await api('/pace?set=' + p, 15000)
          if (j && j.tuning && j.tuning.pace) setPaceState(j.tuning.pace)
          push('频率: ' + { quiet: '安静', normal: '正常', chatty: '话多' }[p])
        } catch (e) {
          setPaceState(before)
          push('✗ ' + e.message)
        }
      }

      // Gaming mode really is a switch, not a note: the ears daemon changes
      // backend at runtime, so this call has an immediate audible effect.
      const toggleGaming = async function () {
        if (busy) return
        const want = asr === 'cloud-sf' ? 'local' : 'cloud-sf'
        setBusy(true)
        push(want === 'cloud-sf' ? '游戏模式：切到云端（不占显存）' : '切回本地 whisper')
        try {
          const j = await api('/asr?set=' + want, 20000)
          if (j && j.current) setAsr(j.current)
          push((j && j.ok ? '✓ ' : '✗ ') + '后端 ' + (j && j.current))
        } catch (e) { push('✗ ' + e.message) }
        setBusy(false)
      }

      const pickMode = async function (m) {
        setMode(m)
        try {
          const j = await api('/mode?set=' + m, 8000)
          if (j && j.mode) setMode(j.mode)
          push('模式已设为 ' + (m === 'screen' ? '看屏幕' : '看番') + (j && j.hint ? '：' + j.hint : ''))
        } catch (e) {
          push('模式: ' + m + '（本地记录）')
        }
      }

      const actSvc = async function (svc, act) {
        if (busy) return
        setBusy(true)
        push(act + ' ' + svc + ' …')
        try {
          const j = await api('/svc?svc=' + svc + '&act=' + act, 120000)
          push((j.ok ? '✓ ' : '✗ ') + (j.action || '') + (j.out ? '\n' + String(j.out).trim().slice(0, 260) : ''))
        } catch (e) { push('✗ ' + e.message) }
        setBusy(false)
        setTimeout(refresh, 500)
      }

      const actAll = async function (act) {
        if (busy) return
        setBusy(true)
        push((act === 'start' ? '全部启动' : '全部停止') + ' …')
        try {
          const j = await api('/all?act=' + act, 300000)
          push((j.lines || []).join('\n'))
        } catch (e) { push('✗ ' + e.message) }
        setBusy(false)
        setTimeout(refresh, 800)
      }

      const actWatch = async function (a) {
        if (busy) return
        setBusy(true)
        push('看番: ' + a + ' …')
        try {
          const j = await api('/watch?act=' + a, 180000)
          push((j.ok ? '✓ ' : '✗ ') + a + (j.out ? '\n' + String(j.out).trim().slice(0, 360) : ''))
        } catch (e) { push('✗ ' + e.message) }
        setBusy(false)
        setTimeout(refresh, 500)
      }

      const say = async function () {
        const text = sayText.trim()
        if (!text || busy) return
        setSayText('')
        setBusy(true)
        push('说: ' + text)
        try {
          const j = await api('/watch?act=say&text=' + encodeURIComponent(text), 60000)
          push((j.ok ? '✓' : '✗') + (j.out ? '\n' + String(j.out).trim().slice(0, 180) : ''))
        } catch (e) { push('✗ ' + e.message) }
        setBusy(false)
      }

      // Anchor under the trigger, but keep it on screen: a fixed width of 344px
      // pinned to the trigger's right edge overflows on narrow windows.
      const style = {}
      if (anchorRect) {
        const width = 344
        const left = Math.max(8, Math.min(anchorRect.right - width, window.innerWidth - width - 8))
        style.left = left + 'px'
        const below = anchorRect.bottom + 8
        style.top = (below + 380 < window.innerHeight ? below : Math.max(8, anchorRect.top - 380)) + 'px'
      }

      const svcRows = ORDER.map(function (k) {
        const s = status[k] || {}
        return h('div', { className: 'dwp-svc', key: k },
          h('span', { className: 'dwp-dots' }, h('i', { className: s.up ? 'on' : '' })),
          h('span', { className: 'n' }, s.label || NAMES[k]),
          h('span', { className: 'p' }, s.up ? s.ms + 'ms' : '停'),
          h('button', {
            className: 'dwp-sw' + (s.up ? ' danger' : ''),
            disabled: busy,
            onClick: function () { actSvc(k, s.up ? 'stop' : 'start') },
          }, s.up ? '停' : '启')
        )
      })

      // The flow, derived from the live snapshot rather than stored: the panel can
      // see whether the services are up and whether the ears are listening, so it
      // knows which step is done and which is next. The one step it cannot do (and
      // cannot observe) is arming the pusher - that needs a session.
      const up = function (k) { return !!(status[k] && status[k].up) }
      const allUp = up('eyes') && up('ears') && up('mouth')
      const listening = !!(status.ears && status.ears.detail && status.ears.detail.listening)
      const steps = [
        { key: 'svc', done: allUp, text: '服务全起来', sub: allUp ? '眼、耳、嘴都在跑' : '点下面的「全部启动」' },
        { key: 'arm', done: listening, text: '挂起待机', sub: listening ? '麦克风在听，画面在等' : '点「挂起待机」，关弹幕、开麦克风' },
        { key: 'push', done: false, text: '在对话里说一句', sub: '「陪我看番」或「一起看屏幕」——分身必须由会话起' },
        { key: 'play', done: false, text: '说开播，或点「播放」', sub: mode === 'screen' ? '看屏幕不用播放，直接盯窗口' : '只在你想开始的时候' },
      ]
      const firstOpen = steps.findIndex(function (s) { return !s.done })
      const flowRows = steps.map(function (s, i) {
        const cls = s.done ? 'done' : (i === firstOpen ? 'now' : '')
        const mark = s.done ? '✓' : (i === firstOpen ? '▸' : '·')
        return h('li', { className: cls, key: s.key },
          h('span', { className: 'm' }, mark),
          h('span', { className: 't' }, s.text, h('span', { className: 'sub' }, s.sub))
        )
      })

      return h('div', { className: 'dwp-panel', style: style, ref: boxRef },
        h('div', { className: 'dwp-head' },
          h('b', null, mode === 'screen' ? '一起看屏幕' : '一起看番'),
          h('span', { className: 'x', title: '关闭', onClick: onClose }, '✕')
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '流程'),
          h('ul', { className: 'dwp-flow' }, flowRows),
          h('div', { className: 'dwp-flow-tip' },
            firstOpen < 0
              ? '齐了，去对话里说「开始吧」。'
              : (steps[firstOpen].key === 'push'
                ? '下一步只能在对话里做：分身是会话的子代理，面板起不了。'
                : steps[firstOpen].sub))
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '服务'),
          svcRows,
          h('div', { className: 'dwp-grid', style: { marginTop: '8px' } },
            h('button', { className: 'primary', disabled: busy, onClick: function () { actAll('start') } }, '全部启动'),
            h('button', { className: 'danger', disabled: busy, onClick: function () { actAll('stop') } }, '全部停止')
          )
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '模式'),
          h('div', { className: 'dwp-grid' },
            h('button', {
              className: mode === 'video' ? 'primary' : '',
              disabled: busy,
              onClick: function () { pickMode('video') },
            }, '看番'),
            h('button', {
              className: mode === 'screen' ? 'primary' : '',
              disabled: busy,
              onClick: function () { pickMode('screen') },
            }, '看屏幕')
          ),
          h('div', { className: 'dwp-hint' },
            mode === 'screen'
              ? '盯前台窗口、无字幕。直播、文档、游戏都算'
              : '读播放器字幕、追剧情。番剧、电影')
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '语音听写'),
          h('div', { className: 'dwp-grid' },
            h('button', {
              className: asr === 'local' ? 'primary' : '',
              disabled: busy,
              onClick: function () { toggleGaming() },
            }, asr === 'cloud-sf' ? '游戏模式 · 开' : '本地 whisper'),
            h('button', {
              className: asr === 'cloud-sf' ? 'primary' : '',
              disabled: busy,
              onClick: function () { toggleGaming() },
            }, '游戏模式')
          ),
          h('div', { className: 'dwp-hint' },
            asr === 'cloud-sf'
              ? '云端 Qwen3-ASR，约 400ms，不占显存（约 0.8 元/时）'
              : '本地 whisper，约 90ms，免费，打游戏时会让显卡忙')
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '说话频率'),
          h('div', { className: 'dwp-grid' },
            ['quiet', 'normal', 'chatty'].map(function (p) {
              return h('button', {
                key: p,
                className: pace === p ? 'primary' : '',
                disabled: busy,
                onClick: function () { setPace(p) },
              }, { quiet: '安静', normal: '正常', chatty: '话多' }[p])
            })
          ),
          h('div', { className: 'dwp-hint' },
            pace === 'quiet'
              ? '很少开口：常规 120 秒、显著 60 秒、合并 18 秒'
              : pace === 'chatty'
                ? '几乎都接：常规 20 秒、显著 12 秒、合并 6 秒'
                : '常规 45 秒、显著 25 秒、合并 12 秒')
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, mode === 'screen' ? '看屏幕' : '看番'),
          h('div', { className: 'dwp-grid' },
            h('button', { className: 'primary', disabled: busy, onClick: function () { actWatch('arm') } }, '挂起待机'),
            h('button', { className: 'primary', disabled: busy, onClick: function () { actWatch('play') } }, '播放'),
            h('button', { disabled: busy, onClick: function () { actWatch('pause') } }, '暂停'),
            h('button', { disabled: busy, onClick: function () { actWatch('check') } }, '体检'),
            h('button', { className: 'danger', disabled: busy, style: { gridColumn: '1/3' }, onClick: function () { actWatch('off') } }, '收工')
          )
        ),
        h('div', { className: 'dwp-sec' },
          h('div', { className: 'dwp-lbl' }, '让她说话'),
          h('div', { className: 'dwp-say' },
            h('input', {
              value: sayText,
              placeholder: '说点什么…',
              onChange: function (e) { setSayText(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); say() } },
            }),
            h('button', { disabled: busy, onClick: say }, '说')
          )
        ),
        h('pre', { className: 'dwp-out' }, out)
      )
    }

    // Trigger: a small header button with five status dots.
    function Trigger() {
      const [open, setOpen] = react.useState(false)
      const [rect, setRect] = react.useState(null)
      const [status, setStatus] = react.useState({})
      const btnRef = react.useRef(null)

      react.useEffect(function () {
        let cancelled = false
        async function tick() {
          try {
            const st = await api('/status', 8000)
            if (!cancelled) setStatus(st || {})
          } catch (e) { /* keep last */ }
        }
        tick()
        const timer = setInterval(tick, 10000)
        return function () { cancelled = true; clearInterval(timer) }
      }, [])

      const dots = ORDER.map(function (k) {
        return h('i', { key: k, className: (status[k] && status[k].up) ? 'on' : '' })
      })

      const openPanel = function () {
        if (btnRef.current) setRect(btnRef.current.getBoundingClientRect())
        setOpen(true)
      }

      const portalTarget = typeof document !== 'undefined' ? document.body : null
      const panel = (open && portalTarget && reactDom.createPortal)
        ? reactDom.createPortal(h(Panel, { onClose: function () { setOpen(false) }, anchorRect: rect }), portalTarget)
        : null

      return h(react.Fragment, null,
        h('button', {
          ref: btnRef,
          type: 'button',
          className: 'dwp-trigger',
          'data-dwp-trigger': '',
          title: '一起看番 · 控制台',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { if (open) setOpen(false); else openPanel() },
        },
          h('span', { className: 'dwp-dots' }, dots),
          h('span', null, '看番')
        ),
        panel
      )
    }

    // The slot is only a mount point: the button itself is portalled into the
    // header corner element, the same way the power menu does it.
    function HeaderSlot() {
      const [mount, setMount] = react.useState(null)

      react.useLayoutEffect(function () {
        let node = null
        let observer = null
        let cancellation = null

        const ensure = function () {
          const corner = document.querySelector('[data-conversation-header-corner]')
          if (corner === null) {
            if (node !== null) {
              node.remove()
              node = null
              setMount(null)
            }
            return
          }
          if (node === null) {
            node = document.createElement('span')
            node.setAttribute('data-dwp-mount', '')
            node.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;'
            setMount(node)
          }
          // Re-attach only when the corner dropped our node. Do NOT chase "last
          // child" here: dsh-power-menu also re-appends itself to the corner end
          // on every mutation, so two plugins both forcing themselves last
          // ping-pong forever through their MutationObservers and freeze the
          // renderer (100% CPU + runaway memory).
          if (node.parentElement !== corner) {
            corner.appendChild(node)
          }
        }

        ensure()
        observer = new MutationObserver(function () {
          // Cheap: only re-check on structural changes, not on every attribute.
          ensure()
        })
        observer.observe(document.body, { childList: true, subtree: true })
        const poll = setInterval(ensure, 1500)

        return function () {
          clearInterval(poll)
          if (observer) observer.disconnect()
          if (node !== null) node.remove()
        }
      }, [])

      if (mount === null) return null
      return reactDom.createPortal(h(Trigger), mount)
    }

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-watch-panel',
          order: 100,
          registrant: 'dsh-watch-panel',
        }, HeaderSlot)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
