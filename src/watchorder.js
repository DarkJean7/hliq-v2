// Drag to reorder: the watch cards. Asked: "make the watch cards be able to change order".
//
// One mechanism for every list of watched markets: the home strip (horizontal), the Watch tab
// rows and the desktop watch table (vertical). It knows nothing about watchlists — a list is a
// container, an item selector and a key per item; what the new order MEANS is the caller's.
//
// How a drag starts:
//   - on a `handle` (the ⋮⋮ grip): at once, finger or mouse. A grip is there to be dragged.
//   - anywhere else on an item: after holding still for `holdMs`. Moving first is a scroll,
//     and stays one — the strip scrolls sideways and the Watch tab scrolls down, and both are
//     the thing the finger is usually doing.
// Touch is handled with touch events rather than pointer events on purpose: once the browser
// has decided a touch is a scroll it cancels the pointer, and `touch-action` cannot be changed
// mid-gesture. A non-passive touchmove that calls preventDefault can stop it, so that is what
// holds the page still while a card is being carried.
//
// Items only trade places with items of the same `group` — coins with coins, TradingView
// markets with TradingView markets — because those are two lists, and the strip always shows
// the coins first. A card cannot be dropped somewhere it would not stay.

/**
 * The saved list in the order the screen now shows. Keys the screen did not know about (added
 * on another tab since it was drawn) keep their place at the end; keys the list no longer has
 * (removed meanwhile) are dropped, never resurrected.
 */
export function applyOrder(list, keys) {
  if (!Array.isArray(list)) return list
  const have = new Set(list)
  const seen = new Set()
  const out = []
  for (const k of keys ?? []) if (have.has(k) && !seen.has(k)) { seen.add(k); out.push(k) }
  for (const k of list) if (!seen.has(k)) out.push(k)
  return out
}

const HOLD_MS = 300
const SLOP = 8          // px a finger may wander during the hold before it counts as a scroll
const EDGE = 44         // px from the scroller's edge where carrying a card scrolls it

function scrollerOf(el, axis) {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const cs = getComputedStyle(n)
    const ov = axis === 'x' ? cs.overflowX : cs.overflowY
    const room = axis === 'x' ? n.scrollWidth > n.clientWidth + 4 : n.scrollHeight > n.clientHeight + 4
    if (room && /(auto|scroll)/.test(ov)) return n
  }
  return document.scrollingElement
}

/**
 * @param {HTMLElement} container  stays in the DOM; items inside it may be re-rendered freely
 * @param {{ item: string, axis?: 'x'|'y', key: (el) => string, group?: (el) => string,
 *           handle?: string, ignore?: string, holdMs?: number, onOrder: (keys, group) => void }} o
 */
export function enableReorder(container, o) {
  if (!container || container._reorder) return
  container._reorder = true
  const axis = o.axis ?? 'y'
  const holdMs = o.holdMs ?? HOLD_MS
  const groupOf = o.group ?? (() => '')
  const pos = (p) => axis === 'x' ? p.clientX : p.clientY

  let cand = null      // { el, x, y, timer, mouse } — pressed, not yet lifted
  let drag = null      // { el, grab, last, off, scroller, raf, moved }

  const peers = (el) => [...container.querySelectorAll(o.item)].filter(n => groupOf(n) === groupOf(el))
  const edge = (el) => { const b = el.getBoundingClientRect(); return axis === 'x' ? b.left : b.top }

  function begin(el, p) {
    cand = null
    // Where on the card the finger took hold. Everything after is measured from the card's
    // real place on screen, never from offsetTop or a scroll delta: those are relative to
    // whatever offsetParent and scroller the card happens to sit in, and in the desktop table
    // they disagreed by hundreds of pixels — the card flew off the screen while it was being
    // carried ("is becoming invisible when dragging").
    drag = { el, grab: pos(p) - edge(el), last: pos(p), off: 0, scroller: scrollerOf(el, axis), moved: false }
    el.classList.add('wo-lifted')
    container.classList.add('wo-active')
    try { navigator.vibrate?.(12) } catch {}
    const tick = () => {
      if (!drag) return
      const r = drag.scroller === document.scrollingElement
        ? { lo: 0, hi: axis === 'x' ? innerWidth : innerHeight }
        : (() => { const b = drag.scroller.getBoundingClientRect(); return axis === 'x' ? { lo: b.left, hi: b.right } : { lo: b.top, hi: b.bottom } })()
      const v = drag.last < r.lo + EDGE ? -8 : drag.last > r.hi - EDGE ? 8 : 0
      if (v) { if (axis === 'x') drag.scroller.scrollLeft += v; else drag.scroller.scrollTop += v }
      // Every frame, not only after our own scroll: a strip still coasting from the swipe
      // before the hold, or snapping, moves the cards under a finger that has not moved, and
      // the carried card drifted away from it.
      follow()
      drag.raf = requestAnimationFrame(tick)
    }
    // Stop a coasting scroll where it is — assigning the position ends the fling.
    if (axis === 'x') drag.scroller.scrollLeft = drag.scroller.scrollLeft; else drag.scroller.scrollTop = drag.scroller.scrollTop
    drag.raf = requestAnimationFrame(tick)
  }

  // Keep the lifted card under the finger, and move it past any neighbour whose middle the
  // finger has crossed. Its place in the DOM changes as it goes, so the others close up behind
  // it for free; the transform only makes up the difference to where the finger is.
  function follow() {
    const { el } = drag
    const list = peers(el)
    let i = list.indexOf(el)
    for (;;) {
      const next = list[i + 1], prev = list[i - 1]
      const mid = (n) => { const b = n.getBoundingClientRect(); return axis === 'x' ? b.left + b.width / 2 : b.top + b.height / 2 }
      if (next && drag.last > mid(next)) { next.after(el); list.splice(i, 1); list.splice(i + 1, 0, el); i++; drag.moved = true; continue }
      if (prev && drag.last < mid(prev)) { prev.before(el); list.splice(i, 1); list.splice(i - 1, 0, el); i--; drag.moved = true; continue }
      break
    }
    // Untransformed place = where it is drawn minus the shift already applied; the new shift
    // puts the point it was grabbed by back under the finger.
    const home = edge(el) - drag.off
    drag.off = drag.last - drag.grab - home
    el.style.transform = axis === 'x' ? `translate3d(${drag.off}px,0,0)` : `translate3d(0,${drag.off}px,0)`
  }

  function end() {
    if (cand) { clearTimeout(cand.timer); cand = null }
    if (!drag) return false
    const { el } = drag
    cancelAnimationFrame(drag.raf)
    el.style.transform = ''
    el.classList.remove('wo-lifted')
    container.classList.remove('wo-active')
    drag = null
    // A long press that let go was not a tap either — swallow the click it is about to send,
    // or a card picked up and put back down would also open its market.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400)
    const keys = peers(el).map(o.key)
    o.onOrder(keys, groupOf(el))
    return true
  }

  function press(target, p, mouse = false) {
    const el = target.closest?.(o.item)
    if (!el || !container.contains(el)) return
    if (o.ignore && target.closest(o.ignore) && !(o.handle && target.closest(o.handle))) return
    if (o.handle && target.closest(o.handle)) { begin(el, p); return true }
    cand = { el, x: p.clientX, y: p.clientY, mouse, timer: setTimeout(() => {
      if (!cand) return
      // Only lift what is still under the finger. A strip still coasting from the swipe
      // before can carry the card a whole slot away during the hold; lifting it then left it
      // a card's width from the finger for the whole drag.
      const b = cand.el.getBoundingClientRect()
      if (cand.x < b.left || cand.x > b.right || cand.y < b.top || cand.y > b.bottom) { cand = null; return }
      begin(cand.el, { clientX: cand.x, clientY: cand.y })
    }, holdMs) }
    return false
  }

  // ── touch ──
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { end(); return }
    press(e.target, e.touches[0])
  }, { passive: true })
  container.addEventListener('touchmove', (e) => {
    const t = e.touches[0]
    if (cand && (Math.abs(t.clientX - cand.x) > SLOP || Math.abs(t.clientY - cand.y) > SLOP)) { clearTimeout(cand.timer); cand = null }
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()       // not a sparkline scrub, not a page swipe
    drag.last = pos(t)
    follow()
  }, { passive: false })
  const touchUp = (e) => { if (end()) e.stopPropagation() }
  container.addEventListener('touchend', touchUp)
  container.addEventListener('touchcancel', touchUp)
  // iOS and Android both offer a menu on a long press; the hold is ours.
  container.addEventListener('contextmenu', (e) => { if (cand || drag) e.preventDefault() })

  // ── mouse ──
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (press(e.target, e, true)) e.preventDefault()   // no text selection while dragging a grip
    const move = (ev) => {
      // A mouse has no page to scroll by dragging, so the whole row is a handle: press
      // anywhere on it and move, and it is carried. A click that does not move still opens.
      if (cand?.mouse && (Math.abs(ev.clientX - cand.x) > SLOP || Math.abs(ev.clientY - cand.y) > SLOP)) {
        clearTimeout(cand.timer); const c = cand; begin(c.el, { clientX: c.x, clientY: c.y })
      }
      if (!drag) return
      ev.preventDefault()
      drag.last = pos(ev)
      follow()
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); end() }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
}
