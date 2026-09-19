// The big figure above the Overview chart follows the chart.
//
// Reported as: "i changed to acc. pnl instead of equity but the amount displayed is still the
// equity. in mobile it works like its suppossed." The desktop switcher only ever redrew the
// canvas, so the headline went on saying Account Value while the line below it plotted PnL —
// two numbers side by side describing different things.
//
// This needs a browser because nothing in the source of either function is wrong on its own.
// The bug was that they never spoke: one drew, the other never repainted.
//
// Hermetic — the exchange is stubbed with a made-up account that grew $1,000 → $1,580, so the
// expected figures are exact rather than "whatever the wallet holds today".
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/`
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

// An account that went from $1,000 to $1,580: +$580 accumulated, and no closed fills, so
// Realized is flat at zero. Every figure below is derivable from those two facts.
const now = Date.now(), HR = 36e5
const WINDOW = {
  accountValueHistory: Array.from({ length: 30 }, (_, i) => [now - (29 - i) * HR, String(1000 + i * 20)]),
  pnlHistory:          Array.from({ length: 30 }, (_, i) => [now - (29 - i) * HR, String(i * 20)]),
  vlm: '0',
}
const MARGIN = { accountValue: '1580', totalNtlPos: '0', totalRawUsd: '1580', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1580', assetPositions: [], time: now }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }]
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '100' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
}

// WebSockets are NOT covered by ctx.route, and the combined view opens one to Hyperliquid for
// live state. Left alone it delivers real prices straight past every fixture here — which is
// how a stubbed KNTQ at $0.26438 rendered as $0.2872, drifting between runs. Closed, so the
// app falls back to the REST path the fixtures actually govern.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await blockHlSockets(ctx)
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let body = {}
  try { body = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[body.type] ?? {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the overview headline', () => !!document.querySelector('.ov-equity .ov-eq-val')?.textContent?.trim())

const head = () => p.evaluate(() => ({
  label: document.querySelector('.ov-equity .ov-label')?.textContent?.trim(),
  val:   document.querySelector('.ov-equity .ov-eq-val')?.textContent?.trim(),
  chg:   document.getElementById('ovChgPill')?.textContent?.trim(),
}))
const set = async (type) => { await p.evaluate((x) => window.__ovSetChartType(x), type); await p.waitForTimeout(600) }

console.log('\n-- the headline follows the chart tab --')
await set('value')
t('Equity shows the account value', await head(), { label: 'Account Value · Perp Equity', val: '$1,580.00', chg: '▲ +$580.00 · +58.00%' })

await set('accumulated')
// This is the whole bug: it used to still say $1,580.00 here.
t('Acc. PnL shows the PnL, not the equity', await head(), { label: 'Accumulated PnL · this week', val: '+$580.00', chg: '+58.00%' })

await set('realized')
// No closed fills in the fixture, so realized is genuinely flat — and says so rather than
// falling back to the equity.
t('Realized shows realized', await head(), { label: 'Realized PnL · this week', val: '+$0.00', chg: '+0.00%' })

await set('value')
t('and going back restores the equity header exactly', await head(), { label: 'Account Value · Perp Equity', val: '$1,580.00', chg: '▲ +$580.00 · +58.00%' })

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
