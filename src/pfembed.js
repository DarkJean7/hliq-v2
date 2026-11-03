/**
 * The Portfolios and Markets tabs inside the app. Asked: "make portfolios tab from the main app be
 * a copy of exactly as it currently is except adapted to be exclusive from main app so it does
 * not redirect", and then "also add the markets tab in the main app (adapted version just like
 * portfolios from landing page)".
 *
 * Each IS its public page — shown in a frame as /portfolios?embed=1 or /markets?embed=1, which
 * hides the public site's menu and footer and takes the app's theme (src/pftheme.js). Same page,
 * same origin: it reads the same saved accounts, agent keys and paper accounts the app does, and
 * any change to the public page shows here too, with nothing kept in step by hand.
 *
 *   desktop  a tab panel (#tab-portfolios, #tab-markets); the frame loads the first time the
 *            tab is opened
 *   phone    More → Portfolios / Markets opens it as a full-screen sheet with a close button
 */
const PAGES = {
  portfolios: { src: '/portfolios?embed=1', title: 'Portfolios', frame: 'pfEmbedFrame', sheet: 'pfEmbedSheet' },
  markets:    { src: '/markets?embed=1',    title: 'Markets',    frame: 'mkEmbedFrame', sheet: 'mkEmbedSheet' },
}

/** Desktop: load the panel's frame on first open (switchTab calls this). */
export function ensureEmbedFrame(name, doc = document) {
  const p = PAGES[name]
  const f = p && doc.getElementById(p.frame)
  if (f && !f.getAttribute('src')) f.setAttribute('src', p.src)
}
export const ensurePortfoliosFrame = (doc = document) => ensureEmbedFrame('portfolios', doc)

/** Phone: the page as a full-screen sheet over the app. Solid, like every sheet here. */
export function openEmbedSheet(name, doc = document) {
  const p = PAGES[name]
  if (!p || doc.getElementById(p.sheet)) return
  doc.getElementById('mobMoreDrawer')?.classList.remove('open')
  doc.getElementById('mobMoreBackdrop')?.classList.remove('open')
  const ov = doc.createElement('div')
  ov.id = p.sheet
  ov.style.cssText = 'position:fixed;inset:0;z-index:100055;display:flex;flex-direction:column;background:var(--bg)'
  ov.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;border-bottom:1px solid var(--border);background:var(--panel)">
      <b style="flex:1;font-size:17px">${p.title}</b>
      <button type="button" data-close aria-label="Close" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--panel-2);color:var(--fg);font-size:20px;cursor:pointer">×</button>
    </div>
    <iframe src="${p.src}" title="${p.title}" style="flex:1;width:100%;border:0;background:var(--bg)"></iframe>`
  const close = () => { ov.remove(); doc.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  ov.querySelector('[data-close]').addEventListener('click', close)
  doc.addEventListener('keydown', onKey)
  doc.body.appendChild(ov)
}
export const openPortfolios = (doc = document) => openEmbedSheet('portfolios', doc)
