// The Portfolio chart and its Advanced view, driven for real.
//
// Asked for: "more lower timeframes like 8 hours, 4h. also add hour, minutes on the chart, and
// make some days appear visible without the need to hover. also fix its advanced mode which is
// not allowing scrolling like when in regular mode. also advanced mode looks awful and zoom
// function can be improved."
//
// The zoom complaint was a data problem: Advanced read only the all-time history, whose points
// are days apart, so 1H showed one or two points. The fixture here is shaped like Hyperliquid's:
// 'day' every 5 minutes, 'week' hourly, 'month' every 6 hours, 'allTime' daily.
// Rules: tests/suites/portchart.test.mjs.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)  [--shot=dir]
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const APP  = `http://localhost:${port}/app`
const SHOT = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1] || ''
const ADDR = '0x4444444444444444444444444444444444444444'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const t = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const NOW = Date.now(), MIN = 60e3, H = 60 * MIN, D = 24 * H
const val = (t) => 2000 + 400 * Math.sin(t / (5 * D)) + 60 * Math.sin(t / (3 * H)) + (NOW - t) * -0.000001
const series = (span, step) => { const out = []; for (let t = NOW - span; t <= NOW; t += step) out.push([t, String(val(t))]); return out }
const pnl = (h) => h.map(([t, v]) => [t, String(parseFloat(v) - parseFloat(h[0][1]))])
const W = (span, step) => { const av = series(span, step); return { accountValueHistory: av, pnlHistory: pnl(av), vlm: '0' } }
const PORTFOLIO = [['day', W(D, 5 * MIN)], ['week', W(7 * D, H)], ['month', W(30 * D, 6 * H)], ['allTime', W(400 * D, D)]]
const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '2000', assetPositions: [], time: NOW }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }]
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '100000' }, frontendOpenOrders: [],
  userFills: [], userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: UNIVERSE }], perpDexs: [null], perpCategories: [], portfolio: PORTFOLIO,
  webData2: { clearinghouseState: STATE, openOrders: [] }, meta: { universe: UNIVERSE },
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '1', prevDayPx: '1e5', dayNtlVlm: '1', premium: '0', oraclePx: '1e5', markPx: '1e5', midPx: '1e5', impactPxs: ['1e5', '1e5'] }]],
}

const browser = await chromium.launch()
const errs = []
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', r => r.fulfill({ status: 200, json: { prices: {} } }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
const p = await ctx.newPage()
p.on('pageerror', e => errs.push(e.message))
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab)
await p.evaluate(() => { document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()); document.getElementById('bootSplash')?.remove() })
await p.evaluate(() => window.mobVTab('portfolio'))
await waitFor(p, 'the chart', () => !!window.__portChartDbg?.())

console.log('\n-- the inline chart --')
const periods = await p.evaluate(() => [...document.querySelectorAll('[data-port-period]')].map(b => b.textContent.trim()))
t('4H and 8H are offered', periods.join(',') === '4H,8H,1D,7D,1M,All', periods)
for (const [lbl, hrs] of [['4H', 4], ['8H', 8]]) {
  await p.click(`[data-port-period="${lbl}"]`)
  const d = await p.evaluate(() => window.__portChartDbg())
  t(`${lbl} shows ${hrs} hours, at the day history's 5-minute points`, Math.abs((d.t1 - d.t0) - hrs * H) < 10 * MIN && d.n >= hrs * 12 - 2, d)
  t(`${lbl} is marked as the active one`, await p.evaluate((l) => document.querySelector(`[data-port-period="${l}"]`).classList.contains('on'), lbl))
}
if (SHOT) { await p.setViewportSize({ width: 393, height: 1100 }); await p.waitForTimeout(400); await p.screenshot({ path: `${SHOT}/portchart-page.png`, clip: { x: 0, y: 0, width: 393, height: 560 } }); await p.setViewportSize({ width: 393, height: 852 }) }
await p.click('[data-port-period="1D"]')
if (SHOT) await p.locator('#mobVPortChart').screenshot({ path: `${SHOT}/portchart-1d.png` })
await p.click('[data-port-period="allTime"]')

console.log('\n-- Advanced --')
await p.click('[data-port-adv]')
await waitFor(p, 'advanced', () => window.__advDbg?.().total > 0)
const adv = await p.evaluate(() => window.__advDbg())
t('it reads every resolution, not just all-time (400 daily + the finer ones)', adv.total > 600, adv)
await p.click('[data-adv-period="1H"]')
const h1 = await p.evaluate(() => window.__advDbg())
t('zoomed to 1H there are real points to see (5-minute data), not one or two', h1.inView >= 10, h1)
await p.click('[data-adv-period="4H"]')
const h4 = await p.evaluate(() => window.__advDbg())
t('4H is there too', Math.abs((h4.t1 - h4.t0) - 4 * H) < MIN && h4.inView >= 40, h4)
t('the range on screen is written under the title', /–/.test(await p.textContent('#advRange')), await p.textContent('#advRange'))

// Double-tap zooms in where you tapped.
const box = await p.locator('#advChart').boundingBox()
const before = await p.evaluate(() => window.__advDbg())
await p.locator('#advChart').dblclick({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
const after = await p.evaluate(() => window.__advDbg())
t('double-tap zooms in', (after.t1 - after.t0) < (before.t1 - before.t0) * 0.6, { before, after })

// The overview strip: drag the window back in time.
await p.click('[data-adv-period="7D"]')
const w0 = await p.evaluate(() => window.__advDbg())
const nb = await p.locator('#advNav').boundingBox()
await p.mouse.move(nb.x + nb.width - 4, nb.y + nb.height / 2)
await p.mouse.down(); await p.mouse.move(nb.x + nb.width * 0.4, nb.y + nb.height / 2, { steps: 5 }); await p.mouse.up()
const w1 = await p.evaluate(() => window.__advDbg())
t('dragging the strip moves the window back in time, same width', w1.t1 < w0.t1 - 30 * D && Math.abs((w1.t1 - w1.t0) - (w0.t1 - w0.t0)) < MIN, { w0, w1 })

// It scrolls: up/down on the chart is the page's, and the page has somewhere to go.
const sc = await p.evaluate(() => {
  const ov = document.getElementById('advChartOverlay')
  const ta = getComputedStyle(document.getElementById('advChart')).touchAction
  ov.scrollTop = 9999
  return { ta, overflow: getComputedStyle(ov).overflowY, scrolled: ov.scrollTop, can: ov.scrollHeight > ov.clientHeight }
})
t('a vertical swipe on the chart is left to the page (touch-action: pan-y)', sc.ta === 'pan-y', sc)
t('the overlay scrolls', sc.overflow === 'auto' && (!sc.can || sc.scrolled > 0), sc)
t('and its last button can be reached', await p.evaluate(() => {
  const ov = document.getElementById('advChartOverlay'), last = ov.querySelector('.adv-foot .pc-chip:last-child')
  const r = last.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0
}))
// "scrolling inside the chart line does not work the same as basic mode" / "let me scroll
// freely over left and right outside the chart similar as trade assets": a sideways drag ON the
// line reads it (the Portfolio page's gesture); anywhere else it slides through time, with momentum.
await p.evaluate(() => { document.getElementById('advChartOverlay').scrollTop = 0 })
await p.click('[data-adv-period="1D"]')
const swipe = (fromX, y, toX) => p.evaluate(([fromX, y, toX]) => {
  const c = document.getElementById('advChart'), r = c.getBoundingClientRect()
  const T = (x) => new Touch({ identifier: 1, target: c, clientX: r.left + x, clientY: r.top + y })
  const fire = (type, x) => c.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [T(x)], changedTouches: [T(x)] }))
  fire('touchstart', fromX)
  return new Promise(res => {
    let k = 0; const N = 8
    const tick = () => { k++; fire('touchmove', fromX + (toX - fromX) * k / N); if (k < N) setTimeout(tick, 12); else { fire('touchend', toX); res() } }
    setTimeout(tick, 12)
  })
}, [fromX, y, toX])
{
  const cb = await p.locator('#advChart').boundingBox()
  const x = cb.width * 0.7, ly = await p.evaluate((x) => window.__advLineY(x), x)
  const s0 = await p.evaluate(() => window.__advDbg())
  await swipe(x, ly, cb.width * 0.4)
  const s1 = await p.evaluate(() => window.__advDbg())
  t('a sideways drag ON the line reads it: the crosshair follows, the window stays put', s1.cross >= 0 && s1.t0 === s0.t0 && s1.t1 === s0.t1, { s0, s1 })
  // Off the line WHERE THE FINGER LANDS. The fixture is built from Date.now(), so the line's
  // shape moves with the time of day; a fixed y was on the line on some runs (CI, 2026-11-14).
  const sx = cb.width * 0.3, sy = await p.evaluate((x) => window.__advLineY(x), sx)
  const offY = [20, cb.height * 0.3, cb.height * 0.5, cb.height * 0.7, cb.height - 40]
    .reduce((best, y) => Math.abs(y - sy) > Math.abs(best - sy) ? y : best, 20)
  t('(the off-line touch really is off the line)', Math.abs(offY - sy) >= 60, { offY, sy })
  await swipe(cb.width * 0.3, offY, cb.width * 0.8)
  const s2 = await p.evaluate(() => window.__advDbg())
  t('a sideways drag OFF the line moves back through time, like the Trade chart', s2.t1 < s1.t1 && s2.cross === -1, { s1, s2 })
  await p.waitForTimeout(50)
  const s3 = await p.evaluate(() => window.__advDbg())
  await waitFor(p, 'the fling to settle', () => !window.__advDbg().flinging, null, 4000)
  t('and a quick throw keeps going after the finger lifts', s3.t1 < s2.t1 || s2.flinging, { s2, s3 })
}
await p.evaluate(() => { document.getElementById('advChartOverlay').scrollTop = 0 })
if (SHOT) {
  await p.evaluate(() => { document.getElementById('advChartOverlay').scrollTop = 0 })
  await p.click('[data-adv-period="1D"]')
  const cb = await p.locator('#advChart').boundingBox()
  await p.locator('#advChart').click({ position: { x: cb.width * 0.62, y: cb.height * 0.5 } })
  await p.screenshot({ path: `${SHOT}/portchart-advanced.png` })
}

// "replay is also not working in advanced mode": it opened UNDER the overlay.
await p.evaluate(() => document.getElementById('advChartOverlay').scrollTop = 9999)
await p.click('[data-adv-replay]')
const rp = await p.evaluate(() => ({ adv: getComputedStyle(document.getElementById('advChartOverlay')).display, open: window.__advDbg().open, replay: /Replay|Repetici/.test(document.body.innerText) && !!document.querySelector('[onclick*="__replayBack"]') }))
t('Replay from Advanced closes Advanced and shows the replay', rp.adv === 'none' && !rp.open && rp.replay, rp)

t('no page errors', !errs.length, errs)
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
