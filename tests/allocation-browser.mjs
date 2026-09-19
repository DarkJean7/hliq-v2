// The allocation wheel has to add up to the account.
//
// Reported as: "the whole all accounts equity is ~6,8k but in allocation it totals to just
// ~2,7k. the missing equity is in orders, spot. add them."
//
// It totalled two things — margin behind open positions, and free cash — and on a real
// account that is a minority of it. Margin held by a resting order is gone from
// `withdrawable` (so it is not free) and absent from every position's `marginUsed` (so it is
// not used), and spot tokens were never counted at all. Measured on one live wallet at the
// time: $710.05 in orders and $413.60 in spot out of $1,664 — two thirds of the account,
// invisible on the screen whose one job is to say where the money is.
//
// This needs a browser because the numbers come from four sources that only meet in the
// renderer: the clearinghouse state, the open orders, the spot balances and the mids.
//
// Hermetic — every figure below is derivable from the fixtures:
//
//   positions   BTC     $200.00 margin      (1 long, $2,000 notional at 10x)
//   orders      SOL     $100.00 reserved    (2 buys, $1,000 notional at 10x)
//               BTC      $50.00 reserved    (1 buy,   $500 notional at 10x)
//   spot        HYPE    $150.00             (2 @ $75)
//               KNTQ     $20.00             (100 @ $0.20)
//   free                 $30.00             (perp withdrawable $25 + unheld spot USDC $5)
//   ──────────────────────────────────────
//   total               $550.00
//
// The perp side is stated to agree: accountValue 350 = 200 posted + 150 reserved + 25
// withdrawable... and the residual the app reads is 350 - 200 - 25 = 125. Deliberately NOT
// 150, so the reconciliation is exercised rather than accidentally matching.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const NL   = String.fromCharCode(10)
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

const POS = {
  position: {
    coin: 'BTC', szi: '0.02', entryPx: '100000', positionValue: '2000', unrealizedPnl: '0',
    marginUsed: '200', leverage: { type: 'cross', value: 10 }, maxLeverage: 40,
    returnOnEquity: '0', liquidationPx: '50000', cumFunding: { allTime: '0' },
  },
}
// accountValue - totalMarginUsed - withdrawable = 350 - 200 - 25 = 125 reserved by orders.
const MARGIN = { accountValue: '350', totalNtlPos: '2000', totalRawUsd: '350', totalMarginUsed: '200' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '20', withdrawable: '25', assetPositions: [POS], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'SOL', szDecimals: 2, maxLeverage: 20 }]

// Two resting buys on SOL (no position — a coin the wheel could not previously show at all),
// one on BTC, and one reduce-only that must post nothing.
const ORDERS = [
  { coin: 'SOL', side: 'B', sz: '5',    limitPx: '100', oid: 1, timestamp: Date.now(), origSz: '5',    orderType: 'Limit', reduceOnly: false, isTrigger: false },
  { coin: 'SOL', side: 'B', sz: '5',    limitPx: '100', oid: 2, timestamp: Date.now(), origSz: '5',    orderType: 'Limit', reduceOnly: false, isTrigger: false },
  { coin: 'BTC', side: 'B', sz: '0.005', limitPx: '100000', oid: 3, timestamp: Date.now(), origSz: '0.005', orderType: 'Limit', reduceOnly: false, isTrigger: false },
  { coin: 'BTC', side: 'A', sz: '0.02', limitPx: '120000', oid: 4, timestamp: Date.now(), origSz: '0.02', orderType: 'Limit', reduceOnly: true,  isTrigger: false },
]
const SPOT = { balances: [
  { coin: 'USDC', token: 0,   hold: '10', total: '15' },     // $5 unheld
  { coin: 'HYPE', token: 150, hold: '0',  total: '2',   entryNtl: '100' },
  { coin: 'KNTQ', token: 300, hold: '0',  total: '100', entryNtl: '0' },
] }
const SPOT_META = {
  tokens: [{ index: 150, name: 'HYPE' }, { index: 0, name: 'USDC' }, { index: 300, name: 'KNTQ' }],
  universe: [{ name: '@107', index: 107, tokens: [150, 0] }, { name: '@334', index: 334, tokens: [300, 0] }],
}
const CTX = { funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: SPOT,
  allMids: { BTC: '100000', SOL: '100', '@107': '75', '@334': '0.20' },
  frontendOpenOrders: ORDERS, userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: ORDERS },
  meta: { universe: UNIVERSE }, spotMeta: SPOT_META,
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX, CTX]],
}

// WebSockets are NOT covered by ctx.route, and the app opens one to Hyperliquid for live
// state. Left alone it delivers real prices straight past every fixture here — which is how a
// stubbed KNTQ at $0.26438 once rendered as $0.2872, drifting between runs.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
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
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.waitForTimeout(1800)

await p.evaluate(() => window.mobVTab('allocation'))
await waitFor(p, 'the wheel', () => !!document.getElementById('allocCenter'))
await p.waitForTimeout(600)

const parts = () => p.evaluate(() => window.__allocParts?.() ?? null)
const text  = () => p.evaluate(() => document.getElementById('mobVContent')?.innerText ?? '')

console.log(NL + '-- the wheel counts every place the money is --')
{
  const r = await parts()
  const r2 = (x) => Math.round(x * 100) / 100
  t('margin behind positions', r2(r.used), 200)
  // The residual the account reports (350 - 200 - 25 = 125), not the per-order estimate of
  // 150. The estimate is only there to say WHICH coin; the account says how much.
  t('margin reserved by resting orders', r2(r.orders), 125)
  t('spot holdings, priced by their pair', r2(r.spot), 170)
  t('free = perp withdrawable + unheld spot USDC', r2(r.free), 30)
  t('and the total is all four', r2(r.total), 525)
  t('which is the parts, not a separate sum', r2(r.used + r.orders + r.spot + r.free), r2(r.total))
}

console.log(NL + '-- and says so on screen --')
{
  const txt = await text()
  t('the centre no longer calls itself total MARGIN', /TOTAL EQUITY/i.test(txt), true)
  t('the total is the one the parts add to', /\$525\.00/.test(txt), true)
  t('positions are named in the split', /in positions/.test(txt), true)
  t('so are orders', /in orders/.test(txt), true)
  t('and spot', /\bspot\b/i.test(txt), true)
}

console.log(NL + '-- a coin with orders and no position gets a row --')
{
  const rows = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-v-row')]
    .map(r => r.innerText.replace(/\s+/g, ' ')))
  const sol = rows.find(r => /^SOL/.test(r))
  t('SOL is on the wheel at all', !!sol, true)
  // It has no position, so it must not claim one.
  t('and it does not invent a direction', !/Long|Short/.test(sol ?? ''), true)
  t('it says how many orders instead', /2 orders/.test(sol ?? ''), true)
  const btc = rows.find(r => /^BTC/.test(r))
  t('a coin with both shows both', /Long/.test(btc ?? '') && /1 order/.test(btc ?? ''), true)
}

console.log(NL + '-- spot is its own row, even for a coin also held as a perp --')
{
  const rows = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-v-row')]
    .map(r => r.innerText.replace(/\s+/g, ' ')))
  t('HYPE spot is there', rows.some(r => /HYPE/.test(r) && /Spot/.test(r)), true)
  t('KNTQ too, priced through its pair', rows.some(r => /KNTQ/.test(r) && /\$20\.00/.test(r)), true)
  // USDC is cash and is already the free-margin slice; a second row for it would be the same
  // dollars twice.
  t('spot USDC is not double-counted as a holding',
    rows.filter(r => /^USDC/.test(r) && /Spot/.test(r)).length, 0)
}

await browser.close()
console.log(NL + 'errors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
