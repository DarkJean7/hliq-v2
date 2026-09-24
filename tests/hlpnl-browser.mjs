// Net PnL is Hyperliquid's own all-time figure, not a rebuild of it.
//
// Reported on a closed account: Hyperliquid said −$3,443.12 and the Portfolio tab said
// −$3,022.32. The tab was adding up realized + unrealized + funding − fees, and two of those
// parts were short — funding read $0.00 for an idle account, and realized PnL comes from fills'
// closedPnl, which HL reports for PERPS only, so a loss taken on a spot sale never appeared.
//
// HL publishes the answer: `cumLedger` is every dollar ever paid in, and equity minus it is the
// all-time PnL on its own portfolio page — verified to the cent against three live wallets.
//
// The fixtures below are that reported account: $0 equity, $3,443.12 ever paid in, +$261.85
// realized, $3,284.17 of fees, no funding loaded.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

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

const CUM_LEDGER = 3443.12          // HL's own "net money in" for the account
const HL_PNL     = -CUM_LEDGER      // equity ($0) − that
const MARGIN = { accountValue: '0.0', totalNtlPos: '0.0', totalRawUsd: '0.0', totalMarginUsed: '0.0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '0.0', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 86400e3, '0.0'], [Date.now(), '0.0']],
                 pnlHistory: [[Date.now() - 86400e3, String(HL_PNL)], [Date.now(), String(HL_PNL)]], vlm: '7333773.87' }
// One closing fill carrying the account's realized PnL and its fees, so the parts are on
// screen and visibly do NOT add up to the whole — which is the point.
const FILL = {
  coin: 'BTC', px: '60000', sz: '0.1', side: 'A', time: Date.now() - 3600e3, startPosition: '0.1',
  dir: 'Close Long', closedPnl: '261.85', hash: '0x' + '0'.repeat(64), oid: 5150, crossed: true,
  fee: '3284.17', tid: 991, feeToken: 'USDC',
}
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: {}, frontendOpenOrders: [], userFills: [FILL], userFillsByTime: [FILL], userFunding: [],
  userNonFundingLedgerUpdates: [
    { time: Date.now() - 200 * 86400e3, hash: '0x1', delta: { type: 'deposit', usdc: '6586.85' } },
    { time: Date.now() - 100 * 86400e3, hash: '0x2', delta: { type: 'withdraw', usdc: '2564.16', fee: '1.0' } },
  ],
  subAccounts: [], candleSnapshot: [], extraAgents: [], allPerpMetas: [{ universe: [] }], outcomeMeta: {},
  perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: String(CUM_LEDGER) },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

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
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Old' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)

console.log(NL + '-- the Portfolio tab agrees with Hyperliquid --')
{
  await p.evaluate(() => window.mobVTab('portfolio'))
  const got = await waitFor(p, 'the portfolio rows', () => /Net PnL/.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 30000)
  const txt = (await p.evaluate(() => document.getElementById('mobVContent')?.textContent?.replace(/\s+/g, ' ') ?? ''))
  ok('the tab is there', got, txt.slice(0, 120))
  const row = (label) => (txt.match(new RegExp(label + '\\s*(\\+?-?\\$[\\d,.]+)')) ?? [])[1] ?? ''
  ok('Net PnL is HL\'s own all-time figure', row('Net PnL') === '-$3,443.12', row('Net PnL'))
  // The rebuild it replaced: 261.85 − 3284.17 = −3,022.32, which is what the tab used to show.
  ok('and NOT the itemised sum, which is short', row('Net PnL') !== '-$3,022.32')
  ok('the parts are still shown: realized', row('Realized PnL') === '+$261.85', row('Realized PnL'))
  ok('and fees', row('Total Fees') === '-$3,284.17', row('Total Fees'))
  ok('Net Deposited is HL\'s own cumLedger', /Net Deposited[^$]*\$3,443\.12/.test(txt), txt.match(/Net Deposited.{0,24}/)?.[0])
}

console.log(NL + '-- and so does the balance card --')
{
  await p.evaluate(() => window.mobVTab('home'))
  await waitFor(p, 'the card', () => !!document.getElementById('mobVUnrealPnl'))
  // The stat toggles between unrealized and net; make sure it is showing net.
  // The app's own toggle, not a poke at localStorage: _mobVRenderBalance is a module function
  // and not on window, so setting the key alone changed nothing and the stat stayed on
  // unrealized — which is how this first read "+$0.00".
  const label = () => p.evaluate(() => document.getElementById('mobVUnrealPnlLbl')?.textContent?.trim() ?? '')
  if (!/net/i.test(await label())) await p.evaluate(() => window.__mobVTogglePnlStat())
  await waitFor(p, 'the Net PnL stat', () => /net/i.test(document.getElementById('mobVUnrealPnlLbl')?.textContent ?? ''))
  const stat = await p.evaluate(() => document.getElementById('mobVUnrealPnl')?.textContent?.trim() ?? '')
  ok('the Net PnL stat reads the same figure', /3,443|3\.44K|-\$3\.4K/i.test(stat), stat)
}

console.log(NL + "-- All Accounts sums the wallets own figures --")
{
  // A second wallet: $500 equity against $700 ever paid in, so HL would say −$200 for it.
  // Combined with the first (−$3,443.12) the total must be exactly −$3,643.12 — and the
  // server's settled half is deliberately wrong here (+$1,000) to prove it is not being used.
  const W2 = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
  const M2 = { accountValue: '500.0', totalNtlPos: '0.0', totalRawUsd: '500.0', totalMarginUsed: '0.0' }
  const S2 = { marginSummary: M2, crossMarginSummary: M2, crossMaintenanceMarginUsed: '0', withdrawable: '500.0', assetPositions: [], time: Date.now() }
  const W2WIN = { accountValueHistory: [[Date.now() - 86400e3, '500.0'], [Date.now(), '500.0']],
                  pnlHistory: [[Date.now() - 86400e3, '-200'], [Date.now(), '-200']], vlm: '0' }
  const ctx2 = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  try { await ctx2.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx2.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    const two = String(b.user ?? '').toLowerCase() === W2
    if (two) {
      const T = { ...HL, clearinghouseState: S2, webData2: { clearinghouseState: S2, openOrders: [], cumLedger: '700' },
                  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, W2WIN]), userFills: [], userFillsByTime: [],
                  userNonFundingLedgerUpdates: [{ time: Date.now() - 50 * 86400e3, hash: '0x9', delta: { type: 'deposit', usdc: '700' } }] }
      return route.fulfill({ status: 200, contentType: 'application/json', json: T[b.type] ?? {} })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  // The server's combined snapshot, with a settled half that is plainly wrong.
  await ctx2.route('**/api/combined', (route) => route.fulfill({ status: 200, json: {
    updatedAt: Date.now(), accountValue: 500, perpBase: 500, dayAgo: 500, wallets: 2, missing: [], books: {},
    settledPnl: 1000, realizedPnl: 1000, fees: 0, funding: 0, unrealBase: 0, pnlWallets: 2, perWallet: {},
  } }))
  await ctx2.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx2.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
  const q = await ctx2.newPage()
  q.on('pageerror', e => errs.push('combined: ' + e.message))
  await q.goto(BASE, { waitUntil: 'domcontentloaded' })
  await q.evaluate(({ a, b }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Old' }, { addr: b, label: 'Two' }]))
  }, { a: ADDR, b: W2 })
  await q.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(q, 'boot', () => !!window.loadDashboard)
  await q.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(q, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(q, 'the mobile shell', () => !!window.mobVTab, null, 30000)
  await q.evaluate(() => { window.__goAllAccounts?.(); return true })
  const inAll = await waitFor(q, 'All Accounts', () => /All Accounts/i.test(document.body.textContent ?? ''), null, 40000)
  ok('the combined view is up', inAll)
  await q.evaluate(() => window.mobVTab('portfolio'))
  const got = await waitFor(q, 'the combined Net PnL', () => /-\$3,643\.12/.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 45000)
  const txt = await q.evaluate(() => document.getElementById('mobVContent')?.textContent?.replace(/\s+/g, ' ') ?? '')
  ok("Net PnL is the two wallets own figures added up", got, (txt.match(/Net PnL.{0,20}/) ?? [])[0])
  ok("not the server settled half (+$1,000)", !/\+\$1,000/.test(txt))
  ok("and Net Deposited is their cumLedgers added up", /Net Deposited[^$]*\$4,143\.12/.test(txt), (txt.match(/Net Deposited.{0,24}/) ?? [])[0])
  await ctx2.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
