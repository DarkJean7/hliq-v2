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
//   node tests/hl-weight.mjs --wallets=1  --analysis=6 --settle=0   # ...then browse 6 markets
//
// --analysis=N opens Support & resistance and taps N market chips, a few seconds apart, the
// way someone comparing markets does. Each new market is a cold read of three timeframes plus
// the book at three aggregations, and that is the shape a user reported being throttled by.
//
// --settle=0 measures from the moment the view opens (the burst that actually 429s);
// a non-zero --settle discards that and measures steady state instead.
import { chromium } from 'playwright'

const N = Number(process.argv.find(a => a.startsWith('--wallets='))?.split('=')[1] ?? 10)
const SECONDS = Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 90)
const MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] ?? 'all'
// Hyperliquid answers in roughly this long. An instant stub makes every request finish before
// the next one is asked for, so nothing is ever in flight — and a fix that abandons in-flight
// work then measures as doing nothing at all. Latency is part of the request pattern.
const LATENCY = Number(process.argv.find(a => a.startsWith('--latency='))?.split('=')[1] ?? 180)

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
// Candles have to be non-empty: three empty timeframes read as "there is no such market", and
// the view then skips the order book — measuring a quarter of what a real market costs.
const CANDLES = Array.from({ length: 300 }, (_, i) => ({
  t: Date.now() - (300 - i) * 36e5, T: Date.now() - (299 - i) * 36e5, s: 'BTC', i: '4h',
  o: '100', c: '101', h: '102', l: '99', v: '10', n: 5,
}))
const BOOK = { coin: 'BTC', time: Date.now(), levels: [
  Array.from({ length: 20 }, (_, i) => ({ px: String(100 - i * 0.1), sz: '5', n: 2 })),
  Array.from({ length: 20 }, (_, i) => ({ px: String(101 + i * 0.1), sz: '5', n: 2 })),
] }
const HIP3 = { universe: [{ name: 'xyz:SPCX', szDecimals: 2, maxLeverage: 10 }] }

const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, hold: '0', total: '100' }] },
  allMids: { BTC: '100', 'xyz:SPCX': '10' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: CANDLES, extraAgents: [],
  l2Book: BOOK,
  allPerpMetas: [META, HIP3], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: META, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [META, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
}

const counts = new Map()   // "type" or "type|dex" -> n
// Every request, stamped. The average over a minute is not what trips Hyperliquid — the
// limiter is a bucket that refills at roughly 20 weight a second, so 1200 spread evenly is
// fine and 1200 in the first eight seconds is not. Without this the tool could not tell those
// apart, and could not show whether spreading a burst had helped.
const stamps = []   // { at, w }
const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline' }))
// Host-matched: a `**hyperliquid**` glob also catches the SDK's own module files in dev.
await ctx.route(/^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i, (route) => {
  let body = {}
  try { body = JSON.parse(route.request().postData() || '{}') } catch {}
  const t = body.type || '(non-json)'
  const k = body.dex ? `${t} [dex]` : t
  counts.set(k, (counts.get(k) ?? 0) + 1)
  stamps.push({ at: Date.now(), w: weightOf(t) })
  const send = () => route.fulfill({ status: 200, contentType: 'application/json', json: HL[t] ?? {} })
  return LATENCY ? new Promise(r => setTimeout(() => r(send()), LATENCY)) : send()
})
const p = await ctx.newPage()
await p.goto('http://localhost:5175/app', { waitUntil: 'domcontentloaded' })
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

// Browse markets in the Analysis tab, as a person comparing them would. Done BEFORE the
// settle window so --settle=0 catches the burst and a non-zero settle measures what the tab
// costs once it is just sitting there.
const ANALYSIS = Number(process.argv.find(a => a.startsWith('--analysis='))?.split('=')[1] ?? 0)
if (ANALYSIS) {
  await p.waitForTimeout(3000)
  await p.evaluate(() => window.switchTab('analysis'))
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'ARB', 'PYTH', 'AVAX', 'LINK']
  // --tap=MS is how fast they are tapped. The default is someone scanning a list, which is
  // when the app is most likely to be loading a market nobody is looking at any more.
  const TAP = Number(process.argv.find(a => a.startsWith('--tap='))?.split('=')[1] ?? 1200)
  for (let i = 0; i < ANALYSIS; i++) {
    await p.waitForTimeout(TAP)
    await p.evaluate((c) => {
      const inp = document.getElementById('anaZInput')
      if (!inp) return
      inp.value = c
      inp.form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    }, coins[i % coins.length])
  }
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

console.log(`\n${MODE === 'all' ? 'ALL ACCOUNTS' : 'SINGLE ACCOUNT'}${ANALYSIS ? ` · ANALYSIS ×${ANALYSIS}` : ''} · ${N} wallets · ${Math.round(mins * 60)}s steady state\n`)
console.log('  weight/min   calls/min   endpoint')
for (const r of rows) console.log(`  ${String(Math.round(r.wPerMin)).padStart(9)}   ${r.perMin.toFixed(1).padStart(9)}   ${r.k}`)
const total = rows.reduce((s, r) => s + r.wPerMin, 0)
console.log(`  ${String(Math.round(total)).padStart(9)}   ${'—'.padStart(9)}   TOTAL  (HL budget is 1200/min per IP → ${Math.round(total / 1200 * 100)}%)`)

// ── what actually trips the limiter ──────────────────────────────────────────
//
// HL's budget behaves like a bucket refilling at ~20 weight/second. An average of 1200/min
// spread evenly never empties it; the same 1200 arriving in the first eight seconds does, and
// the 429s that follow starve order placement, not just the dashboard. So the number that
// matters is the worst WINDOW, not the mean — and a fix that spreads a burst without removing
// any requests moves the peak while leaving the average exactly where it was.
const windowPeak = (ms) => {
  let peak = 0
  for (let i = 0; i < stamps.length; i++) {
    let sum = 0
    for (let j = i; j < stamps.length && stamps[j].at - stamps[i].at < ms; j++) sum += stamps[j].w
    if (sum > peak) peak = sum
  }
  return peak
}
const peak60 = windowPeak(60_000)
const peak10 = windowPeak(10_000)
console.log('')
console.log(`  peak in any 60s window: ${String(Math.round(peak60)).padStart(5)}   (${Math.round(peak60 / 1200 * 100)}% of the budget)`)
// 200 is what the bucket refills in ten seconds, so a ten-second burst above it is drawing
// the bucket down faster than it fills.
console.log(`  peak in any 10s window: ${String(Math.round(peak10)).padStart(5)}   (refill over 10s is ~200)`)
console.log(`  requests: ${stamps.length}, first ${stamps.length ? ((stamps.at(-1).at - stamps[0].at) / 1000).toFixed(1) : 0}s apart`)
await b.close()
