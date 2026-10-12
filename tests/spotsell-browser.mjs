// Selling spot (src/spotsell.js + the spot branch in src/trading.js), driven through the real app.
//
// Reported: "spot is not working in desktop", "add an easy way of selling spot tokens like
// closing a position … a certain amount or max available", and the trade ticket "allowing to
// sell more than i have in spot and kinda showing it as a short".
//
// A paper account holding 30.96 KNTQ (pair @334, as paper keys spot) against a stubbed
// Hyperliquid. Asserts: the desktop Spot tab lists markets; a holding's Sell opens a sheet whose
// Max is what is held; selling more is refused; a market sell empties the holding into USDC;
// and the ticket's Short side on a spot market opens the sell sheet instead of a short.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 400))) }
const until = async (label, fn, ms = 20000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 200)) }
}
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const TOKENS = [{ name: 'USDC', index: 0, szDecimals: 8, weiDecimals: 8, deployerTradingFeeShare: '0' }, { name: 'KNTQ', index: 412, szDecimals: 2, weiDecimals: 6, deployerTradingFeeShare: '0' }]
const SPOT = [{ name: '@334', index: 334, tokens: [412, 0], isCanonical: false }]
const HL = {
  allMids: { BTC: '100000', '@334': '0.5' }, meta: { universe: UNIVERSE }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  spotMeta: { tokens: TOKENS, universe: SPOT },
  spotMetaAndAssetCtxs: [{ tokens: TOKENS, universe: SPOT }, [{ coin: '@334', markPx: '0.5', midPx: '0.5', prevDayPx: '0.5', dayNtlVlm: '50000', circulatingSupply: '1000000', totalSupply: '1000000' }]],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100000', dayNtlVlm: '0', premium: '0', oraclePx: '100000', markPx: '100000', midPx: '100000', impactPxs: ['100000', '100000'] }]],
  candleSnapshot: [], outcomeMeta: {}, perpCategories: [], clearinghouseState: { assetPositions: [], marginSummary: { accountValue: '0' } },
}

const browser = await chromium.launch()
for (const [w, h, mob] of [[1400, 900, false], [430, 930, true]]) {
  console.log(`\n== ${mob ? 'phone' : 'desktop'} ==`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route(/\/api\/|\/paper\//, route => route.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.clear()
    for (const [k, v] of Object.entries({ hliq_lang: 'en', hliq_lang_chosen: '1', hliq_onboard_done: '1', hliq_onboard_welcomed_v1: '1', hliq_onboard_tour_v1: '1', hliq_install_nudge_v2: '9999999999999', hliq_ann_dismissed: '["*"]' }))
      localStorage.setItem(k, v)
    localStorage.setItem('hliq_paper_v2', JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: Date.now(),
      balances: { '@334': { total: 30.96, entryNtl: 11.37 } } }))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await until('boot', () => p.evaluate(() => !!window.__goPaper && !!window.__spotSell))
  await p.evaluate(() => window.__goPaper('main'))

  if (!mob) {
    console.log('-- the desktop Spot tab lists spot markets --')
    await p.evaluate(() => window.switchTab('trade'))
    await until('the market picker', () => p.evaluate(() => typeof window.toggleCoinDropdown === 'function' || !!document.getElementById('coinDropdownList')))
    const listed = await p.evaluate(async () => {
      window.__dropType('spot')
      await new Promise(r => setTimeout(r, 400))
      return document.getElementById('coinDropdownList')?.textContent ?? ''
    })
    ok('it no longer says "Spot markets not available", and lists KNTQ', !/Spot markets not available/.test(listed) && /KNTQ/.test(listed), listed.slice(0, 200))
  }

  console.log('-- Sell from the holding --')
  await p.evaluate(() => window.__spotSell('@334'))
  await until('the sheet', () => p.evaluate(() => !!document.getElementById('spotSellBox')))
  const head = await p.textContent('#spotSellBox')
  ok('the sheet names the token and what is free to sell', /Sell KNTQ/.test(head) && /30\.96 KNTQ/.test(head), head.slice(0, 160))
  await p.click('#spotSellBox [data-ss="pct"][data-v="100"]')
  ok('Max is exactly what is held, not a margin figure', await p.inputValue('#ssAmt') === '30.96')
  ok('and it previews what you get and what you keep — never a short', /You get/.test(await p.textContent('#spotSellBox')) && /You keep\s*0 KNTQ/.test(await p.textContent('#spotSellBox')) && !/SHORT/i.test(await p.textContent('#spotSellBox')))
  await p.fill('#ssAmt', '50')
  ok('selling more than is held is refused, with what is held', /You have 30\.96 KNTQ free to sell/.test(await p.textContent('#spotSellBox')) && await p.isDisabled('#spotSellBox [data-ss="go"]'))
  await p.fill('#ssAmt', '10')
  ok('under Hyperliquid\'s $10 minimum is refused too ($5 here)', /minimum order is \$10/.test(await p.textContent('#spotSellBox')) && await p.isDisabled('#spotSellBox [data-ss="go"]'))
  await p.click('#spotSellBox [data-ss="pct"][data-v="100"]')
  await p.click('#spotSellBox [data-ss="go"]')
  await until('the sale', () => p.evaluate(() => !document.getElementById('spotSellOv')))
  const after = await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_paper_v2')))
  ok('a market sell of Max empties the holding into USDC', !(after.balances?.['@334']?.total > 1e-9) && after.balance > 1014 && after.balance < 1016, [after.balances, after.balance])

  console.log('-- the ticket on a spot market --')
  await p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('hliq_paper_v2')); s.balances = { '@334': { total: 30.96, entryNtl: 11.37 } }; s.balance = 1000
    localStorage.setItem('hliq_paper_v2', JSON.stringify(s))
  })
  await p.evaluate((mob) => mob ? window._mobVSelectTradeCoin('@334') : window.__selectCoin('@334'), mob)
  if (mob) await p.evaluate(() => window._mobOpenOrderSheet('short'))
  else await p.evaluate(() => window.setSide?.('short') ?? document.getElementById('sideBtn-short')?.click())
  await until('the sell sheet from the ticket', () => p.evaluate(() => !!document.getElementById('spotSellBox')), 8000)
  ok('Short on a spot market opens the sell sheet (spot cannot be shorted)', await p.evaluate(() => !!document.getElementById('spotSellBox')))
  await p.evaluate(() => document.querySelector('#spotSellBox [data-ss="close"]')?.click())
  ok('no page errors', !errs.length, errs)
  await ctx.close()
}
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
