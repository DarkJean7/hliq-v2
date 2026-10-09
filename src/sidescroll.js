/**
 * Sideways rows without a scrollbar, for the public pages (/markets, /portfolios): the mouse
 * wheel scrolls them, and so does dragging with the mouse. Touch already swipes natively, so
 * only a mouse pointer starts a drag. A drag that moved more than a few pixels swallows the
 * click it ends on — ask `wasDrag()` in the click handler — or letting go over a chip would
 * select it.
 *
 * `rowSel`: scroll the child row under the pointer instead of `el` itself — rows that are
 * rebuilt on every render are found at event time, not bound once.
 */
let dragged = false
export const wasDrag = () => dragged

export function sideScroll(el, rowSel = null) {
  if (!el) return
  const target = (t) => (rowSel ? t?.closest?.(rowSel) : el)
  el.addEventListener('wheel', e => {
    const sc = target(e.target)
    if (!sc || sc.scrollWidth <= sc.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
    sc.scrollLeft += e.deltaY
    e.preventDefault()
  }, { passive: false })
  let x0 = null, s0 = 0, sc = null
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    sc = target(e.target); if (!sc) return
    x0 = e.clientX; s0 = sc.scrollLeft; dragged = false
  })
  window.addEventListener('pointermove', e => {
    if (x0 == null || !sc) return
    const dx = e.clientX - x0
    if (!dragged && Math.abs(dx) > 5) { dragged = true; el.classList.add('is-dragging') }
    if (dragged) sc.scrollLeft = s0 - dx
  })
  window.addEventListener('pointerup', () => {
    if (x0 == null) return
    x0 = null; sc = null; el.classList.remove('is-dragging')
    setTimeout(() => { dragged = false }, 0)          // after the click this drag ends on
  })
}
