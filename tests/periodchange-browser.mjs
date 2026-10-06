// The 1D change is ONE number on every screen: the mobile "today" pill, the desktop Overview
// pill and the Portfolio overlay. Rule: main.js _periodChange.
//
// Reported: the same wallets read +$152.05 "today" on the phone and +$232.38 "1D" on desktop
// and in the overlay. The phone's base was read off the coarse all-time history; desktop and
// the overlay measured the 1-day history's last point against its first, ignoring the live
// equity printed beside it.
//
// Fixture: a 1-day history whose FIRST point (25h ago, $1,000) is not the value 24h ago (the
// line between $1,000 at -25h and $1,200 at -23h crosses $1,100 at -24h), and whose last point
// ($1,300) is not the live equity. last − first ($300) is the old, wrong answer; live − $1,100
// is the right one. All three screens must show the same, right figure.
//
// Run:  npm run test:browser        (expects a server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/app'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const now = Date.now(), H = 3600e3
const DAY = [[now - 25 * H, '1000'], [now - 23 * H, '1200'], [now - 12 * H, '1250'], [now - 0.5 * H, '1300']]
const WEEK = [[now - 7 * 24 * H, '900'], ...DAY]
const PNL = DAY.map(([t]) => [t, '0'])
const win = (h) => ({ accountValueHistory: h, pnlHistory: h.map(([t]) => [t, '0']), vlm: '0' })
const MARGIN = { accountValue: '1320.0', totalNtlPos: '0.0', totalRawUsd: '1320.0', totalMarginUsed: '0.0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1320.0', assetPositions: [], time: now }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: {}, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: [['day', win(DAY)], ['week', win(WEEK)], ['month', win(WEEK)], ['allTime', win(WEEK)]],
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}
void PNL

const money = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]+)?)/); return m ? parseFloat(m[1]) : null }

async function open(browser, opts) {
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.evaluate((a) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  return { ctx, p }
}

const errs = []
const browser = await chromium.launch()

console.log('\n-- phone: the "today" pill and the Portfolio overlay --')
const m = await open(browser, { ...devices['iPhone 14 Pro'] })
await waitFor(m.p, 'the pill', () => /today/.test(document.getElementById('mobVChange')?.textContent ?? ''))
const live = money(await m.p.textContent('#mobVBalance'))
const pill = money(await m.p.textContent('#mobVChange'))
ok('the headline shows the equity', live != null && live > 0, live)
// The base is read at "now − 24h", which moves on while the test runs: $1,100 drifts by
// cents a minute along this line, hence the tolerance. The wrong answers are $300 and $400.
ok('"today" = live equity − the value exactly 24h ago (~$1,100), not − the first point', pill != null && Math.abs(pill - (live - 1100)) < 0.5, { pill, live })
await m.p.evaluate(() => { window.mobVTab('portfolio') })
await waitFor(m.p, 'the overlay', () => !!document.getElementById('mobVPortHero'))
await m.p.evaluate(() => window.mobVSetPortPeriod('day'))
await waitFor(m.p, 'the hero', () => /\$/.test(document.getElementById('mobVPortHero')?.textContent ?? ''))
const heroLines = await m.p.evaluate(() => [...document.getElementById('mobVPortHero').children].map(c => c.textContent.trim()))
ok('the overlay\'s 1D headline is the same live equity', Math.abs(money(heroLines[0]) - live) < 0.02, heroLines)
ok('and its change is the same as the pill', Math.abs(money(heroLines[1]) - pill) < 0.5, { overlay: heroLines[1], pill })
ok('not the old last − first ($300)', Math.abs(money(heroLines[1]) - 300) > 0.5, heroLines[1])
await m.ctx.close()

console.log('\n-- desktop: the Overview pill on 1D --')
const d = await open(browser, { viewport: { width: 1440, height: 900 } })
await waitFor(d.p, 'the overview pill', () => !!document.getElementById('ovChgPill'))
await d.p.evaluate(() => window.__ovSetRange('1D'))
const dpill = money(await d.p.textContent('#ovChgPill'))
// Read seconds after the phone, and in this fixture the base climbs ~3c a second.
ok('the desktop 1D pill matches the phone', dpill != null && Math.abs(dpill - pill) < 0.5, { desktop: dpill, phone: pill })
await d.ctx.close()

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
await browser.close()
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
