// Privacy mode, from the outside.
//
// "Hide balances" makes one promise and it is a promise about PIXELS: with the eye shut,
// nothing on screen says how much you have. That is not a thing a source read can confirm —
// a renderer can mask nine figures and print the tenth, a live tick can write a raw number
// back into an element that was masked a second ago, and a detail panel can open onto a grid
// nobody remembered to cover. So this opens the tabs, shuts the eye, and reads the screen.
//
// It exists because the Spot tab shipped unmasked: the token amount, the USD value and the
// PnL all rendered in full with privacy on. The Outcomes tab did too.
//
// Hermetic: the exchange is stubbed, so the balances below are the only balances there are
// and any digit on screen has to have come from one of them.
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
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// Distinctive digit strings, so a leak is unmistakable in the text of the page and cannot be
// confused with a percentage, a count or a date that happens to share a digit.
const USDC_TOTAL = '5744.6772'
const HYPE_TOTAL = '11.88961'
const HYPE_PX    = '92.6765'
const HYPE_COST  = '986.47'      // → value ~1101.89, PnL ~+115.42, ROI ~+11.7%
const OC_SHARES  = '250'
const OC_COST    = '75'          // 250 shares at 30¢

const BAL = [
  { coin: 'USDC', token: 0, total: USDC_TOTAL, hold: '0', entryNtl: '0' },
  { coin: 'HYPE', token: 1, total: HYPE_TOTAL, hold: '0', entryNtl: HYPE_COST },
  { coin: '#2170', token: 2, total: OC_SHARES, hold: '0', entryNtl: OC_COST },
]
const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'HYPE', szDecimals: 2, maxLeverage: 40 }]
const CTX = { funding: '0', openInterest: '0', prevDayPx: '90', dayNtlVlm: '0', premium: '0',
              oraclePx: HYPE_PX, markPx: HYPE_PX, midPx: HYPE_PX, impactPxs: ['92.6', '92.7'] }
const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: BAL },
  allMids: { HYPE: HYPE_PX },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX]],
  l2Book: { coin: '#2170', levels: [[{ px: '0.30', sz: '100', n: 1 }], [{ px: '0.31', sz: '100', n: 1 }]], time: Date.now() },
}

// ctx.route does NOT cover WebSockets, and the app opens one to Hyperliquid for live state.
const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await blockHlSockets(ctx)
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')          // start with the eye OPEN
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, 30000)

const tab  = async (name) => { await p.evaluate(n => window.mobVTab(n), name); await p.waitForTimeout(500) }
const text = () => p.evaluate(() => document.getElementById('mobVContent')?.textContent ?? '')
// The same text with the outcome CLOSE PANEL removed.
//
// That panel is a form, deliberately unmasked (see renderOcRow): its share count lives in an
// editable input and the estimate underneath only mirrors it, so masking the readout while
// the input above it shows the number would hide nothing. It is marked `data-ocform` so this
// exemption is something a test can subtract rather than a rule it has to remember.
const textNoForm = () => p.evaluate(() => {
  const el = document.getElementById('mobVContent')
  if (!el) return ''
  const c = el.cloneNode(true)
  c.querySelectorAll('[data-ocform]').forEach(n => n.remove())
  return c.textContent ?? ''
})
const setPrivacy = async (on) => {
  await p.evaluate((want) => {
    // Toggle rather than set, so this drives the same path the eye button does.
    const isOn = () => localStorage.getItem('hliq_privacy') === '1'
    if (isOn() !== want) window.__togglePrivacy()
  }, on)
  await p.waitForTimeout(500)
}
// Every figure that says how much you hold, in the form the row prints it.
const LEAKS = ['5,744.6772', '5,744.68', '11.88961', '1,101.89', '115.42', '11.70', '986.47']

console.log(NL + '-- Spot, eye open: the numbers are there --')
{
  await tab('spot')
  await setPrivacy(false)
  const t = await text()
  ok('the balances render at all', /USDC/.test(t) && /HYPE/.test(t), t.slice(0, 160))
  ok('the token amount is shown', t.includes('5,744.6772'), t.slice(0, 200))
  ok('the USD value is shown', t.includes('1,101.89'), t.slice(0, 300))
  ok('and the PnL', /\+\$115\.42/.test(t), t.slice(0, 300))
}

console.log(NL + '-- Spot, eye shut: nothing is --')
{
  await setPrivacy(true)
  const t = await text()
  const leaked = LEAKS.filter(x => t.includes(x))
  ok('no holding figure survives the mask', leaked.length === 0, leaked)
  ok('and something is visibly masked', t.includes('•••'), t.slice(0, 200))
  // The market is not the balance. Hiding the price would hide what the token is worth per
  // unit, which is public and on every chart in the app.
  ok('the live price is still shown', t.includes('92.6765'), t.slice(0, 300))
  ok('the token names are still readable', /USDC/.test(t) && /HYPE/.test(t))
}

console.log(NL + '-- the detail grid a row opens onto --')
{
  // The row covers itself; the panel underneath is a separate renderer and was the easiest
  // place for a figure to survive.
  await p.evaluate(() => window._mobVToggleRow('sp-1'))
  await p.waitForTimeout(350)
  const t = await text()
  const leaked = LEAKS.filter(x => t.includes(x))
  ok('the expanded panel is masked too', leaked.length === 0, leaked)
  ok('it still shows the average buy price', /Avg buy/.test(t), t.slice(0, 200))
  await p.evaluate(() => window._mobVToggleRow('sp-1'))
}

console.log(NL + '-- Outcomes --')
{
  await tab('outcomes')
  await setPrivacy(false)
  const open = await text()
  ok('the holding renders', /shares/.test(open), open.slice(0, 200))
  ok('the share count is shown', /250 shares/.test(open), open.slice(0, 200))

  await setPrivacy(true)
  const shut = await textNoForm()
  ok('the share count is masked', !/250 shares/.test(shut) && /••• shares/.test(shut), shut.slice(0, 250))
  ok('and what a win would pay', !/\+\$175/.test(shut), shut.slice(0, 300))

  await p.evaluate(() => window._mobVToggleRow('oc-0'))
  await p.waitForTimeout(350)
  const card = await textNoForm()
  ok('the expanded card is masked', !/\$75\.00/.test(card) && !/250/.test(card), card.slice(0, 400))
  // The exempt form is genuinely there — otherwise the subtraction above would be passing
  // because there was nothing on screen at all.
  ok('and the close form is present but exempt',
    /Closing 250 shares/.test(await text()), (await text()).slice(-300))
  // Prices are public; an outcome quoted at 30¢ is quoted at 30¢ for everyone.
  ok('but the entry and mark prices are not', /¢/.test(card), card.slice(0, 300))
}

console.log(NL + '-- and it survives a reload --')
{
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot again', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account again', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'the mobile shell again', () => !!window.mobVTab, 30000)
  await tab('spot')
  const t = await text()
  const leaked = LEAKS.filter(x => t.includes(x))
  ok('the eye is still shut after a reload', leaked.length === 0 && t.includes('•••'), leaked)
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
