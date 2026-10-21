/**
 * The Outcomes tab's expiry countdowns, ticking without stalling the page.
 *
 * Reported: "the outcomes tab is also stuttering". The scroll-jank telemetry (src/scrolljank.js)
 * named it: a one-second setInterval taking ~190ms, and 12,218 nodes rewritten in a four-second
 * scroll, every one of them in oc-cd-* / oc-compact-cd-*. The old tick looked up and rewrote the
 * countdown of EVERY outcome market — over a thousand, nearly all of them off screen — and
 * replaced its text node and class each second whether anything had changed or not.
 *
 * Now: only countdowns on screen are touched (an IntersectionObserver says which), a countdown
 * is written only when its text changes, and the change is made to the existing text node rather
 * than by replacing it. A countdown scrolled into view is brought up to date the moment it
 * appears, so nothing is ever seen stale.
 */

export function fmtCountdown(ms) {
  if (ms <= 0) return 'Expired'
  const s   = Math.floor(ms / 1000)
  const d   = Math.floor(s / 86400)
  const h   = Math.floor((s % 86400) / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  return `${m}m ${sec}s`
}

const URGENT_MS = 3_600_000

/** Change an element's text in place when it holds a single text node; no node is replaced. */
function setText(el, text) {
  const n = el.firstChild
  if (n && n.nodeType === 3 && !n.nextSibling) { if (n.data !== text) n.data = text }
  else el.textContent = text
}

export function createCountdowns({ doc = globalThis.document, now = () => Date.now(), IO = globalThis.IntersectionObserver,
  setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (h) => clearInterval(h) } = {}) {
  let entries = new Map()     // id -> { expiry, el, cEl, text, urgent }
  const seen = new Set()      // elements currently on screen
  let timer = null

  const idOf = (el) => String(el.id).replace(/^oc-(compact-)?cd-/, '')
  const io = IO ? new IO((es) => {
    for (const e of es) {
      if (e.isIntersecting) { seen.add(e.target); const en = entries.get(idOf(e.target)); if (en) paint(en, now()) }
      else seen.delete(e.target)
    }
  }) : null

  // Find (again) an entry's elements: a redraw replaces them, and a replaced one is not connected.
  const resolve = (id, en) => {
    if (!en.el?.isConnected) {
      if (en.el) { io?.unobserve(en.el); seen.delete(en.el) }
      en.el = doc.getElementById('oc-cd-' + id); en.text = null; en.urgent = null
      if (en.el) io?.observe(en.el)
    }
    if (!en.cEl?.isConnected) {
      if (en.cEl) { io?.unobserve(en.cEl); seen.delete(en.cEl) }
      en.cEl = doc.getElementById('oc-compact-cd-' + id); en.cText = null
      if (en.cEl) io?.observe(en.cEl)
    }
  }

  const paint = (en, t) => {
    const remaining = en.expiry ? en.expiry.getTime() - t : null
    const text = remaining == null ? '—' : fmtCountdown(remaining)
    if (en.el && text !== en.text) { setText(en.el, text); en.text = text }
    const urgent = remaining != null && remaining < URGENT_MS
    if (en.el && urgent !== en.urgent) { en.el.classList.toggle('oc-countdown--urgent', urgent); en.urgent = urgent }
    if (en.cEl && text !== en.cText) { setText(en.cEl, text); en.cText = text }
  }

  const tick = () => {
    const t = now()
    for (const [id, en] of entries) {
      resolve(id, en)
      // Without an IntersectionObserver every countdown counts as visible, as before.
      if (io && !(en.el && seen.has(en.el)) && !(en.cEl && seen.has(en.cEl))) continue
      paint(en, t)
    }
  }

  return {
    start(expiryMap) {
      this.stop()
      entries = new Map(Object.entries(expiryMap ?? {}).map(([id, expiry]) => [String(id), { expiry, el: null, cEl: null, text: null, cText: null, urgent: null }]))
      // First paint of everything once, so an off-screen countdown is not left saying "—".
      const t = now()
      for (const [id, en] of entries) { resolve(id, en); paint(en, t) }
      timer = setTimer(tick, 1000)
    },
    stop() {
      if (timer != null) { clearTimer(timer); timer = null }
      io?.disconnect(); seen.clear()
      entries = new Map()
    },
    tick,
    /** For tests: how many entries the last tick would touch. */
    visibleCount() { let n = 0; for (const en of entries.values()) if (!io || (en.el && seen.has(en.el)) || (en.cEl && seen.has(en.cEl))) n++; return n },
  }
}
