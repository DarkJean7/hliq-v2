// Drag to reorder the watch cards, in the real app on a phone. "make the watch cards be able to
// change order". Real touch events (CDP), because the whole difficulty is the browser's own
// scrolling: a hold then a drag must carry the card, a drag without the hold must still scroll,
// and the card put down must not also open its market.
//
// Hermetic: Hyperliquid and our own API are stubbed.
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ` → ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`)
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(100)
  }
}

const MIDS = { BTC: '90000', ETH: '3000', SOL: '150', HYPE: '40' }
const UNIVERSE = Object.keys(MIDS).map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const HL = { meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null], allMids: MIDS,
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []] }
const WATCH = ['BTC', 'ETH', 'SOL', 'HYPE']

const errs = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/extquote**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : [] })
})
const p = await ctx.newPage()
p.on('pageerror', e => errs.push(e.message))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((w) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('hliq_watchlist', JSON.stringify(w))
}, WATCH)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))

const cdp = await ctx.newCDPSession(p)
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('hliq_watchlist')))
const centre = (sel) => p.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height } }, sel)
// Carry from one point to another in small steps, as a finger does.
const carry = async (a, b, steps = 12) => { for (let i = 1; i <= steps; i++) { await touch('touchMove', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await p.waitForTimeout(16) } }

const settleStrip = async () => {
  for (let i = 0; i < 20; i++) {
    const a = await p.evaluate(() => { const r = document.getElementById('mobWatchRotator'); r.scrollLeft = 0; return r.scrollLeft })
    await p.waitForTimeout(120)
    const b = await p.evaluate(() => document.getElementById('mobWatchRotator').scrollLeft)
    if (a === 0 && b === 0) return
  }
}

console.log('\n-- the home strip --')
await waitFor(p, 'the strip', () => document.querySelectorAll('#mobWatchRotator .mob-watch-cell').length === 4)
const order = () => p.evaluate(() => [...document.querySelectorAll('#mobWatchRotator .mob-watch-cell')].map(n => n.dataset.wk))
t('the strip starts in the saved order', await order(), WATCH)

{ // A drag without the hold is a scroll, and moves nothing.
  const a = await centre('#mobWatchRotator [data-wk="ETH"]')
  await touch('touchStart', a.x, a.y)
  await carry(a, { x: a.x - 150, y: a.y }, 8)
  await touch('touchEnd')
  await p.waitForTimeout(450)
  t('a quick drag does not pick a card up', await saved(), WATCH)
  // That swipe flings the strip; let the momentum die and put it back at the start before
  // measuring where the cards are.
  await settleStrip()
}
await p.evaluate(() => { window.__opened = []; window.__realOpen = window.__watchOpenTrade; window.__watchOpenTrade = c => window.__opened.push(c) })
{ // Hold BTC, carry it past ETH's middle, let go.
  const a = await centre('#mobWatchRotator [data-wk="BTC"]')
  const e = await centre('#mobWatchRotator [data-wk="ETH"]')
  await touch('touchStart', a.x, a.y)
  t('holding lifts the card', await waitFor(p, 'the lift', () => !!document.querySelector('#mobWatchRotator .wo-lifted'), null, 2000), true)
  await carry(a, { x: e.x + 20, y: a.y })
  await touch('touchEnd')
  await p.waitForTimeout(100)
  t('dropped after ETH, it stays there', await saved(), ['ETH', 'BTC', 'SOL', 'HYPE'])
  t('the strip shows it', await order(), ['ETH', 'BTC', 'SOL', 'HYPE'])
  t('nothing is left lifted or shifted', await p.evaluate(() => [...document.querySelectorAll('#mobWatchRotator .mob-watch-cell')].every(n => !n.style.transform && !n.classList.contains('wo-lifted'))), true)
  await p.waitForTimeout(450)
  t('putting a card down does not open its market', await p.evaluate(() => window.__opened), [])
  // ...and a plain tap still does (the control: the swallow is one click, not all of them).
  await settleStrip()
  const s = await centre('#mobWatchRotator [data-wk="ETH"]')   // on screen: only two cards fit
  await touch('touchStart', s.x, s.y); await touch('touchEnd')
  t('a tap still opens it', await waitFor(p, 'the tap', () => window.__opened.length > 0, null, 3000) && await p.evaluate(() => window.__opened), ['ETH'])
  await p.evaluate(() => { window.__watchOpenTrade = window.__realOpen })
}

console.log('\n-- the Watch tab --')
await p.evaluate(() => window.mobVGoTab('watch'))
await waitFor(p, 'the rows', () => document.querySelectorAll('#mobVContent .mob-watch-row').length === 4)
const rows = () => p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-watch-row')].map(n => n.dataset.wk))
t('the rows follow the strip', await rows(), ['ETH', 'BTC', 'SOL', 'HYPE'])
t('every row has a grip', await p.evaluate(() => document.querySelectorAll('#mobVContent .mob-watch-row .wo-grip').length), 4)
{ // The grip carries at once: HYPE to the top. At 930px the last row sits under the bottom nav.
  await p.evaluate(() => document.querySelector('#mobVContent [data-wk="HYPE"]').scrollIntoView({ block: 'center' }))
  await p.waitForTimeout(100)
  const g = await centre('#mobVContent [data-wk="HYPE"] .wo-grip')
  const top = await centre('#mobVContent [data-wk="ETH"]')
  await touch('touchStart', g.x, g.y)
  await carry(g, { x: g.x, y: top.y - top.h / 2 + 4 }, 16)
  await touch('touchEnd')
  await p.waitForTimeout(100)
  t('HYPE dragged by its grip to the top', await saved(), ['HYPE', 'ETH', 'BTC', 'SOL'])
  t('the page did not change tab under the drag', await p.evaluate(() => document.querySelectorAll('#mobVContent .mob-watch-row').length), 4)
}
await waitFor(p, 'the strip to follow', () => document.querySelector('#mobWatchRotator .mob-watch-cell')?.dataset.wk === 'HYPE', null, 4000)
t('the strip follows the Watch tab', await order(), ['HYPE', 'ETH', 'BTC', 'SOL'])

t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
