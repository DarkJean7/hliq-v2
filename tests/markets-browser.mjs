// /markets, driven for real: the ranking renders from Hyperliquid's replies, the controls
// re-rank and filter it, unknown figures sort last, and icons are only ever READ from the
// app's cache. Rules for the rows themselves: tests/suites/markets.test.mjs.
//
// Hermetic: the exchange is stubbed by host and its sockets closed.
//
// Run:  npm run test:browser        (expects a server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL_ = 'http://localhost:' + port + '/markets'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}

const CORE = [
  { universe: [{ name: 'BTC', maxLeverage: 40 }, { name: 'ETH', maxLeverage: 25 }, { name: 'DOGE', maxLeverage: 10 }] },
  [
    { markPx: '86000', prevDayPx: '80000', dayNtlVlm: '1300000000', openInterest: '38000', funding: '0.0000125' },
    { markPx: '2700', prevDayPx: '2800', dayNtlVlm: '480000000', openInterest: '1200000', funding: '0.00002' },
    { markPx: '0.2', prevDayPx: '0.25', dayNtlVlm: '9000000', openInterest: '100000000', funding: '-0.00001' },
  ],
]
const SPOT = [
  { tokens: [{ name: 'USDC', index: 0 }, { name: 'HYPE', index: 150, fullName: 'Hyperliquid', deployerTradingFeeShare: '0.0' },
             { name: 'UBTC', index: 197, deployerTradingFeeShare: '1.0' }, { name: 'DUSTY', index: 500, deployerTradingFeeShare: '0.0' }],
    universe: [{ name: '@107', tokens: [150, 0] }, { name: '@142', tokens: [197, 0] }, { name: '@900', tokens: [500, 0] }] },
  [{ coin: '@107', markPx: '90', prevDayPx: '100', dayNtlVlm: '5000000', circulatingSupply: '300000000' },
   { coin: '@142', markPx: '86000', prevDayPx: '85000', dayNtlVlm: '24000000', circulatingSupply: '21000000' },
   // an untraded community token: Strict hides it, All shows it
   { coin: '@900', markPx: '0.01', prevDayPx: '0.01', dayNtlVlm: '3', circulatingSupply: '1000' }],
]
const XYZ = [
  { universe: [{ name: 'xyz:NVDA', maxLeverage: 20 }, { name: 'xyz:SP500', maxLeverage: 50 }] },
  [{ markPx: '180', prevDayPx: '170', dayNtlVlm: '9500000', openInterest: '50000', funding: '0' },
   { markPx: '7700', prevDayPx: '7600', dayNtlVlm: '60000000', openInterest: '45000', funding: '0.00001' }],
]

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  const json = b.type === 'perpDexs' ? [null, { name: 'xyz', fullName: 'XYZ' }]
    : b.type === 'perpCategories' ? [['xyz:NVDA', 'stocks'], ['xyz:SP500', 'indices']]
    : b.type === 'metaAndAssetCtxs' ? (b.dex === 'xyz' ? XYZ : CORE)
    : b.type === 'spotMetaAndAssetCtxs' ? SPOT : {}
  return route.fulfill({ status: 200, contentType: 'application/json', json })
})
// Revenue as /markets-meta serves it (src/llama.js bySym).
await ctx.route('**/markets-meta', (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { revenue: {
  HYPE: { name: 'Hyperliquid', category: 'Derivatives', r24: 670000, r7: 9.9e6, r30: 5.2e7 },
  DOGE: { name: 'Dogeish', category: 'Launchpad', r24: 1000, r7: 7000, r30: 30000 },
}, stocks: {
  NVDA: { name: 'NVIDIA CORP', q: 96221e6, qStart: '2026-04-27', qEnd: '2026-07-26', ttm: 302969e6, yoy: 105.9,
    hist: [['2025-10-27', '2026-01-25', 68000e6, 1], ['2026-01-26', '2026-04-26', 80000e6, 0], ['2026-04-27', '2026-07-26', 96221e6, 0]] },
}, cg: { BTC: ['bitcoin', 1.66e12] } } }))
// Revenue history (/markets-revenue): 120 days for HYPE, $1,000 a day, fees $3,000.
const revAsks = []
let revFail = 0      // the next N answers are a 502, as when DefiLlama is slow or rate-limiting the server
await ctx.route('**/markets-revenue**', (route) => {
  const u = new URL(route.request().url())
  revAsks.push(u.searchParams.get('sym') + ':' + u.searchParams.get('type'))
  if (revFail > 0) { revFail--; return route.fulfill({ status: 502, contentType: 'application/json', body: '{"points":null}' }) }
  const v = u.searchParams.get('type') === 'fees' ? 3000 : 1000
  const last = Date.UTC(2026, 9, 6) / 1000
  return route.fulfill({ status: 200, contentType: 'application/json', json: { points: Array.from({ length: 120 }, (_, i) => [last - (119 - i) * 86400, v]) } })
})
const icons = []
await ctx.route('**/icon/**', (route) => { icons.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) })

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(URL_, { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => document.querySelectorAll('#mkBody tr').length >= 8 && /updated/.test(document.getElementById('mkStatusText')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})

const syms = () => p.evaluate(() => [...document.querySelectorAll('#mkBody .mk-asset b')].map(b => b.textContent))
const cell = (sym, col) => p.evaluate(({ sym, col }) => {
  const tr = [...document.querySelectorAll('#mkBody tr')].find(r => r.querySelector('.mk-asset b')?.textContent === sym)
  return tr?.children[col]?.textContent.trim() ?? null
}, { sym, col })

console.log('\n-- the ranking --')
const all = await syms()
ok('every market is listed: 3 perps, 2 spot, 2 HIP-3', all.length === 7, all)
ok('ranked by 24h volume by default', all[0] === 'BTC' && all[1] === 'ETH' && all[2] === 'SP500', all)
ok('BTC open interest is coins × price', await cell('BTC', 5) === '$3.27B', await cell('BTC', 5))
// UBTC publishes BTC's MAX supply (21M) as circulating: 21M × $86,000 = $1.81T is not a market
// cap. BTC takes CoinGecko's instead.
ok("BTC takes CoinGecko's market cap, not UBTC's max supply × price", await cell('BTC', 6) === '$1.66T', await cell('BTC', 6))
ok('an unknown market cap is a dash, not $0', await cell('NVDA', 6) === '—', await cell('NVDA', 6))
ok('UBTC is listed as BTC', all.filter(s => s === 'BTC').length === 2)

console.log('\n-- re-ranking --')
await p.click('#mkRankBtns button[data-sort="mcap"]')
const byCap = await syms()
ok('by market cap: known caps first, biggest first', byCap[0] === 'BTC' && byCap[1] === 'BTC', byCap)
ok('and the unknowns last', ['NVDA', 'SP500', 'DOGE', 'ETH'].every(s => byCap.indexOf(s) >= 3), byCap)
await p.click('#mkRankBtns button[data-sort="mcap"]')
const capAsc = await syms()
ok('pressing it again flips direction — unknowns still last', capAsc[0] === 'HYPE' && ['NVDA', 'SP500'].every(s => capAsc.indexOf(s) >= 3), capAsc)
await p.click('#mkRankBtns button[data-sort="chg24"]')
ok('by 24h change: the biggest gainer first', (await syms())[0] === 'BTC' && (await syms()).at(-1) === 'DOGE', await syms())

console.log('\n-- filtering --')
await p.click('#mkTabs button[data-tab="hip3"]')
ok('the HIP-3 tab shows only HIP-3 markets', JSON.stringify((await syms()).sort()) === JSON.stringify(['NVDA', 'SP500']), await syms())
ok('with a chip per dex', await p.evaluate(() => [...document.querySelectorAll('#mkDexes button')].some(b => /XYZ/.test(b.textContent))))
await p.click('#mkTabs button[data-tab="all"]')
await p.fill('#mkSearch', 'hyperl')
await p.waitForFunction(() => document.querySelectorAll('#mkBody .mk-asset b').length === 1, null, { timeout: 3000 }).catch(() => {})
ok('search matches the full name too', JSON.stringify(await syms()) === JSON.stringify(['HYPE']), await syms())
await p.fill('#mkSearch', '')

// The search box is debounced: wait for the cleared search to land before the next step.
await p.waitForFunction(() => document.querySelectorAll('#mkBody .mk-asset b').length > 1, null, { timeout: 3000 }).catch(() => {})

console.log('\n-- categories, revenue, strict --')
await p.click('#mkTabs button[data-tab="tradfi"]')
const tradfi = (await syms()).sort()
ok('the TradFi tab holds the HIP-3 stock and index', JSON.stringify(tradfi) === JSON.stringify(['NVDA', 'SP500']), tradfi)
ok('its category chips are TradFi sectors', await p.evaluate(() => /Stocks/.test(document.getElementById('mkSectors').textContent) && !/Layer 1/.test(document.getElementById('mkSectors').textContent)))
await p.click('#mkSectors button[data-sector="semis"]')
ok('a sector chip filters to it: Semiconductors → NVDA', JSON.stringify(await syms()) === JSON.stringify(['NVDA']), await syms())
ok('NVDA is categorised as a stock', /Stocks/.test(await cell('NVDA', 8) ?? ''), await cell('NVDA', 8))
await p.click('#mkTabs button[data-tab="all"]')
await p.click('#mkMode button[data-mode="revenue"]')
const rev = await syms()
ok('Revenue view: only tokens with revenue, ranked by it', JSON.stringify(rev) === JSON.stringify(['HYPE', 'DOGE']), rev)
ok("HYPE's category is DefiLlama's", /Derivatives/.test(await cell('HYPE', 8) ?? ''), await cell('HYPE', 8))
ok('the revenue card sums each token once (HYPE perp and spot are one token)', /\$671\.0K/.test(await p.textContent('#mkCards')), await p.textContent('#mkCards'))
await p.click('#mkMode button[data-mode="market"]')
const strictN = await p.evaluate(() => +document.querySelector('#mkTabs button[data-tab="all"] i').textContent)
await p.click('#mkStrict button[data-strict="0"]')
const allN = await p.evaluate(() => +document.querySelector('#mkTabs button[data-tab="all"] i').textContent)
ok('Strict by default; All adds the untraded spot token', allN === strictN + 1, { strictN, allN })

console.log('\n-- stocks: reported revenue on the TradFi tab --')
await p.click('#mkMode button[data-mode="revenue"]')
ok('the crypto revenue view points to the TradFi tab for stocks', await p.evaluate(() => !document.getElementById('mkHint').hidden && /TradFi/.test(document.getElementById('mkHint').textContent)))
await p.click('#mkHint button[data-tab="tradfi"]')
const stockRows = await syms()
ok('TradFi revenue lists the companies with SEC revenue', JSON.stringify(stockRows) === JSON.stringify(['NVDA']), stockRows)
const heads = await p.evaluate(() => [...document.querySelectorAll('#mkHead th')].map(t => t.textContent.trim()))
ok('with quarterly columns, not 24h/7d/30d', heads.includes('Revenue, last quarter') && heads.includes('Revenue, 12 months') && !heads.includes('Revenue 24h'), heads)
ok('last quarter $96.22B, Apr–Jul 2026, 12 months $302.97B, +105.90%',
  await cell('NVDA', 2) === '$96.22B' && await cell('NVDA', 3) === 'Apr–Jul 2026' && await cell('NVDA', 4) === '$302.97B' && await cell('NVDA', 5) === '+105.90%',
  [await cell('NVDA', 2), await cell('NVDA', 3), await cell('NVDA', 4), await cell('NVDA', 5)])
ok('ranked by last quarter', await p.evaluate(() => document.querySelector('#mkRankBtns button.is-on')?.dataset.sort) === 'sq')

console.log('\n-- revenue history charts --')
await p.click('#mkBody tr.mk-row-chart')
await p.waitForFunction(() => document.querySelectorAll('#rcOverlay .rc-bar').length > 0, null, { timeout: 10000 }).catch(() => {})
ok('a stock row opens its quarters', await p.locator('#rcOverlay .rc-bar').count() === 3 && /NVDA/.test(await p.textContent('#rcTitle')))
ok('a derived fiscal Q4 is faded and explained, not just coloured',
  await p.evaluate(() => document.querySelector('#rcOverlay .rc-bar[data-i="0"]').getAttribute('opacity') === '0.45') &&
  /Derived|\*/.test(await p.textContent('#rcOverlay .rc-tbl')) && /annual report/.test(await p.textContent('#rcOverlay .rc-src')))
await p.keyboard.press('Escape')
ok('Escape closes it', await p.locator('#rcOverlay').count() === 0)
await p.click('#mkTabs button[data-tab="all"]')
await p.waitForFunction(() => [...document.querySelectorAll('#mkBody tr.mk-row-chart .mk-asset b')].some(b => b.textContent === 'HYPE'), null, { timeout: 5000 }).catch(() => {})
await p.click('#mkBody tr.mk-row-chart:has(.mk-asset b:text-is("HYPE"))')
await p.waitForFunction(() => document.querySelectorAll('#rcOverlay .rc-bar').length > 0, null, { timeout: 10000 }).catch(() => {})
ok('a crypto row opens its daily history: 90 days by default', await p.locator('#rcOverlay .rc-bar').count() === 90, await p.locator('#rcOverlay .rc-bar').count())
ok('asked for that token\'s revenue', revAsks.includes('HYPE:revenue'), revAsks)
ok('the range total is the sum of the days: $90.0K', /\$90\.0K/.test(await p.textContent('#rcOverlay .rc-stats')), await p.textContent('#rcOverlay .rc-stats'))
const sb = await p.locator('#rcOverlay .rc-svg').boundingBox()
await p.mouse.move(sb.x + sb.width * 0.6, sb.y + sb.height * 0.6)
ok('hovering anywhere over the plot shows the nearest bar: value, then date',
  await p.evaluate(() => { const t = document.querySelector('#rcOverlay .rc-tip'); return !t.hidden && /\$1\.0K/.test(t.querySelector('b').textContent) && /2026/.test(t.textContent) }))
await p.click('#rcOverlay .rc-seg[data-k="range"] button[data-v="1Y"]')
const wk = await p.locator('#rcOverlay .rc-bar').count()
ok('a year is drawn by week, not 120 slivers', wk >= 17 && wk <= 19, wk)
await p.click('#rcOverlay .rc-seg[data-k="type"] button[data-v="fees"]')
await p.waitForFunction(() => /\$360\.0K/.test(document.querySelector('#rcOverlay .rc-stats')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {})
ok('Fees is its own chart, from its own history', revAsks.includes('HYPE:fees') && /\$360\.0K/.test(await p.textContent('#rcOverlay .rc-stats')), revAsks)
await p.click('#rcOverlay .rc-close')
ok('the close button closes it', await p.locator('#rcOverlay').count() === 0)
// A failed load: one quiet second try, then a Retry for just the chart.
revFail = 1
await p.click('#mkBody tr.mk-row-chart:has(.mk-asset b:text-is("DOGE"))')
await p.waitForFunction(() => document.querySelectorAll('#rcOverlay .rc-bar').length > 0, null, { timeout: 10000 }).catch(() => {})
ok('one failed answer is retried on its own', await p.locator('#rcOverlay .rc-bar').count() > 0 && revFail === 0)
// Both tries fail: the chart says so and offers a Retry; the rest of the panel stays.
revFail = 2
await p.click('#rcOverlay .rc-seg[data-k="type"] button[data-v="fees"]')
await p.waitForSelector('#rcOverlay .rc-retry', { timeout: 10000 }).catch(() => {})
ok('two failures: a Retry button for just the chart', await p.locator('#rcOverlay .rc-retry').count() === 1 && /did not load/.test(await p.textContent('#rcOverlay .rc-chart')))
await p.click('#rcOverlay .rc-retry')
await p.waitForFunction(() => document.querySelectorAll('#rcOverlay .rc-bar').length > 0, null, { timeout: 10000 }).catch(() => {})
ok('Retry loads it', await p.locator('#rcOverlay .rc-bar').count() > 0 && revAsks.filter(a => a === 'DOGE:fees').length === 3, revAsks)
await p.click('#rcOverlay .rc-close')

await p.click('#mkMode button[data-mode="market"]')
await p.click('#mkTabs button[data-tab="all"]')
await p.click('#mkStrict button[data-strict="1"]')

console.log('\n-- the page --')
ok('no horizontal page scroll on a phone', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0)
ok('icons are only ever READ from the app cache', icons.length > 0 && icons.every(u => /[?&]ro=1(&|$)/.test(u)), icons.slice(0, 3))
ok('no page errors', errs.length === 0, errs.slice(0, 3))

console.log('\n-- desktop: the category row scrolls without a scrollbar --')
{
  const dctx = await browser.newContext({ viewport: { width: 900, height: 900 } })
  try { await dctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}

  await dctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    const json = b.type === 'perpDexs' ? [null, { name: 'xyz', fullName: 'XYZ' }]
      : b.type === 'perpCategories' ? [['xyz:NVDA', 'stocks'], ['xyz:SP500', 'indices']]
      : b.type === 'metaAndAssetCtxs' ? (b.dex === 'xyz' ? XYZ : CORE)
      : b.type === 'spotMetaAndAssetCtxs' ? SPOT : {}
    return route.fulfill({ status: 200, contentType: 'application/json', json })
  })
  await dctx.route('**/markets-meta', (route) => route.fulfill({ status: 200, contentType: 'application/json', json: { revenue: {} } }))
  await dctx.route('**/icon/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }))
  const d = await dctx.newPage()
  d.on('pageerror', e => errs.push('desktop: ' + e.message))
  await d.goto(URL_, { waitUntil: 'domcontentloaded' })
  await d.waitForFunction(() => document.querySelectorAll('#mkSectors button[data-sector]').length > 3, null, { timeout: 20000 }).catch(() => {})
  // Narrow the row so it has to scroll, whatever the fixture's chip count.
  await d.evaluate(() => { document.getElementById('mkSectors').style.maxWidth = '260px' })
  const row = d.locator('#mkSectors .mk-sec-row').first()
  // The TradFi row appears once the HIP-3 markets (where the stocks are) have loaded.
  await d.waitForFunction(() => !!document.querySelector('#mkSectors .mk-sec-row[data-group="tradfi"]'), null, { timeout: 15000 }).catch(() => {})
  ok('TradFi has its own row, under Crypto', await d.evaluate(() => [...document.querySelectorAll('#mkSectors .mk-sec-row')].map(r => r.dataset.group).join() === 'crypto,tradfi'))
  ok('no scrollbar on the category rows', await d.evaluate(() => [...document.querySelectorAll('#mkSectors .mk-sec-row')].every(r => getComputedStyle(r).scrollbarWidth === 'none')))
  const box = await row.boundingBox()
  await d.mouse.move(box.x + 40, box.y + box.height / 2)
  await d.mouse.wheel(0, 120)
  const afterWheel = await d.evaluate(() => document.querySelector('#mkSectors .mk-sec-row').scrollLeft)
  ok('the mouse wheel scrolls it sideways', afterWheel > 0, afterWheel)
  await d.evaluate(() => { document.querySelector('#mkSectors .mk-sec-row').scrollLeft = 0 })
  const before = await d.evaluate(() => [...document.querySelectorAll('#mkSectors button[data-sector].is-on')].map(b => b.dataset.sector).join())
  await d.mouse.move(box.x + 200, box.y + box.height / 2)
  await d.mouse.down()
  await d.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 })
  await d.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 6 })
  await d.mouse.up()
  ok('dragging scrolls it too', await d.evaluate(() => document.querySelector('#mkSectors .mk-sec-row').scrollLeft) > 0)
  ok('and letting go of a drag does not select the chip under the mouse',
    await d.evaluate(() => [...document.querySelectorAll('#mkSectors button[data-sector].is-on')].map(b => b.dataset.sector).join()) === before)
  await d.click('#mkSectors button.mk-sec-group[data-tab="crypto"]')
  ok('the CRYPTO label is a button: it switches to the Crypto tab',
    await d.evaluate(() => document.querySelector('#mkTabs button[data-tab="crypto"]').classList.contains('is-on')))
  await dctx.close()
}

await p.goto('http://localhost:' + port + '/?home', { waitUntil: 'domcontentloaded' })
ok('the landing links to it', await p.evaluate(() => !!document.querySelector('.ln-links a[href="/markets"]')))

await browser.close()
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
