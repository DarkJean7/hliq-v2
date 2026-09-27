// Switching between the phone and desktop layouts keeps your place.
//
// Reported as: "lets make the app that when in mobile mode and its changed to desktop it
// should preserve and display the same tab… also viceversa. its annoying changing modes and
// encountering home."
//
// The unit suite fixes the name mapping; what it cannot check is that the app actually
// arrives on that screen — that the desktop panel is the visible one afterwards, and that
// the phone shell renders the screen it was handed rather than its home.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       node tests/shelltab-browser.mjs --base=https://insolvent.trade
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
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const M = { accountValue: '5000', totalNtlPos: '0', totalRawUsd: '5000', totalMarginUsed: '0' }
const STATE = { marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: '0',
                withdrawable: '5000', assetPositions: [], time: Date.now() }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '5000'], [Date.now(), '5000']],
              pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: {},
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WIN]),
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '5000' },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
// A desktop-sized window, so the app boots into the desktop shell and the switch under test
// is the Settings one rather than the viewport.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
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
  localStorage.setItem('hliq_force_mobile', '0')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))

// Which desktop panel is showing, and which phone screen the phone shell is on.
const deskTab = () => p.evaluate(() =>
  [...document.querySelectorAll('.tab-panel.active')].map(e => e.id.replace('tab-', ''))[0] ?? '')
const onPhone = () => p.evaluate(() => document.body.classList.contains('is-mob-view'))
const phoneScreen = () => p.evaluate(() => document.getElementById('mobVContent')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? '')

console.log(NL + '-- desktop → phone keeps the tab --')
{
  await p.evaluate(() => window.switchTab('calendar'))
  await waitFor(p, 'the calendar tab', () => document.getElementById('tab-calendar')?.classList.contains('active'))
  ok('the desktop is on Calendar', await deskTab() === 'calendar', await deskTab())

  await p.evaluate(() => window.__toggleForceMobile(true))
  await waitFor(p, 'the phone shell', () => document.body.classList.contains('is-mob-view'))
  ok('the phone shell is up', await onPhone())
  // The phone's Calendar screen, not its home screen.
  const txt = await phoneScreen()
  ok('and it is showing the Calendar, not Home', /Month PnL|Best Day|SUN/.test(txt), txt.slice(0, 120))
}

console.log(NL + '-- phone → desktop keeps the screen --')
{
  await p.evaluate(() => window.mobVGoTab('transfers'))
  await waitFor(p, 'the transfers screen', () => /Transfer|Deposit|No transfers/i.test(document.getElementById('mobVContent')?.textContent ?? ''))
  await p.evaluate(() => window.__toggleForceMobile(false))
  await waitFor(p, 'the desktop shell', () => !document.body.classList.contains('is-mob-view'))
  ok('the desktop shell is back', !(await onPhone()))
  ok('and it opens on Transfers', await deskTab() === 'transfers', await deskTab())
}

console.log(NL + '-- the screens the two shells name differently --')
{
  // The phone has no Overview; its home screen is the positions list.
  await p.evaluate(() => window.switchTab('overview'))
  await p.evaluate(() => window.__toggleForceMobile(true))
  await waitFor(p, 'the phone shell', () => document.body.classList.contains('is-mob-view'))
  const home = await p.evaluate(() => document.getElementById('mobVTab-positions')?.classList.contains('active') ?? null)
  ok('desktop Overview lands on the phone home screen', home !== false, home)

  // The phone's own Orders screen is a table under desktop Positions.
  await p.evaluate(() => window.mobVTab('orders'))
  await p.waitForTimeout(400)
  await p.evaluate(() => window.__toggleForceMobile(false))
  await waitFor(p, 'the desktop shell', () => !document.body.classList.contains('is-mob-view'))
  ok('the phone Orders screen lands on desktop Positions', await deskTab() === 'positions', await deskTab())
}

console.log(NL + '-- and turning the phone does the same --')
{
  // The rotation listener is the other way in, and the one that always lost the place. This
  // runs it on a phone-sized context, which is the only place it fires for real: portrait is
  // the phone shell, landscape is the desktop one.
  const ctx2 = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  try { await ctx2.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx2.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx2.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx2.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
  const q = await ctx2.newPage()
  q.on('pageerror', e => errs.push('phone: ' + e.message))
  await q.goto(BASE, { waitUntil: 'domcontentloaded' })
  await q.evaluate((a) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('hliq_force_mobile', '0')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }]))
  }, ADDR)
  await q.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(q, 'boot', () => !!window.loadDashboard)
  await q.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(q, 'the phone shell', () => document.body.classList.contains('is-mob-view'), null, 60000)
  ok('a phone boots into the phone shell', await q.evaluate(() => document.body.classList.contains('is-mob-view')))

  await q.evaluate(() => window.mobVGoTab('leaderboard'))
  await waitFor(q, 'the leaderboard screen', () => /leaderboard|rank|no wallets/i.test(document.getElementById('mobVContent')?.textContent ?? ''))

  // Turn it for real — the viewport, not a forged event. A synthetic 'change' does not move
  // the media query itself, so the app's next refresh (which asks the query, not the event)
  // puts the phone shell straight back and the test measures nothing.
  await q.setViewportSize({ width: 852, height: 393 })
  const toDesk = await waitFor(q, 'the desktop shell', () => !document.body.classList.contains('is-mob-view'), null, 15000)
  ok('turning it sideways gives the desktop shell', toDesk)
  const tab = await q.evaluate(() => [...document.querySelectorAll('.tab-panel.active')].map(e => e.id.replace('tab-', ''))[0] ?? '')
  ok('on the screen it was already reading', tab === 'leaderboard', tab)

  // And back: portrait returns to the phone, still on the Leaderboard.
  await q.evaluate(() => window.switchTab('performance'))
  await q.waitForTimeout(300)
  await q.setViewportSize({ width: 393, height: 852 })
  const toPhone = await waitFor(q, 'the phone shell again', () => document.body.classList.contains('is-mob-view'), null, 15000)
  ok('turning it back gives the phone shell', toPhone)
  const txt = await q.evaluate(() => document.getElementById('mobVContent')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  ok('on the tab the desktop had moved to', /performance|win rate|profit factor|no closed trades/i.test(txt), txt.slice(0, 140))
  await ctx2.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
