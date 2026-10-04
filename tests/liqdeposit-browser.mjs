// "What would a deposit do?" — the sheet, in the app.
//
// Asked for: "i have an account with a position close to liquidation. i was wondering how much
// capital i may need to deposit in the app to get a good liquidation price. this way an user
// can know if the deposit would be in vain or to protect the position."
//
// The unit suite fixes the arithmetic against Hyperliquid's own formula. What it cannot check
// is that the sheet opens from the position it is about, that a typed amount moves every cross
// position at once, that the isolated one says the deposit will not reach it — the "in vain"
// half of the question — and that the costings put their own number in the box.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       node tests/liqdeposit-browser.mjs --base=https://insolvent.trade
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || ('http://localhost:' + port + '/app')
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

// An account in the state the question is about: a cross ETH long with liquidation close by,
// a cross SOL short further off, and an isolated BTC long that a deposit cannot reach.
const position = (coin, szi, entry, mark, liq, type, maxLev) => ({ type: 'oneWay', position: {
  coin, szi: String(szi), entryPx: String(entry), positionValue: String(Math.abs(szi) * mark),
  unrealizedPnl: String(szi * (mark - entry)), returnOnEquity: '0',
  leverage: { type, value: 5, ...(type === 'isolated' ? { rawUsd: '600' } : {}) },
  marginUsed: '600', maxLeverage: maxLev, liquidationPx: String(liq),
  cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
} })
const POSITIONS = [
  position('ETH', 10, 3000, 3000, 2900, 'cross', 20),
  position('SOL', -100, 150, 150, 190, 'cross', 20),
  position('BTC', 0.1, 60000, 60000, 55000, 'isolated', 40),
]
const M = { accountValue: '4000', totalNtlPos: '46500', totalRawUsd: '4000', totalMarginUsed: '1200' }
const STATE = { marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: '300',
                withdrawable: '2800', assetPositions: POSITIONS, time: Date.now() }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '4000'], [Date.now(), '4000']],
              pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: { ETH: '3000', SOL: '150', BTC: '60000' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WIN]),
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '4000' },
  meta: { universe: [{ name: 'ETH', maxLeverage: 20 }, { name: 'SOL', maxLeverage: 20 }, { name: 'BTC', maxLeverage: 40 }] },
  spotMeta: { tokens: [], universe: [] },
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

const sheet = () => p.evaluate(() =>
  document.getElementById('liqDepSheet')?.classList.contains('open')
    ? document.getElementById('liqDepCard')?.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '')
const rowText = (coin) => p.evaluate((c) => {
  const el = [...document.querySelectorAll('#liqDepCard .liqd-row')].find(r => r.textContent.includes(c))
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''
}, coin)

console.log(NL + '-- it opens from the position it is about --')
{
  await p.evaluate(() => window.mobVTab('positions'))
  await waitFor(p, 'the position cards', () => /ETH/.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 45000)
  // The card's own button, not a back door: a cross position offers it, an isolated one keeps
  // its Margin button instead, since that is the thing that helps there.
  const btns = await p.evaluate(() => [...document.querySelectorAll('#mobVContent button')]
    .filter(x => /Liq\. preview/i.test(x.textContent))
    .map(x => ({ bg: getComputedStyle(x).backgroundColor, color: getComputedStyle(x).color })))
  ok('the cross positions offer it', btns.length >= 2, btns.length)
  // Blue like Margin, which is the point: the two never appear on the same card, and they are
  // the margin question in each of its forms. The label is what tells them apart.
  ok('dressed like the Margin button it stands in for',
    btns.every(b => b.bg === 'rgba(99, 179, 237, 0.12)'), btns)
  ok("and the Margin button is still the isolated one's own", await p.evaluate(() =>
    [...document.querySelectorAll('#mobVContent button')].some(x => x.textContent.trim() === 'Margin')))
  await p.evaluate(() => window.__liqDepOpen('ETH'))
  await waitFor(p, 'the sheet', () => document.getElementById('liqDepSheet')?.classList.contains('open'))
  const txt = await sheet()
  ok('the sheet opens', /What would a deposit do/i.test(txt), txt.slice(0, 80))
  // Opaque: it opens OVER the position cards, and --panel carries alpha under a backdrop
  // photo. A panel you can read the app through is not a panel.
  const solid = await p.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('liqDepCard'))
    const alpha = (cs.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1] ?? '').split(',')[3]
    return { bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 40), alpha: alpha ? parseFloat(alpha) : 1 }
  })
  ok('and it is not see-through', solid.alpha === 1 && /gradient/.test(solid.img), solid)
  ok('and counts the positions a deposit would reach', /2 cross positions/.test(txt), txt.slice(0, 120))
}

console.log(NL + '-- an amount moves every cross position at once --')
{
  await p.evaluate(() => window.__liqDepSet(500))
  await p.waitForTimeout(250)
  const eth = await rowText('ETH'), sol = await rowText('SOL')
  // $500 on a 10 ETH long at 20x (mf 1/40): 500 / (10 × 0.975) = $51.28 of room.
  ok('the long\'s liquidation falls', /2,900/.test(eth) && /2,848/.test(eth), eth)
  // And on a 100 SOL short: 500 / (100 × 1.025) = $4.88 — the other way.
  ok('the short\'s rises', /190/.test(sol) && /194\.8/.test(sol), sol)
  ok('each says how much room that is', /from the mark/.test(eth) && /%/.test(eth), eth)
}

console.log(NL + '-- and says plainly where it would be in vain --')
{
  const btc = await rowText('BTC')
  ok('the isolated position is listed', /BTC/.test(btc), btc)
  ok('marked as isolated', /isolated/i.test(btc), btc)
  // This is the answer the question came for.
  ok('and says the deposit does not reach it', /does not reach/i.test(btc), btc)
  ok('with no projected price beside it', !/→/.test(btc) && !/&rarr;/.test(btc), btc)
}

console.log(NL + '-- the other direction: what does the room cost --')
{
  const costs = await p.evaluate(() => [...document.querySelectorAll('#liqDepCard .liqd-cost')]
    .map(b => b.textContent.replace(/\s+/g, ' ').trim()))
  ok('targets are priced', costs.length >= 2, costs)
  // ETH sits 3.3% away; 10% of room is 3000 × 0.9 = 2700, so (2900 − 2700) × 10 × 0.975.
  ok('10% of room on the ETH long costs $1,950', costs.some(c => /10%/.test(c) && /1,950/.test(c)), costs)
  // Pressing one puts its own number in the box, which is the whole point of showing it.
  await p.evaluate(() => document.querySelector('#liqDepCard .liqd-cost')?.click())
  await p.waitForTimeout(250)
  const amt = await p.evaluate(() => document.getElementById('liqDepAmt')?.value ?? '')
  ok('pressing one fills the amount', parseFloat(amt) > 1000, amt)
  const eth = await rowText('ETH')
  ok('and the row moves to that target', /2,700/.test(eth), eth)
}

console.log(NL + '-- and the deposit box asks it too --')
{
  // Where the question actually gets asked: money about to be sent, and "will this save the
  // position" is the thing the field cannot answer on its own.
  await p.evaluate(() => window.mobVTab('portfolio'))
  const there = await waitFor(p, 'the deposit box', () => !!document.getElementById('depositAmount'), null, 30000)
  ok('the deposit box is on screen', there)
  const link = await p.evaluate(() => [...document.querySelectorAll('button')]
    .some(b => /liquidation prices/i.test(b.textContent)))
  ok('and offers the preview', link)
  await p.evaluate(() => { const el = document.getElementById('depositAmount'); el.value = '750'; el.dispatchEvent(new Event('input')) })
  await p.evaluate(() => window.__liqDepFromDeposit())
  await waitFor(p, 'the sheet', () => document.getElementById('liqDepSheet')?.classList.contains('open'))
  const amt = await p.evaluate(() => document.getElementById('liqDepAmt')?.value ?? '')
  ok('seeded with the amount being considered', parseFloat(amt) === 750, amt)
  const eth = await rowText('ETH')
  // $750 on the 10 ETH long: 750 / 9.75 = $76.92 of room, 2900 -> 2823.08.
  ok('and priced from it', /2,823/.test(eth), eth)
}

console.log(NL + '-- and it closes --')
{
  await p.evaluate(() => window.__liqDepClose())
  await p.waitForTimeout(200)
  ok('the sheet is gone', await sheet() === '')
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
