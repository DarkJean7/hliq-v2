// A paper account's Net PnL is its own: equity less what was paid INTO THAT PAPER ACCOUNT.
//
// Reported: a paper account worth $1,003 showed Net PnL -$2.7K. Net PnL is equity less
// webData.cumLedger (what Hyperliquid says was paid in); a paper account has no webData2, so the
// figure kept the LAST REAL ACCOUNT's cumLedger — a real wallet's $3,700 of deposits taken off a
// paper account's $1,003. Nothing in either function was wrong alone; it needs the switch.
//
// Hermetic: a real account with cumLedger $3,700, then a paper account with $1,000 paid in and
// $1,003.38 of equity. The answer is +$3.38, and must not be -$2,696.62.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

const now = Date.now(), HR = 36e5
const WINDOW = { accountValueHistory: [[now - HR, '1580'], [now, '1580']], pnlHistory: [[now - HR, '-2120'], [now, '-2120']], vlm: '0' }
const MARGIN = { accountValue: '1580', totalNtlPos: '0', totalRawUsd: '1580', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1580', assetPositions: [], time: now }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }]
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '100' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [],
  subAccounts: [], candleSnapshot: [], extraAgents: [], allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  // The real wallet: $3,700 paid in over its life, $1,580 now.
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '3700' },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
}

const netPnl = (p) => p.evaluate(() => {
  // The phone: the equity card's stat tile (the one in the report's screenshot).
  const tile = document.getElementById('mobVUnrealPnl')
  if (tile?.offsetParent && /Net PnL/.test(document.getElementById('mobVUnrealPnlLbl')?.textContent ?? '')) return 'Net PnL ' + tile.textContent.trim()
  // The label is "Net PnL" alone on desktop, and "Net PnL" with an icon beside it on the phone.
  const label = [...document.querySelectorAll('*')].find(e => e.offsetParent && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().startsWith('Net PnL')))
  let card = label?.parentElement
  for (let i = 0; i < 3 && card && !/\$/.test(card.textContent); i++) card = card.parentElement
  return card?.textContent.replace(/\s+/g, ' ').trim() ?? null
})

for (const [label, opts] of [['desktop', { viewport: { width: 1500, height: 950 } }], ['mobile', { viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true }]]) {
  console.log('\n-- ' + label + ' --')
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/paper/sync', r => r.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } }))
  await ctx.route(HL_HOST, (route) => {
    let body = {}
    try { body = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[body.type] ?? {} })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate((a) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
    // The phone's stat tile set to Net PnL (its ⇄), as it was in the report.
    localStorage.setItem('hliq_mobv_pnlstat', 'net')
    // A paper account: $1,000 paid in, $1,003.38 now, nothing open.
    localStorage.setItem('hliq_paper_v2', JSON.stringify({ balance: 1003.38, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: Date.now() - 86400e3 }))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  // The real account first, so its cumLedger is loaded: $1,580 − $3,700.
  const real = await waitFor(p, 'the real Net PnL', async () => true) && await (async () => { for (let i = 0; i < 60; i++) { const t = await netPnl(p); if (t && /-\$2[.,]1/.test(t)) return t; await p.waitForTimeout(250) } return await netPnl(p) })()
  ok('the real account shows its own: $1,580 less $3,700 paid in', /-\$2[.,]1/.test(real ?? ''), real)
  await p.evaluate(() => window.__goPaper('main'))
  let paper = null
  for (let i = 0; i < 60; i++) { paper = await netPnl(p); if (paper && /\+\$3\.38/.test(paper)) break; await p.waitForTimeout(250) }
  ok('the paper account shows ITS own: $1,003.38 less the $1,000 paid into it = +$3.38', /\+\$3\.38/.test(paper ?? ''), paper)
  ok('not the real wallet\'s deposits taken off a paper balance', !/-\$2[.,]6|-\$2\.7K/.test(paper ?? ''), paper)
  ok('no page errors', !errs.length, errs)
  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
