/**
 * INSOLVENT TERMINAL — the desktop tab bar: a few tabs on their own, the rest in groups.
 *
 * Twenty-two tabs in one row did not fit. Scrolling hid the last ones ("settings is missing"),
 * wrapping put Settings alone on a second row ("the tab looks awful"), and a single More menu
 * still left a bar of seventeen. Asked for: "groups tabs that when pressing it expands and
 * displays the other tabs … maintain the high important tabs single".
 *
 * index.html decides the groups. A grouped tab is still a `.nav-tab` button with its own
 * onclick, only sitting inside a `.nav-group-menu`, so switchTab, `.nav-tab.active` and every
 * `.nav-tab[onclick*="'name'"]` lookup work unchanged. This module:
 *   - opens a group's menu on its button, one at a time, and closes it on a pick, an outside
 *     click or Escape;
 *   - lights the group holding the open tab and names that tab on it ("Bots · Strategies"),
 *     so where you are is visible with every menu closed;
 *   - if a window is too narrow even for this, moves the items at the end into a More menu
 *     rather than wrapping or cutting them off.
 */

const HIDE = 'data-nav-overflow'
const chev = '<svg viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 1l4 4 4-4"/></svg>'

export function initNavGroups(bar) {
  if (!bar || bar.dataset.navGroups) return
  bar.dataset.navGroups = '1'

  const groups = [...bar.querySelectorAll(':scope > .nav-group')]
  const closeAll = (except) => {
    for (const g of groups) if (g !== except) setOpen(g, false)
    if (except !== more) setOpen(more, false)
  }
  function setOpen(g, on) {
    const menu = g.querySelector(':scope > .nav-group-menu, :scope > .nav-more-menu')
    const btn = g.querySelector(':scope > button')
    if (!menu || menu.hidden === !on) return
    menu.hidden = !on
    btn.setAttribute('aria-expanded', String(on))
    g.classList.toggle('open', on)
  }

  for (const g of groups) {
    const btn = g.querySelector(':scope > .nav-group-btn')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const opening = g.querySelector(':scope > .nav-group-menu').hidden
      closeAll(g); setOpen(g, opening)
    })
    // A pick closes the menu; the tab's own onclick has already done the switching.
    g.querySelector(':scope > .nav-group-menu').addEventListener('click', (e) => {
      if (e.target.closest('.nav-tab')) setOpen(g, false)
    })
  }

  // ── narrow windows: what does not fit goes under More, never onto a second row ──
  const more = document.createElement('div')
  more.className = 'nav-more'
  more.hidden = true
  more.innerHTML = `<button type="button" class="nav-group-btn nav-more-btn" aria-haspopup="true" aria-expanded="false"><span class="nav-group-label">More</span>${chev}</button><div class="nav-more-menu" role="menu" hidden></div>`
  bar.appendChild(more)
  const moreBtn = more.querySelector('.nav-more-btn')
  const moreMenu = more.querySelector('.nav-more-menu')
  const items = () => [...bar.children].filter(el => el !== more && (el.classList.contains('nav-tab') || el.classList.contains('nav-group')))
  const tabsOf = (el) => el.classList.contains('nav-group') ? [...el.querySelectorAll('.nav-tab')] : [el]
  const proxy = (t) => {
    const it = document.createElement('button')
    it.type = 'button'
    it.className = 'nav-more-item' + (t.classList.contains('active') ? ' active' : '')
    it.setAttribute('role', 'menuitem')
    it.innerHTML = t.innerHTML
    it.onclick = () => { setOpen(more, false); t.click() }
    return it
  }
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const opening = moreMenu.hidden
    if (opening) {
      moreMenu.innerHTML = ''
      for (const el of items().filter(el => el.hasAttribute(HIDE))) {
        const tabs = tabsOf(el).filter(t => getComputedStyle(t).display !== 'none')
        if (el.classList.contains('nav-group')) {
          const h = document.createElement('div')
          h.className = 'nav-more-head'
          h.textContent = el.querySelector('.nav-group-label')?.textContent ?? ''
          moreMenu.appendChild(h)
        }
        for (const t of tabs) moreMenu.appendChild(proxy(t))
      }
    }
    closeAll(more); setOpen(more, opening)
  })

  document.addEventListener('click', (e) => { if (!bar.contains(e.target)) closeAll(null) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(null) })

  // ── which group holds the open tab ──
  function sync() {
    for (const g of groups) {
      const act = g.querySelector('.nav-group-menu .nav-tab.active')
      g.classList.toggle('active', !!act)
      const cur = g.querySelector('.nav-group-cur')
      const name = act ? act.textContent.replace(/\s+\d+\s*$/, '').trim() : ''   // History carries a count
      if (cur && cur.textContent !== name) cur.textContent = name
    }
  }

  let busy = false
  function layout() {
    if (busy) return
    busy = true
    try {
      sync()
      const all = items()
      for (const el of all) el.removeAttribute(HIDE)
      more.hidden = true
      const host = bar.parentElement
      let avail = innerWidth
      if (host) { const hs = getComputedStyle(host); avail = host.clientWidth - parseFloat(hs.paddingLeft) - parseFloat(hs.paddingRight) }
      if (!avail || bar.offsetParent === null) return
      const cs = getComputedStyle(bar)
      const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
      const gap = parseFloat(cs.columnGap) || 0
      const shown = all.filter(el => el.offsetWidth > 0)
      // Items stretch to share the bar, so their widths always add up to it: ask whether the
      // labels overflow instead. When they do there is no space to share, so offsetWidth below
      // is each item's own width again.
      if (bar.scrollWidth <= bar.clientWidth + 1) { more.classList.remove('active'); return }
      more.hidden = false
      let used = chrome + moreBtn.offsetWidth + gap, keep = 0
      for (const el of shown) {
        const w = el.offsetWidth + (keep ? gap : 0)
        if (used + w > avail) break
        used += w; keep++
      }
      const hidden = shown.slice(keep)
      for (const el of hidden) { el.setAttribute(HIDE, ''); if (el.classList.contains('nav-group')) setOpen(el, false) }
      more.classList.toggle('active', hidden.some(el => el.classList.contains('active')))
    } finally {
      busy = false
    }
  }

  let raf = 0
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layout() }) }
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(bar.parentElement ?? bar)
  addEventListener('resize', schedule)
  // A tab opening (class), the History count (text), dev mode (html class) or the design switch.
  // Only changes to the tabs themselves: what this module writes (group classes, the label, the
  // More menu) would otherwise schedule itself forever.
  const ours = (n) => more.contains(n) || n.classList?.contains('nav-group') || n.closest?.('.nav-group-cur') || n.parentElement?.closest?.('.nav-group-cur')
  new MutationObserver((ms) => { if (ms.some(m => !ours(m.target))) schedule() })
    .observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  document.fonts?.ready?.then(schedule)
  schedule()
  return { layout }
}
