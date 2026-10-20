/**
 * The new interface's "Focus" layout on desktop (src/uinova.css): the sidebar becomes a panel a
 * menu button slides over the page, and the overview gets a row of quick actions under the
 * balance — the same four the phone has. Chosen from three layouts: "No sidebar (menu button
 * instead), one centered column like a banking app".
 *
 * Both are plain elements added once; CSS shows them only in the new interface, so switching
 * back to Classic needs nothing undone. The actions call the app's own handlers
 * (window.mobVDeposit / mobVWithdraw / mobVSend / __ovGoTrade), which already work on desktop.
 */
const MENU_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/></svg>'

const ACTIONS = [
  ['Deposit', 'mobVDeposit', true],
  ['Withdraw', 'mobVWithdraw', false],
  ['Send', 'mobVSend', false],
  ['Trade', '__ovGoTrade', true],
]

export function installNovaChrome(doc = document) {
  const root = doc.documentElement
  const close = () => root.classList.remove('nova-nav-open')

  // The menu: a button in the top bar, a scrim behind the open panel, and closing on a choice.
  const bar = doc.querySelector('.topbar')
  if (bar && !doc.getElementById('novaMenuBtn')) {
    const b = doc.createElement('button')
    b.id = 'novaMenuBtn'; b.className = 'nova-menu-btn'; b.type = 'button'
    b.setAttribute('aria-label', 'Menu'); b.innerHTML = MENU_SVG
    b.addEventListener('click', () => root.classList.toggle('nova-nav-open'))
    bar.prepend(b)
    const scrim = doc.createElement('div')
    scrim.className = 'nova-scrim'
    scrim.addEventListener('click', close)
    doc.body.appendChild(scrim)
    doc.querySelector('.sidebar')?.addEventListener('click', (e) => { if (e.target.closest('.sidebar-item')) close() })
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  }

  // Quick actions under the balance. The overview is redrawn often, so the row is put back each
  // time its card is replaced — watched on the overview's own container, not the whole page.
  const host = doc.getElementById('overviewStats')
  const place = () => {
    const card = host?.querySelector('.ov-equity')
    if (!card || card.querySelector('.nova-actions')) return
    const row = doc.createElement('div')
    row.className = 'nova-actions'
    row.innerHTML = ACTIONS.map(([label, fn, primary]) =>
      `<button type="button" class="nova-act${primary ? ' primary' : ''}" data-fn="${fn}">${label}</button>`).join('')
    row.addEventListener('click', (e) => { const fn = e.target.closest('[data-fn]')?.dataset.fn; if (fn) window[fn]?.() })
    const head = card.querySelector('.ov-eq-head')
    head ? head.after(row) : card.prepend(row)
  }
  if (host) { new MutationObserver(place).observe(host, { childList: true, subtree: true }); place() }
}
