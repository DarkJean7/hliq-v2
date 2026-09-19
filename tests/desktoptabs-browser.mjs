// The desktop Overview panel: a Spot tab, and choices that survive a reload.
//
// Reported together: "in the image add spot tab in desktop, like we have in mobile, also make
// sure that when the app is reloaded the selected sort (side, size, pnl, etc) is kept and does
// not reset (it works in mobile, not in desktop)."
//
// Mobile has persisted its sort since it shipped — mobPosSortBy / mobPosSortDir — and desktop
// simply never did, so every refresh threw the reader back to PnL-descending. Most annoying
// for whoever sorts by Market or Liq. Price precisely because they are watching one thing
// across reloads.
//
// A browser is the only place to test either: the tab is built by render.js from live state,
// and "survives a reload" is not a property any single function's source has.
//
// Hermetic — one BTC position, two spot tokens, one resting order.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

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

const POS = (coin, szi, mark) => ({
  position: {
    coin, szi: String(szi), entryPx: String(mark), positionValue: String(Math.abs(szi) * mark),
    unrealizedPnl: '0', marginUsed: '100', leverage: { type: 'cross', value: 10 }, maxLeverage: 40,
    returnOnEquity: '0', liquidationPx: '1', cumFunding: { allTime: '0' },
  },
})
const MARGIN = { accountValue: '1000', totalNtlPos: '3000', totalRawUsd: '1000', totalMarginUsed: '200' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '20',
                 withdrawable: '700', assetPositions: [POS('BTC', 0.02, 100000), POS('SOL', 10, 100)], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'SOL', szDecimals: 2, maxLeverage: 20 }]
const SPOT = { balances: [
  { coin: 'USDC', token: 0,   hold: '0', total: '50' },
  { coin: 'HYPE', token: 150, hold: '0', total: '2',   entryNtl: '100' },
  { coin: 'KNTQ', token: 300, hold: '0', total: '100', entryNtl: '0' },
] }
const SPOT_META = {
  tokens: [{ index: 150, name: 'HYPE' }, { index: 0, name: 'USDC' }, { index: 300, name: 'KNTQ' }],
  universe: [{ name: '@107', index: 107, tokens: [150, 0] }, { name: '@334', index: 334, tokens: [300, 0] }],
}
const CTX = { funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: SPOT,
  allMids: { BTC: '100000', SOL: '100', '@107': '75', '@334': '0.20' },
  // Two HYPE bought in one go eleven days ago, on the @107 pair — balances are keyed by token
  // name and fills by pair id, so this also proves the mapping.
  frontendOpenOrders: [],
  userFills: [{ coin: '@107', dir: 'Buy', sz: '2', px: '50', time: Date.now() - 11 * 86400000, closedPnl: '0', fee: '0', oid: 1, tid: 1, hash: '0x0' }],
  userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: SPOT_META,
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX, CTX]],
}

// ctx.route does NOT cover WebSockets, and the app opens one to Hyperliquid for live state.
// Left alone it delivers real prices straight past every fixture here.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const browser = await chromium.launch()
// Desktop shell: wide viewport, no isMobile.
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
await blockHlSockets(ctx)
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

const boot = async () => {
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the overview', () => !!document.querySelector('.ov-postab'))
  await p.waitForTimeout(900)
}

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await boot()

console.log(NL + '-- desktop has a Spot tab, like mobile --')
{
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.ov-postab[data-pt]')]
    .map(b => b.dataset.pt))
  t('the tab is there, beside the others', tabs, ['positions', 'orders', 'spot', 'outcomes'])
  // The Manage panel reuses .ov-postab without a data-pt. An unscoped switcher cleared
  // `active` off its buttons every time the Overview tab changed.
  t('switching a tab leaves the Manage panel alone', await p.evaluate(() => {
    const m = document.getElementById('mtab-positions')
    if (!m) return 'no manage panel'
    m.classList.add('active')
    window.__ovSetPosTab('orders')
    const kept = m.classList.contains('active')
    window.__ovSetPosTab('positions')
    return kept
  }), true)
  const count = await p.evaluate(() =>
    document.querySelector('.ov-postab[data-pt="spot"] .count-pill')?.textContent)
  // USDC, HYPE and KNTQ. Mobile lists USDC here and desktop left it out — the tab is a
  // holdings list, not a partition of equity, so excluding it just lost a balance. (The
  // allocation wheel is the one place it must stay out of, where it IS the Free margin
  // bucket and a second slice would be the same dollars twice.)
  t('and counts every balance, USDC included', count, '3')

  await p.evaluate(() => window.__ovSetPosTab('spot'))
  await p.waitForTimeout(400)
  const rows = await p.evaluate(() => [...document.querySelectorAll('#ovPosBody .ov-spot-row')]
    .slice(1).map(r => r.innerText.replace(/\s+/g, ' ')))
  t('one row per balance', rows.length, 3)
  const hype = rows.find(r => /HYPE/.test(r)) ?? ''
  const kntq = rows.find(r => /KNTQ/.test(r)) ?? ''
  // 2 HYPE at the @107 pair mid of $75 = $150, bought for $100.
  t('priced through its pair, not a same-named perp', /\$75/.test(hype), true)
  t('valued', /\$150\.00/.test(hype), true)
  t('with PnL against its cost basis', /\+\$50\.00/.test(hype) && /\+50\.0%/.test(hype), true)
  // entryNtl 0 means it was transferred in, not bought. A 0 basis is not a 100% gain.
  t('and no invented PnL where there is no cost basis', /—/.test(kntq), true)
  t('USDC is listed, the way mobile lists it', rows.some(r => /USDC/.test(r)), true)
  // The quote asset is worth its face value and has no market price to look up.
  t('and is priced at par', /\$1\.00 /.test(rows.find(r => /USDC/.test(r)) ?? ''), true)
  t('with no invented PnL, since cash has no cost basis',
    /—/.test(rows.find(r => /USDC/.test(r)) ?? ''), true)
  // Neither "Close all" nor "Cancel all" means anything on a list of holdings.
  t('the bulk action is hidden', await p.evaluate(() =>
    document.getElementById('ovPosAction')?.style.display), 'none')
}

console.log(NL + '-- and the sort survives a reload --')
{
  await p.evaluate(() => window.__ovSetPosTab('positions'))
  await p.waitForTimeout(300)
  // Default is PnL descending. Pick something nobody would land on by accident.
  await p.evaluate(() => window.__ovSortPos('market'))
  await p.waitForTimeout(300)
  const before = await p.evaluate(() => [...document.querySelectorAll('#ovPosBody .ov-pos-mkt b')].map(b => b.textContent))
  t('sorting by Market puts BTC first', before[0], 'BTC')
  t('it is written down', await p.evaluate(() => localStorage.getItem('ovPosSortBy')), 'market')

  // Flip it, so direction has to persist too and not just the column.
  await p.evaluate(() => window.__ovSortPos('market'))
  await p.waitForTimeout(300)
  t('flipping reverses it', await p.evaluate(() =>
    document.querySelector('#ovPosBody .ov-pos-mkt b')?.textContent), 'SOL')
  t('and the direction is written down too',
    await p.evaluate(() => localStorage.getItem('ovPosSortDir')), '-1')

  await p.reload({ waitUntil: 'domcontentloaded' })
  await boot()
  t('after a reload the column is still Market',
    await p.evaluate(() => localStorage.getItem('ovPosSortBy')), 'market')
  t('and the rows come back in that order, reversed',
    await p.evaluate(() => document.querySelector('#ovPosBody .ov-pos-mkt b')?.textContent), 'SOL')
}

console.log(NL + '-- as does the tab you were on --')
{
  await p.evaluate(() => window.__ovSetPosTab('spot'))
  await p.waitForTimeout(300)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await boot()
  const active = await p.evaluate(() => document.querySelector('.ov-postab.active')?.dataset.pt)
  t('it reopens on Spot', active, 'spot')
  t('showing that body', await p.evaluate(() =>
    document.querySelectorAll('#ovPosBody .ov-spot-row').length > 0), true)
  // An unknown value in storage must not leave the panel on a tab that does not exist.
  await p.evaluate(() => localStorage.setItem('ovPosTab', 'nonsense'))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await boot()
  t('a junk value falls back to Positions',
    await p.evaluate(() => document.querySelector('.ov-postab.active')?.dataset.pt), 'positions')
}

await browser.close()
console.log(NL + 'errors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
