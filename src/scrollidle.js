/**
 * Hold a repaint while the person is scrolling; run it when they stop.
 *
 * Reported: "currently when scrolling down for example its kinda buggy" / "it stutters". The
 * scroll-jank telemetry (src/scrolljank.js) settled it from the user's own browser: frames drew in
 * 6ms, and the stutter was JavaScript — 88 to 885ms tasks with ~1,100 nodes rewritten in a two-
 * second scroll. All Accounts repaints on every live push from any wallet, coalesced to one per
 * 500ms, and on desktop that repaint rebuilds the whole Overview and every wallet card from
 * scratch. Ten wallets pushing prices means one of those rebuilds lands in nearly every scroll.
 *
 * The data keeps updating; only putting it on screen waits, and only while a scroll is actually
 * moving. A quarter second after the last scroll event the latest paint runs once — repeated
 * requests for the same key collapse into it, so nothing is painted twice for one pause.
 */
export const SCROLL_IDLE_MS = 250

export function createScrollIdle({ now = () => performance.now(), setTimer = setTimeout, idleMs = SCROLL_IDLE_MS } = {}) {
  let lastScroll = -Infinity
  const pending = new Map()   // key -> fn (latest wins)
  let timer = null

  const flush = () => {
    timer = null
    const wait = lastScroll + idleMs - now()
    if (wait > 0) { timer = setTimer(flush, wait); return }
    const fns = [...pending.values()]
    pending.clear()
    for (const fn of fns) { try { fn() } catch {} }
  }

  return {
    /** Call from a scroll listener. */
    noteScroll() { lastScroll = now() },
    /** True while a scroll moved within the last idleMs. */
    scrolling() { return now() - lastScroll < idleMs },
    /** Run `fn` now if nobody is scrolling, else once when they stop. Same key = latest only. */
    run(key, fn) {
      if (!(now() - lastScroll < idleMs) && !pending.size) { fn(); return true }
      pending.set(key, fn)
      if (!timer) timer = setTimer(flush, Math.max(0, lastScroll + idleMs - now()))
      return false
    },
  }
}

/** The app's one instance, fed by a passive capture listener so every scroller counts. */
export const scrollIdle = createScrollIdle()
if (typeof window !== 'undefined') {
  try { addEventListener('scroll', () => scrollIdle.noteScroll(), { capture: true, passive: true }) } catch {}
}
