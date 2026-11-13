// "Scrolling through markets ... resets and redirects the user to the top."
//
// The phone's market list is rebuilt by _mobVRenderContent, and every background data refresh
// (updateMobileView) calls that too. Rebuilding replaced the scroller, so a reader halfway down
// the list was thrown back to the top every few seconds. A refresh now repaints the rows in place.
// Hermetic: exchange stubbed, sixty markets so the list scrolls.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/app'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const NAMES = Array.from({ length: 60 }, (_, i) => 'C' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))
const universe = NAMES.map(name => ({ name, szDecimals: 2, maxLeverage: 10 }))
const ctxs = NAMES.map((_, i) => ({ markPx: String(10 + i), midPx: String(10 + i), oraclePx: String(10 + i), prevDayPx: String(10 + i),
  openInterest: String(1000 - i * 10), dayNtlVlm: String(5000 - i), funding: '0', premium: '0', impactPxs: [String(10 + i), String(10 + i)] }))
const mids = Object.fromEntries(NAMES.map((n, i) => [n, String(10 + i)]))
const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '2000'], [Date.now(), '2000']], pnlHistory: [], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: mids, frontendOpenOrders: [], userFills: [],
  userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]), webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe }, spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe }, ctxs],
}

const errs = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
const p = await ctx.newPage()
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
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
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
await p.evaluate(() => window.mobVTab('trade'))
await waitFor(p, 'the markets', () => document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length >= 40, null, 30000)
await waitFor(p, 'the list to be sized', () => { const l = document.getElementById('mobMktList'); return l && l.scrollHeight > l.clientHeight + 500 })

const scrollTo = (y) => p.evaluate((y) => { const l = document.getElementById('mobMktList'); l.scrollTop = y; return l.scrollTop }, y)
const where = () => p.evaluate(() => document.getElementById('mobMktList')?.scrollTop ?? -1)
const at = await scrollTo(1200)
ok('the list scrolls', at > 600, at)
await p.evaluate(() => { document.getElementById('mobMktList').dataset.mark = '1' })

// A background refresh, as the data poll sends it.
await p.evaluate(() => window.__mobBgRefresh())
await p.waitForTimeout(400)
ok('a background refresh leaves the reader where they were', Math.abs((await where()) - at) < 2, [await where(), at])
ok('the scroller is the same element, not a rebuilt one', await p.evaluate(() => document.getElementById('mobMktList')?.dataset.mark === '1'))

// Live market data landing does the same.
await p.evaluate(() => window.__repaintMarketsLive?.())
ok('still there after the rows repaint', Math.abs((await where()) - at) < 2, await where())

// Leaving for a market and coming back is a real navigation, and still builds the list.
await p.evaluate(() => window._mobSelectMarket('CAA'))
await waitFor(p, 'the detail', () => !document.getElementById('mobMktRows'))
await p.evaluate(() => window._mobTradeGoBack())
ok('back from a market rebuilds the list', await waitFor(p, 'the list again', () => document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length >= 40))

ok('no page errors', !errs.length, errs)
console.log(`\n${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
