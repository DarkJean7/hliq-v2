// The Spot tab, and the "@107" that should say HYPE.
//
// Reported together, and they share a cause: "look at how the hype card was replaced with
// @107 and no icon… also the spot tab also broke, now is not acessible, it gives console
// error." The error was `Cannot read properties of null (reading 'toFixed')`.
//
//   1. A holding the market is not quoting has roi/pnl = null, but the detail grid guarded
//      on `cost > 0` — a different condition — and called roi.toFixed() on the null.
//   2. ensureSpotMeta() returned early on `if (_watchSpotNameMap)` while its own catch set
//      that map to {}. Truthy. So one failed spotMeta call — a 429 is enough — left every
//      spot holding reading "@107" for the rest of the session, with nothing ever retrying.
//
// Run:  npm run test:browser     (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

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

const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }]
// @107 is HYPE spot: bought for $130, and NOT in allMids — the exact shape that crashed.
const SPOT = { balances: [
  { coin: '@107', token: 107, hold: '0', total: '1.5', entryNtl: '130' },
  { coin: 'USDC', token: 0,   hold: '0', total: '50',  entryNtl: '0' },
] }
const SPOT_META = { tokens: [{ index: 150, name: 'HYPE' }, { index: 0, name: 'USDC' }],
                    universe: [{ name: '@107', index: 107, tokens: [150, 0] }] }

let spotMetaCalls = 0, failFirstSpotMeta = true
const HL = () => ({
  clearinghouseState: STATE, spotClearinghouseState: SPOT,
  allMids: { BTC: '100' },                      // deliberately no price for @107
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: SPOT_META,
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
})

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let body = {}
  try { body = JSON.parse(route.request().postData() || '{}') } catch {}
  // The first spotMeta is rate-limited, the way it would be on a busy load. Nothing may
  // depend on the first one succeeding.
  if (body.type === 'spotMeta') {
    spotMetaCalls++
    if (failFirstSpotMeta) { failFirstSpotMeta = false; return route.fulfill({ status: 429, body: 'rate limited' }) }
  }
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL()[body.type] ?? {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  localStorage.setItem('hliq_watchlist', JSON.stringify(['@107']))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.waitForTimeout(1500)

console.log('\n-- the Spot tab opens at all --')
await p.evaluate(() => window.mobVTab('spot'))
await p.waitForTimeout(1500)
const rows = await p.evaluate(() => document.querySelectorAll('#mobVContent .mob-v-row').length)
t('it renders its rows', rows, 2)
t('and threw nothing', errs.filter(e => /toFixed/.test(e)), [])

console.log('\n-- a holding with no price says so, instead of crashing --')
await p.evaluate(() => {
  const r = [...document.querySelectorAll('#mobVContent .mob-v-row')]
    .find(x => /HYPE|@107/.test(x.innerText))
  r?.click()
})
await p.waitForTimeout(600)
const detail = await p.evaluate(() => document.getElementById('mobVContent')?.innerText ?? '')
t('the cost is still shown — the ledger knows it', /cost/i.test(detail), true)   // CSS uppercases the labels
t('and the profit says why it cannot be worked out', /No price for this market yet/.test(detail), true)
t('no ROI is invented', !/bROIb/i.test(detail), true)

console.log('\n-- and a rate-limited spotMeta is retried, not cached forever --')
t('the first call was refused', spotMetaCalls >= 1, true)
await waitFor(p, 'the name map to fill', () => !!document.body.innerText.match(/HYPE/), 20000)
t('it asked again', spotMetaCalls >= 2, true)
t('and the holding is named, not "@107"', /HYPE/.test(await p.evaluate(() => document.getElementById('mobVContent')?.innerText ?? '')), true)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
