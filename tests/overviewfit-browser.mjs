// The desktop Overview shows your positions without scrolling.
//
// Asked: "i would like to make the desktop version like positions, etc be almost seen without the
// need of scrolling. like at least show the first 4. basically what im asking is to try and resize
// things, etc to make it happen." Measured at the reporter's own window, 1920×917 (from the
// viewport telemetry), with 17 positions like their account: the first four position rows must sit
// inside the window as the page opens, before any scroll.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       node tests/overviewfit-browser.mjs --layout   prints where each block sits
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const LAYOUT = process.argv.includes('--layout')

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'PURR', 'PYTH', 'VVV', 'LIT', 'PUMP', 'DOGE', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'TIA', 'APT']
const now = Date.now(), HR = 36e5
const WINDOW = { accountValueHistory: Array.from({ length: 60 }, (_, i) => [now - (59 - i) * HR, String(3500 + Math.sin(i / 5) * 250)]),
  pnlHistory: Array.from({ length: 60 }, (_, i) => [now - (59 - i) * HR, String(Math.sin(i / 5) * 250)]), vlm: '0' }
const pos = COINS.map((c, i) => ({ type: 'oneWay', position: { coin: c, szi: String(i % 3 ? 10 : -10), entryPx: '100', positionValue: '1000',
  unrealizedPnl: String((i % 5) - 2), returnOnEquity: '0.01', liquidationPx: '50', marginUsed: '100', maxLeverage: 20,
  leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }))
const MARGIN = { accountValue: '3710', totalNtlPos: '17000', totalRawUsd: '3710', totalMarginUsed: '1305' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '636', withdrawable: '969', assetPositions: pos, time: now }
const UNIVERSE = COINS.map(c => ({ name: c, szDecimals: 2, maxLeverage: 20 }))
const CTX = COINS.map(() => ({ funding: '0', openInterest: '0', prevDayPx: '99', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }))
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: Object.fromEntries(COINS.map(c => [c, '100'])),
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [], subAccounts: [],
  candleSnapshot: [], extraAgents: [], allPerpMetas: [], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 917 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  localStorage.setItem('hliq_watchlist', JSON.stringify(['BTC', 'ETH', 'SOL', 'HYPE', 'PURR', 'PYTH']))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the positions', () => document.querySelectorAll('#ovPosBody .ov-pos-row, #ovPosBody tr').length >= 10)
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.waitForTimeout(800)

const m = await p.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height), bottom: Math.round(b.bottom) } }
  const rows = [...document.querySelectorAll('#ovPosBody .ov-pos-row, #ovPosBody tr')].filter(e => e.offsetParent)
  return {
    // The status bar sits over the window's bottom edge: a row under it is not on screen.
    vh: Math.round(document.querySelector('.statusbar')?.getBoundingClientRect().top ?? innerHeight), scrolled: document.querySelector('.main')?.scrollTop ?? 0,
    rowsVisible: rows.filter(e => e.getBoundingClientRect().bottom <= innerHeight).length,
    row4bottom: rows[3] ? Math.round(rows[3].getBoundingClientRect().bottom) : null,
    blocks: Object.fromEntries(Object.entries({ topbar: '.topbar', acct: '.acct-header, .account-header, #acctHeader', watch: '#watchTicker',
      tabs: '.nav-tabs, .tab-nav', hero: '.ov-equity', chart: '.ov-chart-wrap', health: '.ov-health, .ov-health-card', strip: '.ov-stat-strip',
      positions: '.ov-pos-scroll, #ovPosBody' }).map(([k, s]) => [k, r(s)])),
  }
})
if (LAYOUT) console.log(JSON.stringify(m, null, 1))

console.log('\n-- 1920×917, 17 positions, as the page opens --')
t('nothing has been scrolled', m.scrolled, 0)
t('the first four positions are on screen (row 4 ends at ' + m.row4bottom + ' of ' + m.vh + ')', m.row4bottom != null && m.row4bottom <= m.vh, true)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
