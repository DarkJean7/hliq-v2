// The groups Settings is divided into, shared by both shells so they cannot drift apart: the phone's
// screen is a template in main.js and the desktop's is static markup in index.html.
//
// Every group starts closed. A closed group is only hidden, never left unrendered, because code all over
// the app reads these inputs by id. What is open lasts until the page reloads, and has to live here: the
// phone rebuilds this screen on most interactions.

const ICON = {
  account: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
  notifications: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  security: '<path d="M12 3 5 6v5c0 4.6 2.9 8.3 7 10 4.1-1.7 7-5.4 7-10V6z"/>',
  trading: '<path d="M4 18 10 12l4 3 6-8"/><path d="M15 7h5v5"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  developer: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
}
// id, name, then what is inside, which is all a closed group has to say for itself.
export const SETTINGS_SECTIONS = [
  ['account', 'Account', 'Cuenta', 'Wallet and agent key', 'Cartera y clave de agente'],
  ['notifications', 'Notifications', 'Notificaciones', 'Alerts, sounds and fill cards', 'Alertas, sonidos y avisos de órdenes'],
  ['appearance', 'Appearance', 'Apariencia', 'Theme, backdrop and language', 'Tema, fondo e idioma'],
  ['security', 'Security', 'Seguridad', 'PIN lock and how keys are kept', 'PIN y cómo se guardan las claves'],
  ['trading', 'Trading & risk', 'Trading y riesgo', 'News pause and risk limits', 'Pausa por noticias y límites de riesgo'],
  ['data', 'Data & backup', 'Datos y copia', 'Export and import', 'Exportar e importar'],
  ['developer', 'Developer', 'Desarrollador', 'Dev mode and tools', 'Modo desarrollador y herramientas'],
]
const _open = new Set()
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const icon = (id) => `<svg class="set-head-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[id] ?? ''}</svg>`

/**
 * The button that opens a group. `alert` replaces the description: a key Hyperliquid no longer accepts, or
 * trading that has paused itself, must not be hidden behind a closed group.
 */
export function settingsHeadInner(id, T, alert = '') {
  const s = SETTINGS_SECTIONS.find(x => x[0] === id)
  if (!s) return ''
  return `<button type="button" class="set-head-btn" aria-expanded="${_open.has(id)}" onclick="window.__settingsToggle('${id}')">
    ${icon(id)}
    <span class="set-head-txt"><span class="set-head-name">${escHtml(T(s[1], s[2]))}</span>
      ${alert ? `<span class="set-head-hint set-head-alert" data-settings-alert>⚠ ${escHtml(alert)}</span>` : `<span class="set-head-hint">${escHtml(T(s[3], s[4]))}</span>`}</span>
    <svg class="set-head-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
  </button>`
}
export const settingsHeadHtml = (id, T, alert = '') => `<div class="set-sec-head">${settingsHeadInner(id, T, alert)}</div>`
export const settingsSecClass = (id) => `set-sec${_open.has(id) ? ' open' : ''}`

/** The desktop screen is static markup, so its headers are filled in when it opens, in the current language. */
export function paintDesktopSettings(T, alerts = {}) {
  document.querySelectorAll('#tab-settings .settings-card[data-settings-sec]').forEach((card) => {
    const id = card.dataset.settingsSec
    card.classList.add('set-sec')
    card.classList.toggle('open', _open.has(id))
    const title = card.querySelector('.settings-card-title')
    if (title) title.innerHTML = settingsHeadInner(id, T, alerts[id] ?? '')
  })
}

function apply(id) {
  const on = _open.has(id)
  document.querySelectorAll(`[data-settings-sec="${id}"]`).forEach((el) => {
    el.classList.toggle('open', on)
    el.querySelector('.set-head-btn')?.setAttribute('aria-expanded', String(on))
  })
  // Opening a group near the bottom would otherwise grow out of sight, under the phone's bottom bar.
  if (!on || typeof innerHeight !== 'number') return
  const el = [...document.querySelectorAll(`[data-settings-sec="${id}"]`)].find(e => e.offsetParent !== null)
  if (el && el.getBoundingClientRect().bottom > innerHeight - 90) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
export function settingsToggle(id) {
  if (_open.has(id)) _open.delete(id); else _open.add(id)
  apply(id)
}
/** For anything that sends someone to a setting: "Wallet settings" has to land on an open Account. */
export function settingsOpen(id) {
  _open.add(id)
  apply(id)
}
