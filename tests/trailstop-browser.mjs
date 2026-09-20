// The Set Trailing Stop modal.
//
// Hyperliquid has no trailing-stop order type, so Confirm arms a SERVER-SIDE watcher. The
// arithmetic is covered without a browser in tests/suites/trailstop.test.mjs; what needs a
// browser is the part no single function's source shows — that the form's two size controls
// agree, that a form which cannot work refuses to submit, and above all that the request it
// sends describes the position the button was pressed on.
//
// Hermetic. The strategy server is stubbed, so Confirm records a launch instead of starting a
// process, and the exchange never sees anything.
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

// One long: 20.19 HYPE, entry 91.348, mark 90.839 — the position from the report.
const POS = {
  position: {
    coin: 'HYPE', szi: '20.19', entryPx: '91.348', positionValue: '1833.04', unrealizedPnl: '-10.28',
    marginUsed: '183.30', leverage: { type: 'cross', value: 10 }, maxLeverage: 40,
    returnOnEquity: '-0.056', liquidationPx: '53.250', cumFunding: { allTime: '0' },
  },
}
const MARGIN = { accountValue: '2000', totalNtlPos: '1833.04', totalRawUsd: '2000', totalMarginUsed: '183.30' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '20', withdrawable: '1800', assetPositions: [POS], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'HYPE', szDecimals: 2, maxLeverage: 40 }]
const CTX = { funding: '0', openInterest: '0', prevDayPx: '90', dayNtlVlm: '0', premium: '0', oraclePx: '90.839', markPx: '90.839', midPx: '90.839', impactPxs: ['90.8', '90.9'] }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: { HYPE: '90.839' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX]],
}

// ctx.route does NOT cover WebSockets, and the app opens one to Hyperliquid for live state.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const launches = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await blockHlSockets(ctx)
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', async (route) => {
  const u = new URL(route.request().url())
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  if (u.pathname.endsWith('/api/auth/nonce')) return route.fulfill({ status: 200, json: { nonce: 'n1', ttl: 60000 } })
  if (u.pathname.endsWith('/api/auth/login')) return route.fulfill({ status: 200, json: { token: 'tok', exp: Date.now() + 3600e3 } })
  if (u.pathname.endsWith('/api/start')) { launches.push(b); return route.fulfill({ status: 200, json: { ok: true } }) }
  if (u.pathname.endsWith('/api/status')) return route.fulfill({ status: 200, json: { ok: true, _instances: {}, _configs: {}, _guards: {}, _paused: {} } })
  return route.fulfill({ status: 503, body: 'offline in test' })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.waitForTimeout(1200)

await p.evaluate(() => window.__openTrailModal('HYPE', 'LONG'))
await waitFor(p, 'the modal', () => document.getElementById('trailModal')?.classList.contains('open'))

const val = (id) => p.evaluate((i) => document.getElementById(i)?.value ?? null, id)
const txt = (id) => p.evaluate((i) => document.getElementById(i)?.textContent?.trim() ?? null, id)
const set = async (id, v) => {
  await p.evaluate(({ i, x }) => {
    const el = document.getElementById(i)
    el.value = x
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, { i: id, x: String(v) })
  await p.waitForTimeout(120)
}

console.log(NL + '-- it opens describing the position it was pressed on --')
{
  t('the market', await txt('trailMarket'), 'HYPE')
  t('the position, with its side', await txt('trailPos'), '20.19 HYPE')
  t('the entry', await txt('trailEntry'), '$91.348')
  t('the mark', await txt('trailMark'), '$90.839')
  t('and the liquidation price', await txt('trailLiq'), '$53.25')
  // Size defaults to the whole position, which is what a stop usually means.
  t('size starts at the whole position', await val('trailSize'), '20.19')
  t('and the slider agrees', await val('trailPct'), '100')
}

console.log(NL + '-- nothing can be armed until it would work --')
{
  // An empty retracement is a stop that never fires. The button says so before it is pressed
  // rather than failing on submit.
  t('an empty form cannot be confirmed',
    await p.evaluate(() => document.getElementById('trailConfirmBtn')?.disabled), true)
  t('and says why', /retracement/i.test(await txt('trailStatus') ?? ''), true)
  await set('trailAmt', 100)
  t('a 100% retracement is refused too', /never trigger/i.test(await txt('trailStatus') ?? ''), true)
  await set('trailAmt', 5)
  t('a real one unlocks it',
    await p.evaluate(() => document.getElementById('trailConfirmBtn')?.disabled), false)
}

console.log(NL + '-- and it says where the stop would sit --')
{
  // 5% below the mark of 90.839 is 86.297.
  t('the preview prices it', /86\.29/.test(await txt('trailStopPx') ?? ''), true)
  t('the sentence names the amount', /5%/.test(await txt('trailExplain') ?? ''), true)
  t('and that a long trails the high', /highest/.test(await txt('trailExplain') ?? ''), true)
}

console.log(NL + '-- the two size controls never disagree --')
{
  await p.evaluate(() => window.__trailPctMoved(50))
  await p.waitForTimeout(150)
  t('moving the slider moves the box', await val('trailSize'), '10.095')
  await set('trailSize', 20.19)
  t('and typing a size moves the slider back', await val('trailPct'), '100')
  // A size larger than the position would be rejected by the exchange.
  await set('trailSize', 999)
  t('an oversized close is still armable, clamped on the way out',
    await p.evaluate(() => document.getElementById('trailConfirmBtn')?.disabled), false)
  await set('trailSize', 20.19)
}

console.log(NL + '-- the quick buttons and the unit --')
{
  await p.evaluate(() => window.__trailQuick(10))
  await p.waitForTimeout(150)
  t('10% fills the amount', await val('trailAmt'), '10')
  t('and forces the unit back to percent', await val('trailUnit'), 'pct')
  await set('trailUnit', 'usd')
  await set('trailAmt', 2)
  // $2 below 90.839 is 88.839 — a dollar retracement is a flat distance, not a percentage.
  t('dollars are a flat distance', /88\.83/.test(await txt('trailStopPx') ?? ''), true)
  await set('trailUnit', 'pct'); await set('trailAmt', 5)
}

console.log(NL + '-- an activation price that has already passed is caught --')
{
  await p.evaluate(() => { const c = document.getElementById('trailActOn'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) })
  await p.waitForTimeout(150)
  t('the field appears', await p.evaluate(() => document.getElementById('trailActRow')?.style.display), '')
  await set('trailAct', 80)
  // Below the mark on a long, so it would start instantly — which is not what setting one means.
  t('a level already behind the market is refused', /already below/i.test(await txt('trailStatus') ?? ''), true)
  await set('trailAct', 95)
  t('one still ahead is fine',
    await p.evaluate(() => document.getElementById('trailConfirmBtn')?.disabled), false)
  t('and the sentence mentions it', /Once the mark reaches/.test(await txt('trailExplain') ?? ''), true)
  await p.evaluate(() => { const c = document.getElementById('trailActOn'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })) })
  await p.waitForTimeout(150)
}

console.log(NL + '-- Confirm arms the watcher that runs where a stop has to run --')
{
  await p.evaluate(() => window.__trailConfirm())
  await waitFor(p, 'the launch', () => true, 1000)
  await p.waitForTimeout(800)
  t('exactly one bot was started', launches.length, 1)
  const l = launches[0] ?? {}
  // A stop that only runs while a tab is open is not a stop.
  t('it is the server-side trailing stop', l.type, 'trailstop')
  t('for the account that owns the position', String(l.address ?? '').toLowerCase(), ADDR.toLowerCase())
  t('keyed by the market, so two positions can each have one', l.instance, 'HYPE')
  // Without the agent key the watcher cannot place the stop it exists to place.
  t('carrying an agent key to sign with', typeof l.agentKey === 'string' && l.agentKey.length > 10, true)
  const a = (l.args ?? []).join(' ')
  t('told which market', /--coin HYPE/.test(a), true)
  t('the retracement', /--retrace 5\b/.test(a), true)
  t('its unit', /--unit pct/.test(a), true)
  t('and the size, resolved to coins rather than a percentage the bot would have to re-derive',
    /--size 20\.19/.test(a), true)
  t('no activation flag when the box is unticked', /--activation/.test(a), false)
}

await browser.close()
console.log(NL + 'errors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
