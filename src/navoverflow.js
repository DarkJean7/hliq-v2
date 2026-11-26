/**
 * INSOLVENT TERMINAL — the desktop tab bar, one row whatever the window width.
 *
 * Two answers came before this. A hidden-scrollbar strip left the last tabs unreachable with a
 * mouse ("i cannot access all tabs. settings is missing"). Wrapping fixed that and put Settings
 * alone on a second row ("the tab looks awful").
 *
 * This keeps one row and moves the tabs that do not fit into a "More" menu at its end, in the
 * same order. The tabs themselves never move: a menu item clicks the hidden tab, so switchTab
 * and everything that reads `.nav-tab.active` work as before. When the open tab is one of the
 * hidden ones, More is lit, so you can still see where you are.
 */

const HIDE = 'data-nav-overflow'

export function initNavOverflow(bar) {
  if (!bar || bar.dataset.navOverflow) return
  bar.dataset.navOverflow = '1'
  bar.classList.add('nav-one-row')

  const wrap = document.createElement('div')
  wrap.className = 'nav-more'
  wrap.innerHTML = `<button type="button" class="nav-tab nav-more-btn" aria-haspopup="true" aria-expanded="false"><span class="nav-more-label">More</span><svg viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 1l4 4 4-4"/></svg></button><div class="nav-more-menu" role="menu" hidden></div>`
  bar.appendChild(wrap)
  const btn = wrap.querySelector('.nav-more-btn')
  const menu = wrap.querySelector('.nav-more-menu')

  const tabs = () => [...bar.children].filter(el => el !== wrap && el.classList.contains('nav-tab'))
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false') }
  const open = () => {
    menu.innerHTML = ''
    for (const t of tabs().filter(t => t.hasAttribute(HIDE))) {
      const it = document.createElement('button')
      it.type = 'button'; it.className = 'nav-more-item' + (t.classList.contains('active') ? ' active' : '')
      it.setAttribute('role', 'menuitem')
      it.innerHTML = t.innerHTML
      it.onclick = () => { close(); t.click() }
      menu.appendChild(it)
    }
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true')
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close() }
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })

  let busy = false
  function layout() {
    if (busy) return
    busy = true
    try {
      const all = tabs()
      for (const t of all) t.removeAttribute(HIDE)
      wrap.hidden = true
      const host = bar.parentElement
      let avail = innerWidth
      if (host) { const hs = getComputedStyle(host); avail = host.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight) }
      if (!avail || bar.offsetParent === null) return
      const cs = getComputedStyle(bar)
      const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
      const gap = parseFloat(cs.columnGap) || 0
      const shown = all.filter(t => t.offsetWidth > 0)   // dev-gate tabs outside dev mode are display:none
      const width = (list) => list.reduce((s, t) => s + t.offsetWidth, 0) + gap * Math.max(0, list.length - 1)
      if (width(shown) + chrome <= avail) { btn.classList.remove('active'); return }

      wrap.hidden = false
      const moreW = btn.offsetWidth + gap
      let used = chrome + moreW, keep = 0
      for (const t of shown) {
        const w = t.offsetWidth + (keep ? gap : 0)
        if (used + w > avail) break
        used += w; keep++
      }
      const hidden = shown.slice(keep)
      for (const t of hidden) t.setAttribute(HIDE, '')
      const act = hidden.find(t => t.classList.contains('active'))
      btn.classList.toggle('active', !!act)
      btn.title = act ? act.textContent.trim() : ''
    } finally {
      busy = false
    }
  }

  let raf = 0
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout() }) }
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(bar.parentElement ?? bar)
  addEventListener('resize', schedule)
  // A tab opening (class), the History count (text), dev mode (html class) or the design switch.
  new MutationObserver((ms) => { if (ms.some(m => !wrap.contains(m.target))) schedule() })
    .observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  document.fonts?.ready?.then(schedule)
  schedule()
  return { layout }
}
