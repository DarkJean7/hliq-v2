// The calendar's "Month's chart performance" row, in the app.
//
// Asked for: a collapsed row between the stat cards and the grid that opens into the account
// chart for the month being looked at — account value, accumulative PnL and realized PnL,
// "so the user can see how a month's drawback may have affected" it, rather than only the
// nine totals and a grid of green squares.
//
// What the unit suite cannot check is the part that is a screen: that the row is CLOSED when
// the calendar is opened, that it is above the grid and below the cards, that opening it puts
// a chart on the page, that the three tabs each draw, and that paging to another month
// redraws the same row rather than leaving September's line under October's heading.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       node tests/monthchart-browser.mjs --base=https://insolvent.trade
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || ('http://localhost:' + port + '/')
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 45000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// ── a month with a shape ─────────────────────────────────────────────────────
// This month: up, then a drawdown, then a recovery to +$375.50 — a month whose total says
// nothing about the ride, which is the whole reason the row exists.
const now   = new Date()
const Y = now.getFullYear(), M = now.getMonth()
const day   = (d, h = 12) => new Date(Y, M, Math.min(d, now.getDate()), h).getTime()
const prevM = new Date(Y, M - 1, 15, 12).getTime()
// HL's last reading before the month began — the zero the month is measured from.
const eve   = new Date(Y, M, 0, 23).getTime()

const FILLS = [
  { coin: 'BTC', px: '60000', sz: '0.1', side: 'A', time: prevM,  startPosition: '0.1', dir: 'Close Long',
    closedPnl: '800', hash: '0x' + '0'.repeat(64), oid: 1, crossed: true, fee: '1', tid: 1, feeToken: 'USDC' },
  { coin: 'BTC', px: '61000', sz: '0.1', side: 'A', time: day(2), startPosition: '0.1', dir: 'Close Long',
    closedPnl: '120', hash: '0x' + '0'.repeat(64), oid: 2, crossed: true, fee: '1', tid: 2, feeToken: 'USDC' },
  { coin: 'ETH', px: '3000',  sz: '1',   side: 'A', time: day(3), startPosition: '1',   dir: 'Close Long',
    closedPnl: '-45', hash: '0x' + '0'.repeat(64), oid: 3, crossed: true, fee: '1', tid: 3, feeToken: 'USDC' },
  { coin: 'SOL', px: '150',   sz: '10',  side: 'A', time: day(9), startPosition: '10',  dir: 'Close Long',
    closedPnl: '300.5', hash: '0x' + '0'.repeat(64), oid: 4, crossed: true, fee: '1', tid: 4, feeToken: 'USDC' },
]
// HL's own histories. pnlHistory is ALL-TIME, so the row has to rebase it: going into the
// month the account was +$4,000, and it ends the month +$4,375.50.
const VAL = [[prevM, '9000'], [eve, '9500'], [day(3), '9300'], [day(9), '9875']]
const PNL = [[prevM, '3600'], [eve, '4000'], [day(3), '3800'], [day(9), '4375.5']]
const WINDOW = { accountValueHistory: VAL, pnlHistory: PNL, vlm: '120000' }
// HL sends a perp-only twin of every window (perpDay … perpAllTime). It is a different
// quantity — the perp side alone — and drawing its points in the same line as the account's
// own value is what made the chart a scribble between two levels.
const PERP = { vlm: '0',
  accountValueHistory: [[prevM, '2000'], [eve, '2100'], [day(5), '2300'], [day(9), '2500']],
  pnlHistory: [[prevM, '900'], [eve, '1000'], [day(9), '1400']] }
const MARGIN = { accountValue: '9875.0', totalNtlPos: '0', totalRawUsd: '9875.0', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '9875.0', assetPositions: [], time: Date.now() }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: {},
  frontendOpenOrders: [], userFills: FILLS, userFillsByTime: FILLS, userFunding: [],
  userNonFundingLedgerUpdates: [{ time: prevM, hash: '0x1', delta: { type: 'deposit', usdc: '9000' } }],
  subAccounts: [], candleSnapshot: [], extraAgents: [], allPerpMetas: [{ universe: [] }], outcomeMeta: {},
  perpDexs: [null], perpCategories: [],
  portfolio: [...['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
              ...['perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, PERP])],
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '9000' },
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
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)

const row = () => p.$('[data-cal-mchart="mobCalRoot"]')
const heroText = () => p.evaluate(() =>
  document.getElementById('calMChartHero_mobCalRoot')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')

console.log(NL + '-- the calendar opens with the row closed --')
{
  await p.evaluate(() => window.mobVTab('calendar'))
  const there = await waitFor(p, 'the calendar', () => !!document.querySelector('[data-cal-mchart="mobCalRoot"]'), null, 60000)
  ok('the row is on the calendar', there)
  ok('it says what it is', /Month's chart performance/.test(await p.evaluate(() =>
    document.querySelector('[data-cal-mchart="mobCalRoot"]')?.textContent ?? '')))
  ok('and it starts closed', !(await p.evaluate(() =>
    !!document.getElementById('calMChart_mobCalRoot'))))
  // Between the cards and the grid, which is where it was asked for.
  const order = await p.evaluate(() => {
    const root = document.getElementById('mobCalRoot')
    const kids = [...root.children]
    const i = (sel) => kids.findIndex(k => k.matches(sel) || k.querySelector(sel))
    return { cards: i('.cal-summary'), row: i('[data-cal-mchart]'), grid: i('.cal-grid') }
  })
  ok('under the stat cards and above the grid', order.cards < order.row && order.row < order.grid, order)
}

console.log(NL + '-- opening it draws the month --')
{
  await p.click('[data-cal-mchart="mobCalRoot"] .cal-note-head')
  // Painted, not merely present: a canvas with nothing drawn on it is the failure mode worth
  // catching, so this compares against a blank one of the same size.
  const drawn = await waitFor(p, 'the chart', () => {
    const c = document.getElementById('calMChart_mobCalRoot')
    if (!c || !c.width) return false
    const blank = document.createElement('canvas')
    blank.width = c.width; blank.height = c.height
    return c.toDataURL() !== blank.toDataURL()
  }, null, 20000)
  ok('a chart is drawn on the page', drawn)
  // Accumulative by default: HL's all-time PnL rebased, so this month reads +$375.50 and not
  // the +$4,375.50 the account is up for all time.
  ok('accumulative PnL is rebased to the month', /\+\$375\.50/.test(await heroText()), await heroText())
  ok('not the all-time figure', !/4,375/.test(await heroText()), await heroText())

  const pts = () => p.evaluate(() => (window.__calMonthPoints('mobCalRoot') ?? []).map(d => d.y))
  const accum = await pts()
  ok('it starts at zero on the 1st', accum[0] === 0, accum.slice(0, 3))
  ok('and the drawdown in the middle is in the line', Math.min(...accum) < 0, accum)
}

console.log(NL + '-- the three series the Portfolio tab has --')
{
  const tab = async (label) => {
    await p.click(`[data-cal-mchart="mobCalRoot"] .chart-tab:text-is("${label}")`)
    await p.waitForTimeout(400)
    return p.evaluate(() => {
      const d = window.__calMonthPoints('mobCalRoot') ?? []
      return { n: d.length, last: d.at(-1)?.y ?? null,
               title: document.querySelector('[data-cal-mchart="mobCalRoot"] .section-title')?.textContent ?? '' }
    })
  }
  const value = await tab('Value')
  ok('account value is the account\'s own dollars', value.last === 9875, value)
  ok('and it is titled as such', value.title === 'Account value', value.title)
  // The perp-only windows sit around $2,000-$2,500. One point from them in this line is the
  // scribble that was reported, so the whole series has to stay in the account's own range.
  const ys = await p.evaluate(() => (window.__calMonthPoints('mobCalRoot') ?? []).map(d => d.y))
  ok('and not one point from the perp-only windows', ys.length > 1 && ys.every(y => y > 5000), ys)
  ok('the hero reads as an amount, not a result', /^\$9,875\.00/.test(await heroText()), await heroText())

  const real = await tab('Realized')
  ok('realized ends on the month\'s own PnL', Math.abs(real.last - 375.5) < 0.01, real)
  ok('one step per close, and a zero to start', real.n === 4, real)
  // The grid above sums the same closedPnl into its days, so the two must agree.
  const monthPnl = await p.evaluate(() => document.querySelector('#mobCalRoot .cal-summary .stat-value')?.textContent ?? '')
  ok('which is what the Month PnL card says', /375\.50/.test(monthPnl), monthPnl)
}

console.log(NL + '-- paging to another month redraws it --')
{
  await p.evaluate(() => window.mobCalNav(-1))
  await p.waitForTimeout(600)
  const open = await p.evaluate(() => !!document.getElementById('calMChart_mobCalRoot'))
  ok('the row stays open while paging', open)
  const last = await p.evaluate(() => (window.__calMonthPoints('mobCalRoot') ?? []).at(-1)?.y ?? null)
  // Last month closed one trade, for +$800 — September's +$375.50 must not still be drawn.
  ok('and shows the month it is now on', last === 800, last)
  await p.evaluate(() => window.mobCalNav(1))
  await p.waitForTimeout(400)

  // Leaving the calendar and coming back closes it again.
  await p.evaluate(() => window.mobVTab('home'))
  await p.waitForTimeout(300)
  await p.evaluate(() => window.mobVTab('calendar'))
  await waitFor(p, 'the calendar again', () => !!document.querySelector('[data-cal-mchart="mobCalRoot"]'))
  ok('and it is closed again next time the calendar is opened',
    !(await p.evaluate(() => !!document.getElementById('calMChart_mobCalRoot'))))
}

console.log(NL + '-- and All Accounts has all three too --')
{
  // Reported as "how can i see the month account equity and accumulative pnl": the combined
  // view was handed no portfolio at all, so it showed a lone Realized tab. It has one — every
  // visible wallet's history resampled onto a grid and summed, which is what its own charts
  // are drawn from. A second wallet flat at $5,000 must therefore lift the line by $5,000.
  const W2 = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
  const M2 = { accountValue: '5000', totalNtlPos: '0', totalRawUsd: '5000', totalMarginUsed: '0' }
  const S2 = { marginSummary: M2, crossMarginSummary: M2, crossMaintenanceMarginUsed: '0',
               withdrawable: '5000', assetPositions: [], time: Date.now() }
  const W2WIN = { accountValueHistory: [[prevM, '5000'], [eve, '5000'], [day(9), '5000']],
                  pnlHistory: [[prevM, '0'], [eve, '0'], [day(9), '0']], vlm: '0' }
  const ctx2 = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  try { await ctx2.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx2.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (String(b.user ?? '').toLowerCase() === W2) {
      const T = { ...HL, clearinghouseState: S2, webData2: { clearinghouseState: S2, openOrders: [], cumLedger: '5000' },
                  portfolio: [...['day', 'week', 'month', 'allTime'].map(w => [w, W2WIN]),
                              ...['perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, W2WIN])],
                  userFills: [], userFillsByTime: [], userNonFundingLedgerUpdates: [] }
      return route.fulfill({ status: 200, contentType: 'application/json', json: T[b.type] ?? {} })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx2.route('**/api/combined', (route) => route.fulfill({ status: 503, body: 'no snapshot in test' }))
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
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }, { addr: b, label: 'Two' }]))
    localStorage.setItem('hliq_multi_accounts', JSON.stringify([{ addr: a, label: 'One' }, { addr: b, label: 'Two' }]))
  }, { a: ADDR, b: W2 })
  await q.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(q, 'boot', () => !!window.loadDashboard)
  await q.evaluate(() => { window.__comboRowsAfterMs = 1500 })
  await q.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(q, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(q, 'the mobile shell', () => !!window.mobVTab, null, 60000)
  await q.evaluate(() => { window.__goAllAccounts?.() })
  await waitFor(q, 'All Accounts', () => !!window.__isAllAccounts?.() || /All Accounts/i.test(document.body.textContent ?? ''), null, 90000)
  // The combined calendar lives in the Accounts view, under the per-wallet rows.
  await q.evaluate(() => window.mobVTab('accounts'))
  const combined = await waitFor(q, 'the combined calendar',
    () => !!document.querySelector('[data-cal-mchart="mobMaCalRoot"]'), null, 90000)
  ok('the combined view has the row too', combined)
  if (combined) {
    const labels = await q.$$eval('[data-cal-mchart="mobMaCalRoot"] .cal-note-head', () => [])
    await q.click('[data-cal-mchart="mobMaCalRoot"] .cal-note-head')
    await q.waitForTimeout(800)
    const tabs = await q.$$eval('[data-cal-mchart="mobMaCalRoot"] .chart-tab', els => els.map(e => e.textContent.trim()))
    ok('with all three tabs, not just Realized', tabs.join() === 'Value,Accum.,Realized', tabs)
    await q.click('[data-cal-mchart="mobMaCalRoot"] .chart-tab:text-is("Value")')
    await q.waitForTimeout(600)
    const last = await q.evaluate(() => (window.__calMonthPoints('mobMaCalRoot') ?? []).at(-1)?.y ?? null)
    // $9,875 for the first wallet at its last reading, $5,000 flat for the second.
    ok('and the value line is both wallets added up', last != null && Math.abs(last - 14875) < 60, last)
  }
  await ctx2.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
