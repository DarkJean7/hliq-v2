/**
 * Scroll jank, measured on the device that has it.
 *
 * Reported: "lets make the app be more smoother, currently when scrolling down for example its
 * kinda buggy" — desktop, the new interface, a wallpaper set. Measured headless
 * (tests/scrollperf.mjs) it did not reproduce: every thread under 20ms of work per second of
 * scrolling, live data or fixture. The two real costs it did find — the wallpaper blur behind
 * every card (6× the compositor's work when drawing in software) and the positions table
 * being a scroll box inside the scrolling page — may or may not be what is felt. A headless
 * browser is not that machine, so this asks the machine.
 *
 * A scroll SESSION runs from the first scroll event to 400ms after the last. During it a
 * requestAnimationFrame loop records frame gaps — in a real, visible browser rAF does wait for
 * the frame, so a gap is a dropped frame — and a long-task observer records what blocked the
 * page. A session with real stalls is reported once, throttled, with what was scrolling and
 * whether the GPU is drawing at all.
 */

/** Summarise one session's frame gaps (ms). Pure, so the suite can check it. */
export function summarise(gaps) {
  const d = [...gaps].filter(Number.isFinite).sort((a, b) => a - b)
  if (!d.length) return { frames: 0, p50: 0, p95: 0, worst: 0, long: 0, janky: false }
  const q = (x) => d[Math.min(d.length - 1, Math.floor(d.length * x))]
  const long = d.filter(x => x > 50).length
  // Janky: at least three frames over 50ms, or a p95 worse than two frames at 60Hz. One stall
  // is a GC or a tab switch; three in one scroll is something a person notices.
  return { frames: d.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), worst: Math.round(d.at(-1)), long, janky: long >= 3 || (d.length >= 10 && q(0.95) > 34) }
}

/** What an element is, briefly: tag#id.firstClass. */
export function describe(el) {
  if (!el || el === document || el === document.scrollingElement) return 'page'
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
  return (el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')
}

/** Who draws: the GPU's own name, or a software renderer (SwiftShader, Basic Render Driver). */
function renderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? 'webgl (masked)' : 'no webgl'
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return String(r).slice(0, 120)
  } catch { return 'unknown' }
}

export function installScrollJank({ report, minGapMs = 5 * 60_000, maxReports = 6 } = {}) {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return
  let session = null, sent = 0, lastSent = 0, gpu = null
  const tasks = []
  try {
    new PerformanceObserver((l) => {
      if (!session) return
      for (const e of l.getEntries()) {
        const a = e.attribution?.[0]
        tasks.push(Math.round(e.duration) + 'ms' + (a?.containerName || a?.containerSrc ? ' in ' + (a.containerName || a.containerSrc) : ''))
      }
    }).observe({ type: 'longtask', buffered: false })
  } catch {}
  let mutations = 0
  try { new MutationObserver((ms) => { if (session) for (const m of ms) mutations += m.addedNodes.length + m.removedNodes.length }).observe(document.body, { childList: true, subtree: true }) } catch {}

  const end = () => {
    const s = session; session = null
    if (!s || document.hidden) return
    const sum = summarise(s.gaps)
    const now = Date.now()
    if (!sum.janky || sent >= maxReports || now - lastSent < minGapMs) return
    sent++; lastSent = now
    if (gpu == null) gpu = renderer()
    const html = document.documentElement
    try {
      report({
        message: `scroll jank · ${s.where} · ${sum.long} frames over 50ms, p95 ${sum.p95}ms, worst ${sum.worst}ms`,
        stack: [
          `frames=${sum.frames} p50=${sum.p50} p95=${sum.p95} worst=${sum.worst} secs=${((s.last - s.start) / 1000).toFixed(1)}`,
          `scrolled=${[...s.scrolled].join(',')}`,
          `longtasks=${tasks.splice(0).slice(0, 8).join(',') || 'none'}`,
          `nodesRewritten=${mutations}`,
          `ui=${html.classList.contains('ui-nova') ? 'nova' : 'classic'} wallpaper=${html.classList.contains('has-bg-image') ? 1 : 0} dimmed=${html.classList.contains('ui-dimmed') ? 1 : 0}`,
          `viewport=${innerWidth}x${innerHeight}@${devicePixelRatio} gpu=${gpu}`,
        ].join(' | '),
      })
    } catch {}
  }

  const frame = (t) => {
    if (!session) return
    if (session.prev) session.gaps.push(t - session.prev)
    session.prev = t
    if (performance.now() - session.last > 400) { end(); return }
    requestAnimationFrame(frame)
  }

  addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target
    const t = performance.now()
    if (!session) {
      session = { start: t, last: t, prev: 0, gaps: [], scrolled: new Set(), where: describe(el) }
      mutations = 0; tasks.length = 0
      requestAnimationFrame(frame)
    }
    session.last = t
    if (session.scrolled.size < 4) session.scrolled.add(describe(el))
  }, { capture: true, passive: true })
}
