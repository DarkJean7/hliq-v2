// The "real" liquidation price on a guarded position card.
//
// Asked for as: "add a new data that would be the 'real' liquidation price if all of the fires
// from the liq guard are fired." The arithmetic is covered in tests/suites/guardplan.test.mjs;
// what needs a browser is that the card finds the ARMED guard's own config and counters (which
// come from the bot server, per wallet) and prints the row — and leaves it off when no guard
// is armed, rather than projecting one from defaults.
//
// The position is the one from the report: 1.00 CRCL long, 10x isolated, entry $95.506,
// margin $9.59, HL liq $90.4729. A guard armed for $20 over 2 fires moves liq to ~$69.42.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
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

const POS = {
  position: {
    coin: 'xyz:CRCL', szi: '1.0', entryPx: '95.506', positionValue: '95.54', unrealizedPnl: '-0.05',
    marginUsed: '9.59', liquidationPx: '90.4729', maxLeverage: 10, returnOnEquity: '-0.005',
    leverage: { type: 'isolated', value: 10, rawUsd: '9.59' }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
  },
  type: 'oneWay',
}
const MARGIN = { accountValue: '500', totalNtlPos: '95.54', totalRawUsd: '500', totalMarginUsed: '9.59' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0.5',
                 withdrawable: '480', assetPositions: [POS], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '500'], [Date.now(), '500']], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'xyz:CRCL', szDecimals: 2, maxLeverage: 10 }]
const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [] },
  allMids: { 'xyz:CRCL': '95.518' }, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: UNIVERSE }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ markPx: '95.518', midPx: '95.518', prevDayPx: '96.0', openInterest: '100', dayNtlVlm: '1000', funding: '0', oraclePx: '95.5' }]],
  spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

// The bot server: one armed Liq Guard on CRCL, nothing fired yet.
const GUARD_ARGS = ['--coin', 'xyz:CRCL', '--trigger-pct', '85', '--max-fires', '2', '--max-total-add', '20']
let guardOn = true
const statusBody = () => guardOn ? {
  ok: true, liqguard: true, _configs: { 'liqguard:xyz:CRCL': { args: GUARD_ARGS } },
  _instances: { 'liqguard:xyz:CRCL': { running: true, args: GUARD_ARGS } },
  _guards: { 'liqguard:xyz:CRCL': { args: GUARD_ARGS, fires: 0, added: 0 } },
} : { ok: true, _configs: {}, _instances: {}, _guards: {} }

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
// Playwright runs the LAST matching route first, so the catch-all goes on before the
// specific one — the other way round and /api/status would be answered with the 503.
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/api/status*', (route) => route.fulfill({ status: 200, json: statusBody() }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })

const boot = async () => {
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
  await waitFor(p, 'the position card', () => /CRCL/.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 30000)
}
const cardText = () => p.evaluate(() => document.getElementById('mobVContent')?.textContent?.replace(/\s+/g, ' ') ?? '')

await boot()

console.log(NL + '-- with a guard armed --')
{
  const got = await waitFor(p, 'the guarded liq row', () => /Liq\. after guard/.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 30000)
  const txt = await cardText()
  ok('the card shows the liq price after the guard', got, txt.slice(0, 300))
  // HL's own liq, still shown as itself.
  ok('alongside the exchange\'s own liq price', /Liq\. Price \$90\.47/.test(txt), txt.match(/Liq\. Price[^A-Z]{0,20}/)?.[0])
  // $20 over 2 fires on 1 CRCL at mf 0.05 → liq falls 2 × $10.53 → $69.42.
  ok('projected from the guard\'s own config: $69.42', /Liq\. after guard \$69\.4/.test(txt), txt.match(/Liq\. after guard[^A-Z]{0,24}/)?.[0])
  ok('and it says how many fires that assumes', /Liq\. after guard \$69\.4\d+ · 2 fires/.test(txt), txt.match(/Liq\. after guard[^A-Z]{0,30}/)?.[0])
}

console.log(NL + '-- the desktop rows carry both --')
{
  const d = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  try { await d.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await d.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await d.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await d.route('**/api/status*', (route) => route.fulfill({ status: 200, json: statusBody() }))
  await d.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
  const q = await d.newPage()
  q.on('pageerror', e => errs.push('desktop: ' + e.message))
  await q.goto(BASE, { waitUntil: 'domcontentloaded' })
  await q.evaluate(({ a, k }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, { a: ADDR, k: KEY })
  await q.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(q, 'boot', () => !!window.loadDashboard)
  await q.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(q, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  const row = () => q.evaluate(() => document.querySelector('.ov-pos-row')?.textContent?.replace(/\s+/g, ' ') ?? '')
  const gotRow = await waitFor(q, 'the desktop position row', () => /CRCL/.test(document.querySelector('.ov-pos-row')?.textContent ?? ''), null, 30000)
  ok('the desktop row is there', gotRow, await row())
  const badge = await waitFor(q, 'the guard badge', () => /🛡/.test(document.querySelector('.ov-pos-meta')?.textContent ?? ''), null, 25000)
  ok('with the guard badge mobile has always shown', badge, await q.evaluate(() => document.querySelector('.ov-pos-meta')?.textContent ?? ''))
  const liq = await waitFor(q, 'the guarded liq', () => /69\.4/.test(document.querySelector('.ov-pos-row')?.textContent ?? ''), null, 25000)
  ok('and the liq price after the guard, next to the exchange one', liq, await row())
  await d.close()
}

console.log(NL + '-- and without one --')
{
  guardOn = false
  await boot()
  const txt = await cardText()
  ok('no guard, no projection', !/Liq\. after guard/.test(txt) && /Liq\. Price \$90\.47/.test(txt), txt.slice(0, 200))
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
