// The Trade tab's market list sorted by several columns at once, in a real page, and the tab
// staying solid under a backdrop photo. Rules: tests/suites/mktsort.test.mjs.
//
// Hermetic: exchange stubbed, four markets with the same numbers as the unit suite so the
// expected orders can be checked by hand there.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       MKTSORT_SHOT=<dir> to save a screenshot.
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.MKTSORT_SHOT || ''

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// name, OI in dollars, 24h volume, 24h change %, price
const MKTS = [
  ['BTC', 900, 500, 1, 85000],
  ['ETH', 800, 900, -2, 3000],
  ['PUMP', 100, 950, 12, 0.0045],
  ['DOGE', 300, 100, 4, 0.2],
]
const universe = MKTS.map(([name]) => ({ name, szDecimals: 2, maxLeverage: 10 }))
const ctxs = MKTS.map(([, oi, vol, chg, px]) => ({
  markPx: String(px), midPx: String(px), oraclePx: String(px),
  prevDayPx: String(px / (1 + chg / 100)), openInterest: String(oi / px), dayNtlVlm: String(vol),
  funding: '0', premium: '0', impactPxs: [String(px), String(px)],
}))
const mids = Object.fromEntries(MKTS.map(([n, , , , px]) => [n, String(px)]))

const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '2000'], [Date.now(), '2000']], pnlHistory: [], vlm: '0' }
const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '500', hold: '0', entryNtl: '0' }] },
  allMids: mids, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe }, spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe }, ctxs],
}
const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }

const errs = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await blockHlSockets(ctx)
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
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })

const boot = async () => {
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
  await p.evaluate(() => window.mobVTab('trade'))
  await waitFor(p, 'the markets', () => document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length >= 4, null, 30000)
}
// The list's order, by the favourite button each row carries.
const order = () => p.evaluate(() => [...document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]')]
  .map(b => b.id.replace('mobFavBtn-', '')).filter(n => ['BTC', 'ETH', 'PUMP', 'DOGE'].includes(n)).join(','))
const btn = (s) => p.evaluate((s) => document.querySelector(`.mob-mkt-sortbtn[data-sort="${s}"]`)?.textContent.trim(), s)

await boot()

console.log(NL + '-- one column, as before --')
{
  ok('OI leads by default', (await order()) === 'BTC,ETH,DOGE,PUMP', await order())
  ok('the Multi toggle is there, and off', await p.evaluate(() => document.getElementById('mobMktMultiBtn')?.getAttribute('aria-pressed')) === 'false')
  await p.click('.mob-mkt-sortbtn[data-sort="volume"]')
  ok('a column press still replaces the sort when Multi is off', (await order()) === 'PUMP,ETH,BTC,DOGE', await order())
  await p.click('.mob-mkt-sortbtn[data-sort="oi"]')
}

console.log(NL + '-- OI, then volume --')
{
  await p.click('#mobMktMultiBtn')
  ok('Multi starts from the sort already on screen, so nothing jumps', (await order()) === 'BTC,ETH,DOGE,PUMP' && /^1OI/.test(await btn('oi')), [await order(), await btn('oi')])
  await p.click('.mob-mkt-sortbtn[data-sort="volume"]')
  ok('volume joins as the second column', /^2Vol/.test(await btn('volume')), await btn('volume'))
  // Same numbers as the unit suite: PUMP (last on OI, first on volume) passes DOGE.
  ok('and the list is ordered by both, OI first', (await order()) === 'BTC,ETH,PUMP,DOGE', await order())
  if (SHOT) await p.screenshot({ path: SHOT + '/mktsort-mobile.png' })
}

console.log(NL + '-- remembered --')
{
  await boot()
  ok('Multi and its columns survive a reload', (await order()) === 'BTC,ETH,PUMP,DOGE' && /^1OI/.test(await btn('oi')) && /^2Vol/.test(await btn('volume')), [await order(), await btn('oi'), await btn('volume')])
  await p.click('.mob-mkt-sortbtn[data-sort="oi"]')   // desc → asc
  ok('pressing a chosen column flips it, keeping its place', /^1OI.*▴/.test(await btn('oi')), await btn('oi'))
  await p.click('.mob-mkt-sortbtn[data-sort="oi"]')   // asc → removed
  ok('and again takes it out: volume is first now', /^1Vol/.test(await btn('volume')) && (await order()) === 'PUMP,ETH,BTC,DOGE', [await btn('volume'), await order()])
  await p.click('#mobMktMultiBtn')
  ok('Multi off goes back to one column', await p.evaluate(() => document.getElementById('mobMktMultiBtn')?.getAttribute('aria-pressed')) === 'false' && !/^\d/.test(await btn('volume')))
}

console.log(NL + '-- solid under a backdrop photo --')
{
  const bgOf = () => p.evaluate(() => getComputedStyle(document.getElementById('mobVContent')).backgroundColor)
  await p.evaluate(() => {
    const el = document.documentElement
    el.style.setProperty('--app-bg-image', 'linear-gradient(90deg,#f0a,#0fa)')
    el.classList.add('has-bg-image')
  })
  const onTrade = await bgOf()
  ok('the Trade tab paints a solid ground', !/rgba\(0, 0, 0, 0\)|transparent/.test(onTrade) && !/rgba\([^)]*, 0\.\d+\)/.test(onTrade), onTrade)
  await p.evaluate(() => window.mobVTab('home'))
  await waitFor(p, 'home', () => !document.getElementById('mobileView')?.classList.contains('mob-in-trade'))
  ok('and only the Trade tab — Home still shows the photo', /rgba\(0, 0, 0, 0\)|transparent/.test(await bgOf()), await bgOf())
}

await ctx.close()
if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
