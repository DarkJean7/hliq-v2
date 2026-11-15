// Work that can wait for the page to stop scrolling.
//
// "scrolling is still not very smooth" — the scroll-jank report from that session (desktop,
// 2026-11-15 19:03 UTC) had nothing on the page rewritten at all; its two big stalls (404 ms and
// 285 ms) were IndexedDB reads finishing: a wallet's whole saved trade history being decoded on
// the main thread, which happens once per wallet after a page load. Nothing about it is urgent
// to the millisecond, and decoding it mid-swipe is a frozen frame. So it waits for a pause.
//
// The wait is bounded: a page scrolled without a break still gets its data, just later.

let last = 0
if (typeof addEventListener === 'function') {
  // Capture, so a scroll inside any container counts, not only the window's.
  addEventListener('scroll', () => { last = Date.now() }, { passive: true, capture: true })
}

export const scrolledAgo = (now = Date.now()) => now - last

/** Resolves once nothing has scrolled for `quietMs`, or after `maxWaitMs` regardless. */
export function whenScrollIdle({ quietMs = 300, maxWaitMs = 6000, now = () => Date.now(), wait = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const t0 = now()
  const step = async () => {
    for (;;) {
      const since = now() - last
      if (since >= quietMs || now() - t0 >= maxWaitMs) return
      await wait(Math.max(16, quietMs - since))
    }
  }
  return step()
}

// For tests: pretend a scroll happened at `t`.
export const _markScroll = (t = Date.now()) => { last = t }
