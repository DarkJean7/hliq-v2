// /portfolios, driven for real: a shared link opens a basket, the backtest runs on the prices
// below, and the builder, the Simulator strategies, saving and a failed price load all work.
// Rules: tests/suites/pfbacktest.test.mjs, src/pfbacktest.js.
//
// Hermetic. Prices are functions of time, so every figure is derivable:
//   BTC  rises in a straight line, 100 → 200 over 400 days
//   ETH  flat at 50
//   SOL  flat at 20
//   NOPE listed, but Hyperliquid returns no candles for it
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/portfolios'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.PF_SHOT || ''
const DAY = 86_400_000

let pass = 0, fail = 0
const ok = (n, cond, got = '') => { cond ? pass++ : fail++; console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got))) }
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const NOW = Date.now()
const T0 = Math.floor(NOW / DAY) * DAY - 400 * DAY
const PRICE = { BTC: (t) => 100 * (1 + Math.max(0, t - T0) / (400 * DAY)), ETH: () => 50, SOL: () => 20 }
const TF = { '1d': DAY, '4h': 4 * 3_600_000, '1h': 3_600_000 }
const ctx0 = (px) => ({ funding: '0.00001', openInterest: '1000', prevDayPx: String(px), dayNtlVlm: '5000000', premium: '0', oraclePx: String(px), markPx: String(px), midPx: String(px), impactPxs: [String(px), String(px)] })
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'SOL', szDecimals: 2, maxLeverage: 20 }, { name: 'NOPE', szDecimals: 0, maxLeverage: 3 }]
const HL = {
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctx0(200), ctx0(50), ctx0(20), ctx0(1)]],
  spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  perpDexs: [null], perpCategories: [],
}
// The basket as a share link: BTC and ETH, half each, buy & hold and monthly, 1Y, BTC benchmark.
const share = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const LINK = share({ n: 'Test basket', i: [['BTC', 50, 0], ['ETH', 50, 0]], s: { period: '365', from: null, to: null, capital: 10000, lev: 1, fee: 0.045, strats: ['hold', 'monthly'], bots: [], bench: true, tf: '4h' } })

async function run(label, opts) {
  console.log('\n-- ' + label + ' --')
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  const asks = []
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (b.type === 'candleSnapshot') {
      const { coin, interval, startTime, endTime } = b.req
      asks.push(coin + ':' + interval)
      const f = PRICE[coin]
      if (!f) return route.fulfill({ status: 200, contentType: 'application/json', json: [] })
      const step = TF[interval]
      const out = []
      for (let t = Math.max(T0, Math.floor(startTime / step) * step); t <= endTime && out.length < 5000; t += step) {
        const c = f(t)
        out.push({ t, T: t + step - 1, s: coin, i: interval, o: String(c), h: String(c * 1.01), l: String(c * 0.99), c: String(c), v: '1', n: 1 })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', json: out })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/markets-meta', r => r.fulfill({ status: 200, json: { revenue: {}, cg: {}, stocks: {}, sic: {} } }))
  await ctx.route('**/icon/**', r => r.fulfill({ status: 404, body: '' }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => { localStorage.clear() })
  await p.goto(BASE + '#p=' + LINK, { waitUntil: 'domcontentloaded' })
  await p.reload({ waitUntil: 'domcontentloaded' })
  asks.length = 0        // count this page's requests, not the one before the reload

  await waitFor(p, 'the backtest', () => window.__pf?.last?.runs?.length === 2)
  const L = await p.evaluate(() => { const l = window.__pf.last; return { days: l.days.length, first: l.days[0], last: l.days[l.days.length - 1], runs: l.runs.map(r => ({ id: r.id, final: r.final, fees: r.fees })), bench: l.bench?.final } })
  ok('a share link opens its basket and its settings', await p.evaluate(() => window.__pf.state.name) === 'Test basket' && L.runs.map(r => r.id).join() === 'hold,monthly', L.runs)
  ok('one year is 366 daily closes', L.days === 366, L.days)
  // Hold: half in BTC, which went from PRICE(first) to PRICE(last); half in flat ETH; one fee of 0.045% on $10,000.
  const want = 5000 * PRICE.BTC(L.last) / PRICE.BTC(L.first) + 5000 - 4.5
  const hold = L.runs.find(r => r.id === 'hold')
  ok('buy & hold is worked out from the closes: half BTC, half ETH, less one fee', Math.abs(hold.final - want) < 0.01, [hold.final, want])
  ok('BTC held, alongside', Math.abs(L.bench - (10000 * PRICE.BTC(L.last) / PRICE.BTC(L.first) - 4.5)) < 0.01, L.bench)
  const txt = (await p.textContent('#pfResults')).replace(/\s+/g, ' ')
  ok('the table names each strategy and its result', /Buy & hold/.test(txt) && /Rebalance monthly/.test(txt) && /BTC, held/.test(txt) && txt.includes('$' + Math.round(hold.final).toLocaleString('en-US')), txt.slice(0, 400))
  const d1 = asks.filter(a => a.endsWith(':1d'))
  ok('daily prices are fetched once per coin, never twice', d1.length >= 1 && new Set(d1).size === d1.length, asks)

  // The composition ring.
  ok('the composition shows the weights', /BTC/.test(await p.textContent('#pfComp')) && /50\.0%/.test(await p.textContent('#pfComp')))

  // A trading strategy from the Simulator, on 4-hour candles.
  await p.click('[data-bot="supertrend"]')
  await waitFor(p, 'the Simulator run', () => window.__pf.last?.runs?.some(r => r.id === 'bot:supertrend'))
  const bot = await p.evaluate(() => { const r = window.__pf.last.runs.find(r => r.id === 'bot:supertrend'); return { n: r.equity.length, first: r.equity[0], days: window.__pf.last.days.length } })
  ok('a Simulator strategy runs on every holding, on 4-hour candles', bot.n === bot.days && Math.abs(bot.first - 10000) < 50 && asks.includes('BTC:4h') && asks.includes('ETH:4h'), [bot, asks.slice(-4)])

  // Building: search adds an asset; a sector chip replaces the basket.
  await p.fill('#pfSearch', 'SOL')
  await p.press('#pfSearch', 'Enter')
  await waitFor(p, 'SOL added', () => window.__pf.state.items.length === 3)
  ok('search adds an asset', (await p.evaluate(() => window.__pf.state.items.map(i => i.coin))).join() === 'BTC,ETH,SOL')
  await p.click('[data-side="2"]')
  ok('a holding can be turned short', await p.evaluate(() => window.__pf.state.items[2].side) === 'short')
  await p.click('#pfWeighting [data-w="equal"]')
  ok('equal weighting', (await p.evaluate(() => window.__pf.state.items.map(i => i.w))).every(w => Math.abs(w - 33.33) < 0.02))

  // Save, then reload: the saved portfolio is still there.
  await p.fill('#pfName', 'Three')
  await p.click('#pfSave')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the card', () => document.querySelectorAll('#pfGallery [data-load]').length > 0)
  ok('a saved portfolio survives a reload, as a card', (await p.textContent('#pfGallery')).includes('Three'))
  ok('and once edited, a reload keeps your draft rather than the shared link', await p.evaluate(() => window.__pf.state.name) === 'Three' && !/p=/.test(await p.evaluate(() => location.hash)))

  // The card: buy & hold over 1 year by default. A third each in BTC, ETH (flat) and SOL short
  // (flat), so the return is a third of BTC's, less one fee of 0.045%.
  const dayOf = (t) => Math.floor(t / DAY) * DAY
  const yr = (PRICE.BTC(dayOf(NOW)) / PRICE.BTC(dayOf(NOW) - 365 * DAY) - 1) / 3 - 0.00045
  const pctTxt = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'
  await waitFor(p, 'the card\'s return', () => /%/.test(document.querySelector('#pfGallery .pf-gc-ret')?.textContent ?? ''))
  const card1 = (await p.textContent('#pfGallery [data-load="0"]')).replace(/\s+/g, ' ')
  ok('the card shows its 1-year return, worked out from the closes', card1.includes(pctTxt(yr)) && /1 year/.test(card1), [card1, pctTxt(yr)])
  ok('with its holdings, its weights and its line', await p.locator('#pfGallery [data-load="0"] .mk-ico').count() === 3 && await p.locator('#pfGallery [data-load="0"] .pf-gc-bar i').count() === 3 && await p.locator('#pfGallery [data-load="0"] .pf-spark path').count() === 2)
  ok('and says it is the one being edited', /editing/.test(card1))
  await p.click('#pfGalTf [data-g="30"]')
  const m1 = (PRICE.BTC(dayOf(NOW)) / PRICE.BTC(dayOf(NOW) - 30 * DAY) - 1) / 3 - 0.00045
  const card30 = (await p.textContent('#pfGallery [data-load="0"]')).replace(/\s+/g, ' ')
  ok('the timeframe changes every card: 30 days', card30.includes(pctTxt(m1)) && /30 days/.test(card30), [card30, pctTxt(m1)])
  ok('and is remembered', await p.evaluate(() => localStorage.getItem('hliq_pf_gallery_tf')) === '"30"')
  if (SHOT) { await p.locator('#pfGallerySec').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOT}/portfolio-gallery-${label}.png` }) }
  // Open a portfolio from its card.
  await p.click('#pfNew')
  ok('New empties the builder', await p.evaluate(() => window.__pf.state.items.length) === 0)
  await p.click('#pfGallery [data-load="0"] .pf-gc-name')
  ok('clicking a card opens it in the builder', await waitFor(p, 'loaded', () => window.__pf.state.name === 'Three' && window.__pf.state.items.length === 3, null, 5000))

  // A holding Hyperliquid has no prices for: the page names it and offers a retry.
  await p.fill('#pfSearch', 'NOPE')
  await waitFor(p, 'NOPE in the list', () => !!document.querySelector('[data-sug="0"]'))
  await p.press('#pfSearch', 'Enter')
  await waitFor(p, 'the failure', () => /No price history came back for NOPE/.test(document.getElementById('pfResults').textContent))
  ok('no history: says which holding, offers a retry', await p.locator('#pfRetry').count() === 1)

  // Delete takes two taps.
  await p.click('#pfGallery [data-del="0"]')
  ok('the first tap on × only asks', await p.locator('#pfGallery [data-load]').count() === 1 && /Delete\?/.test(await p.textContent('#pfGallery [data-del="0"]')))
  await p.click('#pfGallery [data-del="0"]')
  ok('the second deletes it', await p.locator('#pfGallery [data-load]').count() === 0 && /Portfolios you save appear here/.test(await p.textContent('#pfGallery')))

  ok('no horizontal page scroll', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth))
  if (SHOT) await p.screenshot({ path: `${SHOT}/portfolio-${label}.png`, fullPage: true })
  if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
  await browser.close()
}

await run('desktop', { viewport: { width: 1440, height: 1000 } })
await run('mobile', { ...devices['iPhone 14 Pro'] })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
