// A horizontal strip a mouse can move.
//
// "is not letting me scroll the trending now cards": on desktop the Trending row overflowed with
// its scrollbar hidden, and a mouse wheel scrolls vertically — so with a mouse, only shift+wheel
// reached the cards past the fifth. This gives a strip the two things a mouse has:
//   - drag it sideways (a drag is not a click: the click that ends one is swallowed, or letting
//     go over a card would open that market);
//   - the wheel moves it sideways while it still can, then hands back to the page at either end,
//     so the strip never traps a reader who is scrolling past it.
// Touch is left alone: phones scroll it natively, and `data-dragscroll` covers iOS fixed overlays.

const DRAG_PX = 5   // movement before a press counts as a drag

/** Wheel delta → how far the strip moves, or 0 to leave it to the page. Pure, for the suite. */
export function wheelStep({ dx, dy, left, max }) {
  if (Math.abs(dx) > Math.abs(dy)) return 0        // a trackpad's sideways swipe: native already
  if (max <= 0) return 0                            // nothing to scroll
  if (dy > 0 && left >= max - 1) return 0           // at the right end: let the page go on
  if (dy < 0 && left <= 0) return 0                 // at the left end
  return dy
}

export function enableMouseScroll(el) {
  if (!el || el._mouseScroll) return
  el._mouseScroll = true
  let down = null, dragged = false

  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    down = { x: e.clientX, left: el.scrollLeft, id: e.pointerId }
    dragged = false
  })
  el.addEventListener('pointermove', e => {
    if (!down || e.pointerId !== down.id) return
    const dx = e.clientX - down.x
    if (!dragged && Math.abs(dx) < DRAG_PX) return
    if (!dragged) { dragged = true; try { el.setPointerCapture(down.id) } catch {} ; el.classList.add('dragx-on') }
    el.scrollLeft = down.left - dx
  })
  const up = () => { down = null; el.classList.remove('dragx-on') }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  // Capture phase: runs before the card's own onclick.
  el.addEventListener('click', e => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false } }, true)

  el.addEventListener('wheel', e => {
    const step = wheelStep({ dx: e.deltaX, dy: e.deltaY, left: el.scrollLeft, max: el.scrollWidth - el.clientWidth })
    if (!step) return
    e.preventDefault()
    el.scrollLeft += step
  }, { passive: false })
}
