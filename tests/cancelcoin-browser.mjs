// "Cancel all 8 HYPE buys" — driven in the real app, both shells.
//
// The source suite (tests/suites/cancelcoin.test.mjs) proves the selection and the
// response-reading. This proves the button exists where the user is looking, says the right
// number, and sends exactly the orders it named — the parts no source read can show.
//
// Hermetic: the exchange is stubbed, so the cancel is signed for real by a throwaway key and
// then intercepted instead of sent. Nothing reaches Hyperliquid.
//
// Run:  npm run test:browser:cancel      (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/`
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

// Eight HYPE buy rungs, two HYPE sells, and one BTC order that must survive.
const ORDERS = [
  ...Array.from({ length: 8 }, (_, i) => ({ coin: 'HYPE', side: 'B', limitPx: String(40 - i), sz: '1', oid: 100 + i, timestamp: Date.now(), origSz: '1', orderType: 'Limit', reduceOnly: false, isTrigger: false, triggerPx: '0.0', triggerCondition: 'N/A' })),
  ...Array.from({ length: 2 }, (_, i) => ({ coin: 'HYPE', side: 'A', limitPx: String(60 + i), sz: '1', oid: 200 + i, timestamp: Date.now(), origSz: '1', orderType: 'Limit', reduceOnly: false, isTrigger: false, triggerPx: '0.0', triggerCondition: 'N/A' })),
  { coin: 'BTC', side: 'B', limitPx: '90', sz: '0.1', oid: 999, timestamp: Date.now(), origSz: '0.1', orderType: 'Limit', reduceOnly: false, isTrigger: false, triggerPx: '0.0', triggerCondition: 'N/A' },
]

const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }, { name: 'HYPE', szDecimals: 2, maxLeverage: 10 }]
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: { BTC: '100', HYPE: '50' },
  frontendOpenOrders: ORDERS, userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: ORDERS },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, UNIVERSE.map(() => ({ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }))],
}

// The exchange, matched on the HOST. A `**hyperliquid**` glob also matches the SDK's own
// module files, which the dev server serves per-file from node_modules — the page then gets
// JSON where it expected JavaScript and never boots.
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

const cancels = []   // every cancel payload the app tried to send
const setup = async (ctx) => {
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route(HL_HOST, (route) => {
    let body = {}
    try { body = JSON.parse(route.request().postData() || '{}') } catch {}
    if (body.action?.type === 'cancel') {
      cancels.push(body.action.cancels.map(c => c.o))
      return route.fulfill({ status: 200, contentType: 'application/json',
        json: { status: 'ok', response: { type: 'cancel', data: { statuses: body.action.cancels.map(() => 'success') } } } })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[body.type] ?? {} })
  })
}
const seed = async (p) => {
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ a, k }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, { a: ADDR, k: KEY })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  try { await p.evaluate(() => window.__pickLang('en')) } catch {}
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  // Loaded means the orders themselves are in, not merely that the shell painted.
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'), 25000)
  await waitFor(p, 'the orders', () => (document.getElementById('ordCount')?.textContent ?? '0') !== '0' ||
    !!document.getElementById('ordersTbody')?.children.length ||
    document.body.innerText.includes('HYPE'), 25000)
  await p.waitForTimeout(1200)
}

// WebSockets are NOT covered by ctx.route, and the combined view opens one to Hyperliquid for
// live state. Left alone it delivers real prices straight past every fixture here — which is
// how a stubbed KNTQ at $0.26438 rendered as $0.2872, drifting between runs. Closed, so the
// app falls back to the REST path the fixtures actually govern.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const browser = await chromium.launch()
const errs = []

// ─── mobile, the primary surface ──────────────────────────────────────────────
{
  const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  await blockHlSockets(ctx)
  await setup(ctx)
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push('mobile: ' + e.message))
  await seed(p)

  await p.evaluate(() => window.mobVTab('orders'))   // Orders is a strip tab under Home, not a bottom-nav tab
  await waitFor(p, 'the orders tab', () => document.body.innerText.includes('HYPE'))

  // Expand the HYPE buy group, the way a finger would.
  const opened = await p.evaluate(() => {
    const row = [...document.querySelectorAll('.mob-v-row')].find(r => r.innerText.includes('HYPE') && r.innerText.includes('×8'))
    if (!row) return false
    row.click(); return true
  })
  t('the HYPE ladder is grouped into one row', opened, true)
  await p.waitForTimeout(500)

  const btn = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Cancel all \d+ HYPE (buys|sells)/.test(x.textContent))
    return b ? b.textContent.trim().replace(/\s+/g, ' ') : null
  })
  // Eight, not ten: the two HYPE sells are the other side of the book and stay. A ladder
  // usually has a position resting against it, and taking both sides removes the exits.
  t('the button offers that side of the asset', btn, 'Cancel all 8 HYPE buys')

  await p.evaluate(() => {
    const iv = setInterval(() => {
      const y = document.getElementById('_acY')   // _appConfirm's yes button
      if (y) { y.click(); clearInterval(iv) }
    }, 80)
    const b = [...document.querySelectorAll('button')].find(x => /Cancel all \d+ HYPE (buys|sells)/.test(x.textContent))
    b.click()
  })
  await p.waitForTimeout(2500)

  const sent = cancels.flat().sort((a, b) => a - b)
  t('exactly the eight HYPE buys were cancelled', sent, [100, 101, 102, 103, 104, 105, 106, 107])
  t('the two HYPE sells survived', sent.some(x => x === 200 || x === 201), false)
  t('and the BTC order was not touched', sent.includes(999), false)

  await ctx.close()
}

// ─── desktop ──────────────────────────────────────────────────────────────────
cancels.length = 0
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await blockHlSockets(ctx)
  await setup(ctx)
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push('desktop: ' + e.message))
  await seed(p)

  const labels = await p.evaluate(() => {
    const tb = document.getElementById('ordersTbody')
    return [...(tb?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim().replace(/\s+/g,' ')).filter(x => x.startsWith('✕ All'))
  })
  // The eight buys offer it (8 rows); the two sells offer it to each other (2 rows); the lone
  // BTC order has no siblings on its side and gets nothing.
  t('every row whose side has siblings offers it', labels.length, 10)
  t('and each names its own side and count', [...new Set(labels)].sort(), ['✕ All 2 sells', '✕ All 8 buys'])

  await ctx.close()
}

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
