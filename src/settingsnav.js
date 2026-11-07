// The groups Settings is divided into, shared by both shells so they cannot drift apart: the phone's
// screen is a template in main.js and the desktop's is static markup in index.html.

const ICON = {
  account: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
  notifications: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>',
  appearance: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  security: '<path d="M12 3 5 6v5c0 4.6 2.9 8.3 7 10 4.1-1.7 7-5.4 7-10V6z"/>',
  trading: '<path d="M4 18 10 12l4 3 6-8"/><path d="M15 7h5v5"/>',
  data: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  developer: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
}
export const SETTINGS_SECTIONS = [
  ['account', 'Account', 'Cuenta'],
  ['notifications', 'Notifications', 'Notificaciones'],
  ['appearance', 'Appearance', 'Apariencia'],
  ['security', 'Security', 'Seguridad'],
  ['trading', 'Trading & risk', 'Trading y riesgo'],
  ['data', 'Data & backup', 'Datos y copia'],
  ['developer', 'Developer', 'Desarrollador'],
]
const nameOf = (id, T) => { const s = SETTINGS_SECTIONS.find(x => x[0] === id); return s ? T(s[1], s[2]) : id }
const escAmp = (s) => s.replace(/&/g, '&amp;')
const icon = (id) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">${ICON[id] ?? ''}</svg>`

/** The row of shortcuts at the top. It scrolls sideways on a phone, hence data-dragscroll. */
export function settingsNavHtml(T) {
  return SETTINGS_SECTIONS.map(([id]) =>
    `<button type="button" class="set-chip" data-settings-jump="${id}" onclick="window.__settingsJump('${id}')">${icon(id)}${escAmp(nameOf(id, T))}</button>`).join('')
}
export const settingsHeadHtml = (id, T) => `<div class="set-sec-head">${icon(id)}<span>${escAmp(nameOf(id, T))}</span></div>`

/** The desktop screen is static markup, so its names and icons are filled in when it opens, in the current language. */
export function paintDesktopSettings(T) {
  const nav = document.getElementById('settingsNav')
  if (nav) nav.innerHTML = settingsNavHtml(T)
  document.querySelectorAll('#tab-settings .settings-card[data-settings-sec]').forEach((card) => {
    const title = card.querySelector('.settings-card-title')
    if (title) title.innerHTML = `${icon(card.dataset.settingsSec)}<span>${escAmp(nameOf(card.dataset.settingsSec, T))}</span>`
  })
}

/** Both shells are in the page at once, one of them hidden, so this goes to the group that is on screen. */
export function settingsJump(id) {
  const el = [...document.querySelectorAll(`[data-settings-sec="${id}"]`)].find(e => e.offsetParent !== null)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
