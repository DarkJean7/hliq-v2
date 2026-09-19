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
const NL = String.fromCharCode(10)
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
// Balances arrive keyed by TOKEN NAME. HYPE also has a perp; KNTQ does not — which is the
// difference that made one look right and the other show a dash.
const SPOT = { balances: [
  { coin: 'HYPE', token: 150, hold: '0', total: '1.5',   entryNtl: '130' },
  { coin: 'KNTQ', token: 300, hold: '0', total: '199.8', entryNtl: '40' },
  { coin: 'USDC', token: 0,   hold: '0', total: '50',    entryNtl: '0' },
] }
const SPOT_META = {
  tokens: [{ index: 150, name: 'HYPE' }, { index: 0, name: 'USDC' }, { index: 300, name: 'KNTQ' }],
  universe: [
    { name: '@107', index: 107, tokens: [150, 0] },   // HYPE/USDC
    { name: '@334', index: 334, tokens: [300, 0] },   // KNTQ/USDC
  ],
}

let spotMetaCalls = 0, failFirstSpotMeta = true
const HL = () => ({
  clearinghouseState: STATE, spotClearinghouseState: SPOT,
  // The pair mids, plus a HYPE PERP at a DIFFERENT price. Pricing a spot holding off the perp
  // is the bug; the assertions below are that the spot pair wins.
  allMids: { BTC: '100', HYPE: '92.9235', '@107': '92.881', '@334': '0.26438' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: SPOT_META,
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
})

// WebSockets are NOT covered by ctx.route, and the combined view opens one to Hyperliquid for
// live state. Left alone it delivers real prices straight past every fixture here — which is
// how a stubbed KNTQ at $0.26438 rendered as $0.2872, drifting between runs. Closed, so the
// app falls back to the REST path the fixtures actually govern.
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
t('it renders its rows', rows, 3)
t('and threw nothing', errs.filter(e => /toFixed/.test(e)), [])

console.log(NL + '-- a spot holding is priced through its PAIR, not its name --')
{
  const txt = await p.evaluate(() => document.getElementById('mobVContent')?.innerText ?? '')
  // KNTQ has no perp. Its price exists only under its pair id, and that is the whole report.
  t('KNTQ is priced', /0\.264/.test(txt), true)
  t('and its value is shown, not a dash', /\$52\./.test(txt), true)
  // HYPE has a perp at 92.9235 and a spot pair at 92.881. The holding is SPOT.
  t('HYPE uses its spot pair', /92\.88/.test(txt), true)
  t('not the perp of the same name', !/92\.9235/.test(txt), true)
}

console.log(NL + '-- the strip says HYPE, not @107 --')
{
  await waitFor(p, 'the strip', () => !!document.querySelector('.mob-watch-cell'), 20000)
  const strip = await p.evaluate(() => [...document.querySelectorAll('.mob-watch-cell')]
    .map(c => c.innerText.replace(/\s+/g, ' ')).join(' | '))
  t('the chip is named', /HYPE/.test(strip), true)
  t('and no raw pair id is left on it', !/@107/.test(strip), true)
  // Real artwork needs the icon map, which needs a network this test deliberately does not
  // have. What IS checkable offline is that the icon resolves the pair to its token first:
  // the letter avatar reads HYP, not @10.
  const ic = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.mob-watch-cell')].find(x => /HYPE/.test(x.innerText))
    const img = c?.querySelector('img')
    return img ? 'img:' + (img.src || '').slice(0, 4) : (c?.querySelector('.mob-watch-cell-ic')?.innerText ?? '').trim()
  })
  t('the icon resolves the pair to its token — HYP, not @10', /^(img:http|HYP)/.test(ic), true)
}

console.log(NL + '-- and the same tab in ALL ACCOUNTS --')
{
  // The combined view has its OWN copy of the spot renderer (renderSpotGroup). The
  // single-account one was fixed first and this was missed, so "spot tab is not working in
  // all accounts" was the same null .toFixed() all over again, one function along.
  await p.evaluate(() => {
    const w = [{ addr: '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159', label: 'One' },
               { addr: '0x84Ceb6127A07bf6c7234470F4ca8563DeEDc7c6F', label: 'Two' }]
    localStorage.setItem('savedWallets', JSON.stringify(w))
  })
  await p.evaluate(() => window.__goAllAccounts())
  await waitFor(p, 'the combined view', () => !!window.__getTradeAcct?.() || !!document.body.innerText.match(/All Accounts/i), 45000)
  await p.waitForTimeout(2500)
  const before = errs.length
  await p.evaluate(() => window.mobVTab('spot'))
  await p.waitForTimeout(2000)
  t('the tab opens without throwing', errs.slice(before).filter(e => /toFixed/.test(e)), [])
  const txt = await p.evaluate(() => document.getElementById('mobVContent')?.innerText ?? '')
  t('and it drew something', txt.length > 0, true)
  // Grouped rows price through the pair too, so KNTQ is not a dash here either.
  if (/KNTQ/.test(txt)) t('KNTQ is priced in the combined view', /0\.264/.test(txt), true)
}

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
