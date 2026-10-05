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
             { name: 'UBTC', index: 197, deployerTradingFeeShare: '1.0' }],
    universe: [{ name: '@107', tokens: [150, 0] }, { name: '@142', tokens: [197, 0] }] },
  [{ coin: '@107', markPx: '90', prevDayPx: '100', dayNtlVlm: '5000000', circulatingSupply: '300000000' },
   { coin: '@142', markPx: '86000', prevDayPx: '85000', dayNtlVlm: '24000000', circulatingSupply: '21000000' }],
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
    : b.type === 'metaAndAssetCtxs' ? (b.dex === 'xyz' ? XYZ : CORE)
    : b.type === 'spotMetaAndAssetCtxs' ? SPOT : {}
  return route.fulfill({ status: 200, contentType: 'application/json', json })
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
ok('BTC perp carries the market cap of its spot token', await cell('BTC', 6) === '$1.81T', await cell('BTC', 6))
ok('an unknown market cap is a dash, not $0', await cell('NVDA', 6) === '—', await cell('NVDA', 6))
ok('UBTC is listed as BTC', all.filter(s => s === 'BTC').length === 2)

console.log('\n-- re-ranking --')
await p.click('#mkRank button[data-sort="mcap"]')
const byCap = await syms()
ok('by market cap: known caps first, biggest first', byCap[0] === 'BTC' && byCap[1] === 'BTC', byCap)
ok('and the unknowns last', ['NVDA', 'SP500', 'DOGE', 'ETH'].every(s => byCap.indexOf(s) >= 3), byCap)
await p.click('#mkRank button[data-sort="mcap"]')
const capAsc = await syms()
ok('pressing it again flips direction — unknowns still last', capAsc[0] === 'HYPE' && ['NVDA', 'SP500'].every(s => capAsc.indexOf(s) >= 3), capAsc)
await p.click('#mkRank button[data-sort="chg24"]')
ok('by 24h change: the biggest gainer first', (await syms())[0] === 'BTC' && (await syms()).at(-1) === 'DOGE', await syms())

console.log('\n-- filtering --')
await p.click('#mkTabs button[data-kind="hip3"]')
ok('the HIP-3 tab shows only HIP-3 markets', JSON.stringify((await syms()).sort()) === JSON.stringify(['NVDA', 'SP500']), await syms())
ok('with a chip per dex', await p.evaluate(() => [...document.querySelectorAll('#mkDexes button')].some(b => /XYZ/.test(b.textContent))))
await p.click('#mkTabs button[data-kind="all"]')
await p.fill('#mkSearch', 'hyperl')
await p.waitForFunction(() => document.querySelectorAll('#mkBody .mk-asset b').length === 1, null, { timeout: 3000 }).catch(() => {})
ok('search matches the full name too', JSON.stringify(await syms()) === JSON.stringify(['HYPE']), await syms())
await p.fill('#mkSearch', '')

console.log('\n-- the page --')
ok('no horizontal page scroll on a phone', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0)
ok('icons are only ever READ from the app cache', icons.length > 0 && icons.every(u => /[?&]ro=1(&|$)/.test(u)), icons.slice(0, 3))
ok('no page errors', errs.length === 0, errs.slice(0, 3))

await p.goto('http://localhost:' + port + '/?home', { waitUntil: 'domcontentloaded' })
ok('the landing links to it', await p.evaluate(() => !!document.querySelector('.ln-links a[href="/markets"]')))

await browser.close()
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
