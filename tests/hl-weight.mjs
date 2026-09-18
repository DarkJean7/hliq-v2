// What does the app ask Hyperliquid for, and what does it weigh?
//
// HL rate-limits by IP: 1200 weight/min shared across /info and /exchange. Tripping it does
// not just stall the dashboard, it starves order placement — so this is a budget, not a
// nicety. Documented weights: 2 for l2Book/allMids/clearinghouseState/orderStatus/
// spotClearinghouseState/exchangeStatus, 60 for userRole, 20 for every other info request.
//
// Every request is STUBBED, so running this costs Hyperliquid nothing and can be repeated
// freely. What it measures is the request PATTERN, which is what spends the budget.
//
//   node tests/hl-weight.mjs --wallets=10 --mode=all --settle=0     # cold load, combined
//   node tests/hl-weight.mjs --wallets=1  --mode=single             # steady state, one wallet
//
// --settle=0 measures from the moment the view opens (the burst that actually 429s);
// a non-zero --settle discards that and measures steady state instead.
import { chromium } from 'playwright'

const N = Number(process.argv.find(a => a.startsWith('--wallets='))?.split('=')[1] ?? 10)
const SECONDS = Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 90)
const MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] ?? 'all'

// HL's documented weights: 2 for these, 60 for userRole, 20 for every other info request.
const CHEAP = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus'])
const weightOf = (t) => t === 'userRole' ? 60 : CHEAP.has(t) ? 2 : 20

const wallets = Array.from({ length: N }, (_, i) =>
  '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20).slice(0, 40))

const EMPTY_MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const POS = (coin) => ({ position: { coin, szi: '1', entryPx: '100', positionValue: '100', unrealizedPnl: '5', returnOnEquity: '0', leverage: { type: 'cross', value: 3 }, marginUsed: '33', maxLeverage: 50, liquidationPx: '50', cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } }, type: 'oneWay' })
const STATE = { marginSummary: EMPTY_MARGIN, crossMarginSummary: EMPTY_MARGIN, crossMaintenanceMarginUsed: '10', withdrawable: '900', assetPositions: [POS('BTC')], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 86400000, '900'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 86400000, '0'], [Date.now(), '10']], vlm: '1000' }
const META = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }] }
const HIP3 = { universe: [{ name: 'xyz:SPCX', szDecimals: 2, maxLeverage: 10 }] }

const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, hold: '0', total: '100' }] },
  allMids: { BTC: '100', 'xyz:SPCX': '10' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [META, HIP3], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: META, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [META, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
}

const counts = new Map()   // "type" or "type|dex" -> n
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline' }))
await ctx.route('**hyperliquid**', (route) => {
  let body = {}
  try { body = JSON.parse(route.request().postData() || '{}') } catch {}
  const t = body.type || '(non-json)'
  const k = body.dex ? `${t} [dex]` : t
  counts.set(k, (counts.get(k) ?? 0) + 1)
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[t] ?? {} })
})
const p = await ctx.newPage()
await p.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' })
await p.evaluate(({ wallets }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('savedWallets', JSON.stringify(wallets.map((a, i) => ({ addr: a, label: 'W' + i }))))
}, { wallets })
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForTimeout(2500)
try { await p.evaluate(() => window.__pickLang('en')) } catch {}

if (MODE === 'all') {
  await p.evaluate(() => window.__goAllAccounts())
} else {
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, wallets[0])
}

const SETTLE = Number(process.argv.find(a => a.startsWith('--settle='))?.split('=')[1] ?? 25)
if (SETTLE) { await p.waitForTimeout(SETTLE * 1000); counts.clear() }
const t0 = Date.now()
await p.waitForTimeout(SECONDS * 1000)
const mins = (Date.now() - t0) / 60000

const rows = [...counts.entries()]
  .map(([k, n]) => {
    const t = k.replace(' [dex]', '')
    return { k, n, w: weightOf(t) * n, perMin: n / mins, wPerMin: weightOf(t) * n / mins }
  })
  .sort((a, b) => b.wPerMin - a.wPerMin)

console.log(`\n${MODE === 'all' ? 'ALL ACCOUNTS' : 'SINGLE ACCOUNT'} · ${N} wallets · ${Math.round(mins * 60)}s steady state\n`)
console.log('  weight/min   calls/min   endpoint')
for (const r of rows) console.log(`  ${String(Math.round(r.wPerMin)).padStart(9)}   ${r.perMin.toFixed(1).padStart(9)}   ${r.k}`)
const total = rows.reduce((s, r) => s + r.wPerMin, 0)
console.log(`  ${String(Math.round(total)).padStart(9)}   ${'—'.padStart(9)}   TOTAL  (HL budget is 1200/min per IP → ${Math.round(total / 1200 * 100)}%)`)
await b.close()
