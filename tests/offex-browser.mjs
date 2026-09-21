// Off-exchange holdings, in a real page.
//
// The rules are covered without a browser in tests/suites/offex.test.mjs. What needs one is
// the round trip nobody's source shows: paste an address into the sheet, see it resolve to a
// name, type an amount, and have the Spot tab print a row whose value is amount × the looked-up
// price — while the account's own equity does not move by a cent.
//
// Hermetic: the exchange and the price route are both stubbed. The NEST price below is the
// real one from the day this was written, so the numbers are checkable by hand.
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

const NEST  = '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035'
const EAGLE = '0xe99509927aa0dc328e7ab5058cd24be1b2a5f280'

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

const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '2000'], [Date.now(), '2000']], pnlHistory: [], vlm: '0' }
const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '500', hold: '0', entryNtl: '0' }] },
  allMids: {}, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []],
}
const PRICES = {
  [NEST]:  { addr: NEST,  symbol: 'NEST',  name: 'Nest',  icon: null, price: 0.02037551306, liq: 913455, thin: false },
  [EAGLE]: { addr: EAGLE, symbol: 'EAGLE', name: 'Eagle', icon: null, price: 0.0001914099722, liq: 0, thin: true },
}

const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }

const priceAsks = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await blockHlSockets(ctx)
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/offexprice**', (route) => {
  const a = (new URL(route.request().url()).searchParams.get('a') || '').split(',')
  priceAsks.push(a)
  const prices = Object.fromEntries(a.filter(x => PRICES[x]).map(x => [x, PRICES[x]]))
  return route.fulfill({ status: 200, json: { prices } })
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
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, 30000)
await p.evaluate(() => window.mobVTab('spot'))
await waitFor(p, 'the Spot tab', () => /Off-exchange/.test(document.getElementById('mobVContent')?.textContent ?? ''))

const text = () => p.evaluate(() => document.getElementById('mobVContent')?.textContent ?? '')
const equity = () => p.evaluate(() => document.getElementById('mobVBalance')?.textContent?.trim() ?? '')

console.log(NL + '-- the group is there before anything is added --')
{
  const t = await text()
  ok('an Off-exchange group sits under the spot rows', /USDC[\s\S]*Off-exchange/.test(t), t.slice(0, 200))
  ok('with an Add button', /\+ Add token/.test(t))
  ok('and a line saying what it is for — and that it is not equity', /never added to your account equity/.test(t))
}

const equityBefore = await equity()

console.log(NL + '-- adding NEST through the sheet --')
{
  await p.evaluate(() => window.__offexAdd())
  await waitFor(p, 'the sheet', () => document.getElementById('offexSheet')?.style.display === 'flex')

  await p.fill('#offexToken', 'not an address')
  await p.waitForTimeout(150)
  ok('a bad address is caught while typing', /not a contract address/.test(await p.textContent('#offexLookup')))

  await p.fill('#offexToken', NEST.toUpperCase().replace('0X', '0x'))
  await waitFor(p, 'the lookup', () => /NEST/.test(document.getElementById('offexLookup')?.textContent ?? ''))
  ok('a pasted address resolves to its name and price', /NEST[\s\S]*\$0\.020/.test(await p.textContent('#offexLookup')), await p.textContent('#offexLookup'))

  await p.click('#offexSave')
  ok('saving without an amount is refused', /how much you hold/.test(await p.textContent('#offexStatus')))

  await p.fill('#offexAmount', '12000')
  await p.fill('#offexCost', '200')
  await p.fill('#offexNote', 'locked on Nest')
  await p.click('#offexSave')
  await waitFor(p, 'the sheet to close', () => document.getElementById('offexSheet')?.style.display === 'none')
  await waitFor(p, 'the row', () => /NEST/.test(document.querySelector('[data-offex]')?.textContent ?? ''))

  const g = await p.evaluate(() => document.querySelector('[data-offex]')?.textContent ?? '')
  // 12,000 × $0.02037551306 = $244.51, and $44.51 over the $200 paid.
  ok('the row is worth amount × price', g.includes('$244.51'), g)
  ok('with profit over what was paid', /\+\$44\.51/.test(g), g)
  ok('and the note', g.includes('locked on Nest'))
  ok('the group has a subtotal', /Off-exchange\s*\$244\.51/.test(g), g.slice(0, 120))
  ok('and a combined figure, labelled as one', /Spot incl\. off-exchange\s*\$744\.51/.test(g), g.slice(-120))

  const stored = await p.evaluate((a) => localStorage.getItem('hliq_offex_' + a.toLowerCase()), ADDR)
  ok('it is stored under the real account', !!stored && JSON.parse(stored)[0].token === '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035', stored)
  ok('and nowhere else', await p.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('hliq_offex_')).length) === 1)
}

console.log(NL + '-- it never touches the account --')
{
  // The promise made when this was agreed: off-exchange value is its own figure.
  ok('account equity did not move', (await equity()) === equityBefore, [equityBefore, await equity()])
}

console.log(NL + '-- a thin market says so --')
{
  await p.evaluate(() => window.__offexAdd())
  await waitFor(p, 'the sheet', () => document.getElementById('offexSheet')?.style.display === 'flex')
  await p.fill('#offexToken', EAGLE)
  await waitFor(p, 'the lookup', () => /EAGLE/.test(document.getElementById('offexLookup')?.textContent ?? ''))
  ok('the lookup warns before you save', /thin market/.test(await p.textContent('#offexLookup')))
  await p.fill('#offexAmount', '5000000')
  await p.click('#offexSave')
  await waitFor(p, 'EAGLE row', () => /EAGLE/.test(document.querySelector('[data-offex]')?.textContent ?? ''))
  await p.evaluate((a) => window.__offexToggle(a.toLowerCase() + '|0xe99509927aa0dc328e7ab5058cd24be1b2a5f280'), ADDR)
  await p.waitForTimeout(200)
  ok('and the row does too', /Thin market/.test(await text()))
}

console.log(NL + '-- privacy mode covers them --')
{
  await p.evaluate(() => window.__togglePrivacy())
  await p.waitForTimeout(400)
  const g = await p.evaluate(() => document.querySelector('[data-offex]')?.textContent ?? '')
  ok('no amount, value or profit survives the mask', !/244\.51|12,000|44\.51|744\.51|5,000,000/.test(g), g.slice(0, 300))
  ok('but the prices do', /\$0\.020/.test(g))
  await p.evaluate(() => window.__togglePrivacy())
  await p.waitForTimeout(300)
}

console.log(NL + '-- editing and removing --')
{
  await p.evaluate((a) => window.__offexEdit(a.toLowerCase(), '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035'), ADDR)
  await waitFor(p, 'the sheet', () => document.getElementById('offexSheet')?.style.display === 'flex')
  ok('the edit sheet opens filled in', (await p.inputValue('#offexAmount')) === '12000')
  await p.fill('#offexAmount', '15000')
  await p.click('#offexSave')
  await p.waitForTimeout(300)
  const g = await p.evaluate(() => document.querySelector('[data-offex]')?.textContent ?? '')
  const names = await p.evaluate(() => [...document.querySelectorAll('[data-offex] .mob-v-row-name')].map(e => e.textContent.trim()))
  // 15,000 × $0.02037551306 = $305.63.
  ok('a new amount updates the same row, not a second one',
    names.filter(n => n === 'NEST').length === 1 && g.includes('$305.63'), names)

  await p.evaluate((a) => window.__offexEdit(a.toLowerCase(), '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035'), ADDR)
  await waitFor(p, 'the sheet', () => document.getElementById('offexSheet')?.style.display === 'flex')
  await p.evaluate(() => window.__offexRemove())
  await p.waitForTimeout(300)
  ok('removing takes the row away', !/NEST/.test(await p.evaluate(() => document.querySelector('[data-offex]')?.textContent ?? '')))
}

console.log(NL + '-- the price service is asked sparingly --')
{
  // Every lookup and repaint funnels through one poll that asks at most once a minute unless
  // forced by a lookup — the server caches too, but the client should not lean on that.
  ok('a handful of price calls, not one per repaint', priceAsks.length <= 8, priceAsks.length)
}

console.log(NL + '-- the desktop overview shows the same group --')
{
  const dctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  await blockHlSockets(dctx)
  await dctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await dctx.route('**/offexprice**', (route) => {
    const a = (new URL(route.request().url()).searchParams.get('a') || '').split(',')
    return route.fulfill({ status: 200, json: { prices: Object.fromEntries(a.filter(x => PRICES[x]).map(x => [x, PRICES[x]])) } })
  })
  await dctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  const d = await dctx.newPage()
  d.on('pageerror', e => errs.push('desktop: ' + e.message))
  await d.goto(BASE, { waitUntil: 'domcontentloaded' })
  await d.evaluate(({ a, k, n }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
    localStorage.setItem('hliq_offex_' + a.toLowerCase(), JSON.stringify([{ token: n, amount: 12000, symbol: 'NEST', added: 1 }]))
  }, { a: ADDR, k: KEY, n: NEST })
  await d.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(d, 'boot', () => !!window.loadDashboard)
  await d.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(d, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(d, 'the overview tabs', () => !!window.__ovSetPosTab && !!document.querySelector('.ov-postab[data-pt="spot"]'))
  await d.evaluate(() => window.__ovSetPosTab('spot'))
  await waitFor(d, 'the priced row', () => /\$244\.51/.test(document.querySelector('.ov-offex')?.textContent ?? ''))
  const g = await d.evaluate(() => document.querySelector('.ov-offex')?.textContent ?? '')
  ok('the overview Spot tab carries the off-exchange group', /Off-exchange/.test(g) && /NEST/.test(g), g.slice(0, 160))
  ok('priced the same way', g.includes('$244.51'), g.slice(0, 300))
  await dctx.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
