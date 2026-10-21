/**
 * The Portfolios tab wears the app's theme, not the public site's.
 *
 * Reported: "the portfolios (only from main app of course, not landing page) tab is not
 * matching the overall main app". Inside the app the page is /portfolios?embed=1 in a frame
 * (src/pfembed.js), and it brought the public site's look with it: orange accent whatever the
 * user picked, a solid near-black ground over their wallpaper, scanlines, a terminal-prompt
 * headline.
 *
 * Same origin, so the frame can read the app's own resolved theme values and put them on the
 * names the public pages use. Read live, and again whenever the app's theme changes (accent,
 * light/dark, backdrop, wallpaper), so switching in Settings reaches this tab without a reload.
 * The public /portfolios is untouched: none of this runs without ?embed=1.
 */

// public-page token  ←  app token
export const TOKEN_MAP = {
  '--bg':         '--bg',
  '--bg-2':       '--panel',
  '--panel':      '--panel-2',
  '--rule':       '--rule',
  '--fg':         '--fg',
  '--fg-2':       '--fg-2',
  '--fg-3':       '--fg-3',
  '--accent':     '--accent',
  '--accent-ink': '--accent-fg',
  '--pos':        '--pos',
  '--neg':        '--neg',
  '--font-sans':  '--font-sans',
}

/** Copy the app's resolved values onto this document. Pure apart from the two documents. */
export function applyAppTheme(doc, appDoc, appWin) {
  const src = appDoc.body ?? appDoc.documentElement
  const cs = appWin.getComputedStyle(src)
  const root = doc.documentElement
  for (const [mine, theirs] of Object.entries(TOKEN_MAP)) {
    const v = cs.getPropertyValue(theirs).trim()
    if (v) root.style.setProperty(mine, v)
  }
  const light = appDoc.body?.classList.contains('light-mode') || appDoc.documentElement.dataset.theme === 'light'
  // The frame is transparent so the app's ground and wallpaper show through it, and a browser
  // paints a frame OPAQUE when its colour scheme differs from the page around it.
  root.style.colorScheme = light ? 'light' : 'dark'
  root.classList.toggle('pf-app-light', !!light)
  root.classList.toggle('pf-app-photo', appDoc.documentElement.classList.contains('has-bg-image'))
}

export function adoptAppTheme(win = window) {
  const doc = win.document
  if (!doc.documentElement.classList.contains('pf-embed')) return false
  let appWin, appDoc
  try { appWin = win.parent; appDoc = appWin?.document } catch { return false }   // not same-origin
  if (!appDoc || appWin === win) return false
  const run = () => { try { applyAppTheme(doc, appDoc, appWin) } catch {} }
  run()
  try {
    const mo = new appWin.MutationObserver(run)
    const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] }
    mo.observe(appDoc.documentElement, opts)
    if (appDoc.body) mo.observe(appDoc.body, opts)
  } catch {}
  return true
}
