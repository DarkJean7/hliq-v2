/**
 * A sticky column that fits the visible area and scrolls on its own.
 *
 * Asked about the desktop Trade tab: "to reach the end of the right panel for some reason i need
 * to reach the end of left first which is annoying because sometimes i have a lot of positions.
 * make the right independent." The order panel was sticky with no height limit; taller than the
 * visible area, its bottom (the submit button) came into view only when the page ran out — after
 * every position on the left. Capped to the space below its sticky offset, it scrolls by itself.
 *
 * The visible area is whatever ancestor actually scrolls (the app scrolls <main>, not the
 * document), measured rather than guessed, and measured again when the window changes. Below
 * `minWidth` the layout is one column and the panel is left alone.
 */
export function fitSticky(el, { minWidth = 1001, gap = 12, min = 260 } = {}) {
  if (!el) return () => {}
  if (el._fitSticky) return el._fitSticky
  const scroller = () => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n
    }
    return null
  }
  const apply = () => {
    const cs = getComputedStyle(el)
    if (innerWidth < minWidth || cs.position !== 'sticky') { el.style.maxHeight = ''; return }
    const sc = scroller()
    const top = sc ? Math.max(0, sc.getBoundingClientRect().top) : 0
    const visible = sc ? Math.min(sc.clientHeight, innerHeight - top) : innerHeight
    const offset = parseFloat(cs.top) || 0
    el.style.maxHeight = Math.max(min, Math.floor(visible - offset - gap)) + 'px'
  }
  el._fitSticky = apply
  apply()
  addEventListener('resize', apply)
  try { new ResizeObserver(apply).observe(document.documentElement) } catch {}
  return apply
}
