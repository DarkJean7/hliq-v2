// The desktop tab bar: every tab reachable, whatever the window width.
// "i cannot access all tabs. settings is missing" — Agent Arena, dev mode's Grid Ladder and the
// History count made the bar wider than the window, and its scrollbar is hidden, so the last
// tabs could not be reached with a mouse. It wraps now. Both designs, a few widths.
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
  await p.waitForFunction(() => document.querySelector('.nav-tabs')?.offsetParent != null, null, { timeout: 30000 })
  const r = await p.evaluate(() => {
    const n = document.querySelector('.nav-tabs'), nr = n.getBoundingClientRect()
    const tabs = [...n.querySelectorAll('.nav-tab')].filter(b => b.offsetParent !== null)
    const out = tabs.filter(b => { const r = b.getBoundingClientRect(); return r.right > nr.right + 1 || r.left < nr.left - 1 || r.right > innerWidth }).map(b => b.textContent.trim())
    return { out, settings: tabs.some(b => /Settings/.test(b.textContent)), dev: tabs.some(b => /Grid Ladder/.test(b.textContent)) }
  })
  t(`${label}: every tab is inside the bar and the window (Settings and dev mode's Grid Ladder too)`, r, { out: [], settings: true, dev: true })
  await ctx.close()
}
t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
