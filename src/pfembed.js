/**
 * The Portfolios tab inside the app. Asked: "make portfolios tab from the main app be a copy of
 * exactly as it currently is except adapted to be exclusive from main app so it does not redirect".
 *
 * It IS the /portfolios page — shown in a frame as /portfolios?embed=1, which hides the public
 * site's menu and footer (portfolio.html). Same page, same origin: it reads the same saved
 * accounts, agent keys and paper accounts the app does, and any change to /portfolios shows here
 * too, with nothing kept in step by hand. /portfolios itself still works on its own.
 *
 *   desktop  a tab panel (#tab-portfolios); the frame loads the first time the tab is opened
 *   phone    More → Portfolios opens it as a full-screen sheet with a close button
 */
const SRC = '/portfolios?embed=1'

/** Desktop: load the panel's frame on first open (switchTab calls this). */
export function ensurePortfoliosFrame(doc = document) {
  const f = doc.getElementById('pfEmbedFrame')
  if (f && !f.getAttribute('src')) f.setAttribute('src', SRC)
}

/** Phone: the page as a full-screen sheet over the app. Solid, like every sheet here. */
export function openPortfolios(doc = document) {
  if (doc.getElementById('pfEmbedSheet')) return
  doc.getElementById('mobMoreDrawer')?.classList.remove('open')
  doc.getElementById('mobMoreBackdrop')?.classList.remove('open')
  const ov = doc.createElement('div')
  ov.id = 'pfEmbedSheet'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100055;display:flex;flex-direction:column;background:var(--bg)'
  ov.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;border-bottom:1px solid var(--border);background:var(--panel)">
      <b style="flex:1;font-size:17px">Portfolios</b>
      <button type="button" data-close aria-label="Close" style="width:36px;height:36px;border-radius:50%;border:none;background:var(--panel-2);color:var(--fg);font-size:20px;cursor:pointer">×</button>
    </div>
    <iframe src="${SRC}" title="Portfolios" style="flex:1;width:100%;border:0;background:var(--bg)"></iframe>`
  const close = () => { ov.remove(); doc.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  ov.querySelector('[data-close]').addEventListener('click', close)
  doc.addEventListener('keydown', onKey)
  doc.body.appendChild(ov)
}
