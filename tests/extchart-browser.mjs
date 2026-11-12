// An outside market's chart is the app's own, from the same data as its price in the strip.
//
// Reported: "price is not matching" -- the strip said DXY 102.98 (the ICE index) and the chart that
// opened said 102.664 (CAPITALCOM:DXY, a broker's CFD: TradingView will not let another site embed
// the index itself). The chart now comes from /extcandles and its headline from the strip's quote.
// Hermetic: the exchange, /extquote and /extcandles are all stubbed, and so is TradingView, which
// must not be asked for anything when DXY opens.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const APP  = `http://localhost:${port}/app`
const ADDR = '0x4444444444444444444444444444444444444444'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const DXY = 'CAPITALCOM:DXY'

let pass = 0, fail = 0
const t = (n, ok, x = '') => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const ctx1 = (px) => ({ funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] })
const WINDOW = { accountValueHistory: [[Date.now() - 36e5, '1000'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 36e5, '0'], [Date.now(), '0']], vlm: '0' }
const reply = (b) => {
  switch (b.type) {
    case 'allMids': return { BTC: '82000' }
    case 'metaAndAssetCtxs': return [{ universe: UNIVERSE }, [ctx1('82000')]]
    case 'meta': return { universe: UNIVERSE }
    case 'perpDexs': return [null]
    case 'allPerpMetas': return [{ universe: UNIVERSE }]
    case 'spotMeta': return { tokens: [], universe: [] }
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'clearinghouseState': return STATE
    case 'spotClearinghouseState': return { balances: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW])
    case 'webData2': return { clearinghouseState: STATE, openOrders: [] }
    case 'frontendOpenOrders': case 'userFills': case 'userFillsByTime': case 'userFunding': case 'perpCategories':
    case 'userNonFundingLedgerUpdates': case 'subAccounts': case 'candleSnapshot': case 'extraAgents': return []
    default: return {}
  }
}

// The index: 102.98, up 0.72% on the day. The week's series rises from 102.0 to 102.98.
const NOW = Date.now(), H = 3600e3
const QUOTE = { price: 102.98, pct: 0.72, points: Array.from({ length: 40 }, (_, i) => 102.24 + i * 0.019) }
const series = (n, step, from, to) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * step, c: +(from + (to - from) * i / (n - 1)).toFixed(3) }))
const SERIES = { '1D': series(90, 0.25 * H, 102.24, 102.98), '1W': series(120, H, 102.0, 102.98), '1M': [] }
const asked = []
let tvAsked = 0

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(/tradingview\.com/, (r) => { tvAsked++; return r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }) })
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(b) })
})
await ctx.route('**/extquote?**', r => r.fulfill({ status: 200, contentType: 'application/json', json: { quotes: { [DXY]: QUOTE } } }))
await ctx.route('**/extcandles?**', (r) => {
  const q = new URL(r.request().url()).searchParams
  asked.push(q.get('tf'))
  // 1M: the market had no trading in the window, which is an answer (empty), not a failure.
  return r.fulfill({ status: 200, contentType: 'application/json', json: { series: { [q.get('s')]: SERIES[q.get('tf')] ?? [] } } })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, dxy }) => {
  localStorage.clear()
  for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  localStorage.setItem('hliq_watchlist', JSON.stringify(['BTC']))
  localStorage.setItem('hliq_tv_watch', JSON.stringify([dxy]))
}, { a: ADDR, dxy: DXY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'DXY in the strip with its price', () => /102\.98/.test([...document.querySelectorAll('#watchTickerTrack .watch-ticker-item')].map(x => x.textContent).join(' ')))
const stripText = await p.evaluate(() => [...document.querySelectorAll('#watchTickerTrack .watch-ticker-item')].find(x => /DXY/.test(x.textContent))?.textContent.replace(/\s+/g, ' ').trim())
t('the strip shows the index', /102\.98/.test(stripText ?? ''), stripText)

const tvBefore = tvAsked
await p.evaluate(() => [...document.querySelectorAll('#watchTickerTrack .watch-ticker-item')].find(x => /DXY/.test(x.textContent))?.click())
await waitFor(p, 'the chart', () => !!document.querySelector('#tvChartOverlay [data-ext-chart] svg'))
const view = await p.evaluate(() => ({
  price: document.getElementById('extChartPrice')?.textContent.trim(),
  pct: document.getElementById('extChartPct')?.textContent.replace(/\s+/g, ' ').trim(),
  iframe: !!document.querySelector('#tvChartOverlay iframe'),
  title: document.querySelector('#tvChartOverlay')?.textContent.replace(/\s+/g, ' ').slice(0, 60),
  over: (() => { const o = document.querySelector('#tvChartOverlay [data-ext-chart]'); return o ? o.scrollWidth - o.clientWidth : -1 })(),
}))
t('the chart opens on the price the strip shows, to the digit', view.price === '102.98', view)
t('with the same day\'s change', /^\+0\.72% 24h$/.test(view.pct ?? ''), view)
t('it is the app\'s own chart, not a TradingView embed', !view.iframe && tvAsked === tvBefore, { view, tvAsked, tvBefore })
t('named as the index', /US Dollar Index/.test(view.title ?? ''), view)
t('it fits the phone', view.over <= 0, view)
t('it opens on the day', asked[0] === '1D', asked)
const dayLine = await p.evaluate(() => document.querySelector('#tvChartOverlay [data-ext-chg]')?.textContent.replace(/\s+/g, ' ').trim())
t('and says how the window moved', /^1D \+0\.72%$/.test(dayLine ?? ''), dayLine)

await p.tap('[data-ext-tf="1W"]')
await waitFor(p, 'the week', () => /^1W/.test(document.querySelector('#tvChartOverlay [data-ext-chg]')?.textContent.trim() ?? ''))
const wk = await p.evaluate(() => ({ chg: document.querySelector('#tvChartOverlay [data-ext-chg]')?.textContent.replace(/\s+/g, ' ').trim(), on: document.querySelector('[data-ext-tf="1W"]')?.getAttribute('aria-pressed') }))
t('a timeframe asks for its own window', asked.includes('1W') && wk.on === 'true', { asked, wk })
t('and its change is the window\'s, first to last', wk.chg === '1W +0.96%', wk)

await p.tap('[data-ext-tf="1M"]')
await waitFor(p, 'the closed message', () => !!document.querySelector('#tvChartOverlay [data-ext-msg]'))
t('a window with no trading says the market is closed, not a flat line', /market is closed/.test(await p.evaluate(() => document.querySelector('#tvChartOverlay [data-ext-msg]')?.textContent ?? '')))

t('TradingView is one tap away, on its own site', await p.evaluate(() => document.querySelector('[data-ext-tv]')?.getAttribute('href')) === 'https://www.tradingview.com/chart/?symbol=CAPITALCOM%3ADXY')
const shot = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1]
if (shot) { await p.tap('[data-ext-tf="1W"]'); await p.waitForTimeout(500); await p.screenshot({ path: shot }) }

await p.evaluate(() => window.__tvCloseChart())
t('it closes', await p.evaluate(() => getComputedStyle(document.getElementById('tvChartOverlay')).display === 'none'))

// A symbol typed in by hand has no data source here, and still opens TradingView.
await p.evaluate(() => window.__tvOpenChart('NASDAQ:AAPL'))
await waitFor(p, 'the embed', () => !!document.getElementById('tvChartMount'), null, 5000)
t('a market we have no data for still opens TradingView', await p.evaluate(() => !!document.getElementById('tvChartMount') && !document.querySelector('[data-ext-chart]')))

t('no page errors', !errs.length, errs)
console.log(`\n${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
