// The desktop tab bar: one row, and every tab reachable, whatever the window width.
// "i cannot access all tabs. settings is missing" — the bar outgrew the window and its scrollbar
// was hidden. Wrapping fixed that and put Settings alone on a second row: "the tab looks awful".
// Now it is one row and what does not fit is in a "More" menu (src/navoverflow.js). Both
// designs, a few widths, dev mode on so Grid Ladder is in the bar too.
import { chromium } from 'playwright'
const PORT = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL = `http://localhost:${PORT}/app`
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const errs = []
const browser = await chromium.launch()
for (const classic of [false, true]) for (const width of [1920, 1440, 1100]) {
  const label = `${classic ? 'classic' : 'nova'} ${width}px`
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route(/^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i, r => r.fulfill({ status: 200, contentType: 'application/json', json: [] }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate((classic) => {
    localStorage.clear()
    for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_sub_unlocked', 'hliq_dev']) localStorage.setItem(k, '1')
    localStorage.setItem('hliq_lang', 'en')
    if (classic) localStorage.setItem('hliq_ui', 'classic')
  }, classic)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.__goPaper, null, { timeout: 30000 })
  await p.evaluate(() => window.__goPaper())
  await p.waitForFunction(() => document.querySelector('.nav-tabs')?.offsetParent != null && document.querySelector('.nav-tabs')?.dataset.navOverflow, null, { timeout: 30000 })
  const read = () => p.evaluate(() => {
    const n = document.querySelector('.nav-tabs'), nr = n.getBoundingClientRect()
    const vis = [...n.querySelectorAll('.nav-tab')].filter(b => b.offsetParent !== null)
    const tops = new Set(vis.map(b => Math.round(b.getBoundingClientRect().top)))
    const out = vis.filter(b => { const r = b.getBoundingClientRect(); return r.right > nr.right + 1 || r.left < nr.left - 1 || r.right > innerWidth }).map(b => b.textContent.trim())
    const inBar = vis.filter(b => !b.classList.contains('nav-more-btn')).map(b => b.textContent.trim())
    const more = n.querySelector('.nav-more-btn'); more?.offsetParent && more.click()
    const inMenu = [...n.querySelectorAll('.nav-more-item')].map(b => b.textContent.trim())
    more?.offsetParent && more.click()
    const all = [...inBar, ...inMenu].join('|')
    return { rows: tops.size, out, settings: /Settings/.test(all), dev: /Grid Ladder/.test(all), chat: /Global Chat/.test(all) }
  })
  t(`${label}: one row, nothing outside the bar, every tab in the bar or under More`, await read(), { rows: 1, out: [], settings: true, dev: true, chat: true })
  if (width === 1100) {
    // A tab that lives under More still opens, and More lights up while it is the open one.
    const r = await p.evaluate(async () => {
      const n = document.querySelector('.nav-tabs'), more = n.querySelector('.nav-more-btn')
      more.click()
      const it = [...n.querySelectorAll('.nav-more-item')].find(b => /Settings/.test(b.textContent))
      it?.click()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      return { found: !!it, open: document.getElementById('tab-settings')?.classList.contains('active') ?? false, lit: more.classList.contains('active'), menuClosed: n.querySelector('.nav-more-menu').hidden }
    })
    t(`${label}: Settings opens from More, and More is lit while it is open`, r, { found: true, open: true, lit: true, menuClosed: true })
  }
  await ctx.close()
}
t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
