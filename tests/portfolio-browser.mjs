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
import { cleanPortfolio, upsertFeatured } from '../src/pfshared.js'

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
const PRICE = { BTC: (t) => 100 * (1 + Math.max(0, t - T0) / (400 * DAY)), ETH: () => 50, SOL: () => 20, 'xyz:NVDA': () => 180, '@700': () => 2 }
// NVDA's exchange history ("TradingView", /pf-history): 400 days, rising in a straight line.
const NV = (t) => 200 * (1 + (t - T0) / (400 * DAY))
// Listed later than the rest: NVDA's history starts 50 days ago.
const START = { 'xyz:NVDA': Math.floor(NOW / DAY) * DAY - 50 * DAY }
const TF = { '1d': DAY, '4h': 4 * 3_600_000, '1h': 3_600_000 }
const ctx0 = (px) => ({ funding: '0.00001', openInterest: '1000', prevDayPx: String(px), dayNtlVlm: '5000000', premium: '0', oraclePx: String(px), markPx: String(px), midPx: String(px), impactPxs: [String(px), String(px)] })
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'SOL', szDecimals: 2, maxLeverage: 20 }, { name: 'NOPE', szDecimals: 0, maxLeverage: 3 }]
const XYZ = [{ universe: [{ name: 'xyz:HO', szDecimals: 2, maxLeverage: 10 }, { name: 'xyz:SMSN', szDecimals: 3, maxLeverage: 10 }, { name: 'xyz:NVDA', szDecimals: 3, maxLeverage: 20 }] },
  [ctx0(4.76), ctx0(192), ctx0(180)]]
const HL = {
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctx0(200), ctx0(50), ctx0(20), ctx0(1)]],
  // One thin spot market: "@700" is the market id, DRV its token. Too little volume for the
  // strict list, so it is not offered in search — but a portfolio holding it still names it.
  spotMetaAndAssetCtxs: [{ tokens: [{ index: 0, name: 'USDC' }, { index: 150, name: 'DRV' }], universe: [{ name: '@700', index: 700, tokens: [150, 0] }] },
    [{ coin: '@700', markPx: '2', prevDayPx: '2', midPx: '2', dayNtlVlm: '50', circulatingSupply: '1000' }]],
  // One HIP-3 dex with markets Hyperliquid names differently from their ticker.
  perpDexs: [null, { name: 'xyz', fullName: 'XYZ' }],
  perpConciseAnnotations: [['xyz:HO', { category: 'commodities', displayName: 'DIESEL', keywords: ['ho', 'ulsd'] }],
                           ['xyz:SMSN', { category: 'stocks', displayName: 'SAMSUNG' }], ['xyz:NVDA', { category: 'stocks' }]],
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
      for (let t = Math.max(T0, START[coin] ?? 0, Math.floor(startTime / step) * step); t <= endTime && out.length < 5000; t += step) {
        const c = f(t)
        out.push({ t, T: t + step - 1, s: coin, i: interval, o: String(c), h: String(c * 1.01), l: String(c * 0.99), c: String(c), v: '1', n: 1 })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', json: out })
    }
    if (b.type === 'metaAndAssetCtxs' && b.dex === 'xyz') return route.fulfill({ status: 200, contentType: 'application/json', json: XYZ })
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/pf-history**', (r) => {
    const u = new URL(r.request().url())
    if (u.searchParams.get('src') !== 'yahoo' || u.searchParams.get('sym') !== 'NVDA') return r.fulfill({ status: 404, json: { pts: null } })
    const pts = []
    for (let t = T0; t <= Math.floor(NOW / DAY) * DAY; t += DAY) pts.push([t, NV(t)])
    return r.fulfill({ status: 200, json: { src: 'yahoo', key: 'NVDA', pts, currency: 'USD' } })
  })
  await ctx.route('**/markets-meta', r => r.fulfill({ status: 200, json: { revenue: {}, cg: {}, stocks: {}, sic: {} } }))
  // The featured list, as serve-prod.js keeps it: public to read, writes only with the dev PIN,
  // through the same cleanPortfolio/upsertFeatured the server uses.
  let featured = [{ id: 'feat0001', name: 'Featured One', desc: 'Picked by us.', at: 1, items: [{ coin: 'BTC', sym: 'BTC', kind: 'perp', w: 60, side: 'long' }, { coin: 'ETH', sym: 'ETH', kind: 'perp', w: 40, side: 'long' }] }]
  const writes = []
  await ctx.route('**/portfolios-data**', (route) => {
    const req = route.request(), path = new URL(req.url()).pathname
    if (req.method() === 'GET') return route.fulfill({ status: 200, json: { portfolios: featured } })
    let b = {}
    try { b = JSON.parse(req.postData() || '{}') } catch {}
    writes.push({ path, pin: req.headers()['x-lb-pin'] ?? '', body: b })
    if (req.headers()['x-lb-pin'] !== 'devpin') return route.fulfill({ status: 403, json: { error: 'forbidden' } })
    if (path.endsWith('/save')) featured = upsertFeatured(featured, cleanPortfolio(b.portfolio)) ?? featured
    else featured = featured.filter(x => x.id !== b.id)
    return route.fulfill({ status: 200, json: { portfolios: featured } })
  })
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
  // Asset performance under the sector mix: each holding's own move, from the daily closes.
  const dOf = (t) => Math.floor(t / DAY) * DAY
  const pctT = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'
  await waitFor(p, 'the performance rows', () => document.querySelectorAll('#pfComp .pf-perf-row').length === 2 && /%/.test(document.querySelector('#pfComp .pf-perf-val')?.textContent ?? ''))
  const perf = () => p.evaluate(() => [...document.querySelectorAll('#pfComp .pf-perf-row')].map(r => [r.querySelector('b').textContent, r.querySelector('.pf-perf-val').textContent]))
  const y1 = PRICE.BTC(dOf(NOW)) / PRICE.BTC(dOf(NOW) - 365 * DAY) - 1
  const pr = await perf()
  ok('asset performance: each holding\'s 1-year move, best first', pr[0][0] === 'BTC' && pr[0][1] === pctT(y1) && pr[1][0] === 'ETH' && pr[1][1] === '+0.0%', pr)
  await p.click('#pfPerfTf [data-perf="30"]')
  const m30 = PRICE.BTC(dOf(NOW)) / PRICE.BTC(dOf(NOW) - 30 * DAY) - 1
  ok('and over 30 days', (await perf())[0][1] === pctT(m30), await perf())
  ok('a visitor has no Publish button', await p.locator('#pfPublish').isHidden())

  // Markets by the name Hyperliquid shows, and by its keywords (perpConciseAnnotations).
  await waitFor(p, 'the HIP-3 dex', () => [...document.querySelectorAll('#pfSectors button')].some(b => /Stocks/.test(b.textContent)))
  const suggest = async (q) => { await p.fill('#pfSearch', q); await p.waitForTimeout(150); const t = await p.textContent('#pfSuggest'); await p.press('#pfSearch', 'Escape'); return t.replace(/\s+/g, ' ') }
  ok('"diesel" finds xyz:HO, shown as DIESEL', /DIESEL/.test(await suggest('diesel')))
  ok('so do its keywords: "ulsd"', /DIESEL/.test(await suggest('ulsd')))
  ok('"samsung" finds xyz:SMSN', /SAMSUNG/.test(await suggest('samsung')))
  await p.fill('#pfSearch', '')
  const tradfi = await p.evaluate(() => [...document.querySelectorAll('#pfSectors .pf-sec-group')].map(g => g.textContent.replace(/\s+/g, ' ').trim()))
  ok('sectors come in two rows, and TradFi is one of them', tradfi.length === 2 && /^Crypto/.test(tradfi[0]) && /^TradFi.*Stocks/.test(tradfi[1]), tradfi)
  ok('both rows scroll with the wheel and a drag', await p.evaluate(() => getComputedStyle(document.querySelector('.pf-sec-row')).overflowX) === 'auto')

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
  await p.fill('#pfDesc', 'Two majors and a short hedge.')
  ok('a description shows on the composition', /Two majors and a short hedge\./.test(await p.textContent('#pfComp')))

  // Save, then reload: the saved portfolio is still there.
  await p.fill('#pfName', 'Three')
  await p.click('#pfSave')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the card', () => document.querySelectorAll('#pfGallery [data-load]').length > 0)
  ok('a saved portfolio survives a reload, as a card', (await p.textContent('#pfGallery')).includes('Three'))
  ok('with its description', (await p.textContent('#pfGallery')).includes('Two majors and a short hedge.') && await p.inputValue('#pfDesc') === 'Two majors and a short hedge.')
  ok('and once edited, a reload keeps your draft rather than the shared link', await p.evaluate(() => window.__pf.state.name) === 'Three' && !/p=/.test(await p.evaluate(() => location.hash)))

  // The card: buy & hold over 1 year by default. A third each in BTC, ETH (flat) and SOL short
  // (flat), so the return is a third of BTC's, less one fee of 0.045%.
  const dayOf = (t) => Math.floor(t / DAY) * DAY
  const yr = (PRICE.BTC(dayOf(NOW)) / PRICE.BTC(dayOf(NOW) - 365 * DAY) - 1) / 3 - 0.00045
  const pctTxt = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'
  await waitFor(p, 'the card\'s return', () => /%/.test(document.querySelector('#pfGallery .pf-gc-ret')?.textContent ?? ''))
  const card1 = (await p.textContent('#pfGallery [data-load="l:0"]')).replace(/\s+/g, ' ')
  ok('the card shows its 1-year return, worked out from the closes', card1.includes(pctTxt(yr)) && /1 year/.test(card1), [card1, pctTxt(yr)])
  ok('with its holdings, its weights and its line', await p.locator('#pfGallery [data-load="l:0"] .mk-ico').count() === 3 && await p.locator('#pfGallery [data-load="l:0"] .pf-gc-bar i').count() === 3 && await p.locator('#pfGallery [data-load="l:0"] .pf-spark path').count() === 2)
  ok('and says it is the one being edited', /editing/.test(card1))
  await p.click('#pfGalTf [data-g="30"]')
  const m1 = (PRICE.BTC(dayOf(NOW)) / PRICE.BTC(dayOf(NOW) - 30 * DAY) - 1) / 3 - 0.00045
  const card30 = (await p.textContent('#pfGallery [data-load="l:0"]')).replace(/\s+/g, ' ')
  ok('the timeframe changes every card: 30 days', card30.includes(pctTxt(m1)) && /30 days/.test(card30), [card30, pctTxt(m1)])
  ok('and is remembered', await p.evaluate(() => localStorage.getItem('hliq_pf_gallery_tf')) === '"30"')
  if (SHOT) { await p.locator('#pfGallerySec').scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOT}/portfolio-gallery-${label}.png` }) }
  // Open a portfolio from its card.
  await p.click('#pfNew')
  ok('New empties the builder', await p.evaluate(() => window.__pf.state.items.length) === 0)
  await p.click('#pfGallery [data-load="l:0"] .pf-gc-name')
  ok('clicking a card opens it in the builder', await waitFor(p, 'loaded', () => window.__pf.state.name === 'Three' && window.__pf.state.items.length === 3, null, 5000))

  // A holding Hyperliquid has no prices for: the page names it and offers a retry.
  await p.fill('#pfSearch', 'NOPE')
  await waitFor(p, 'NOPE in the list', () => !!document.querySelector('[data-sug="0"]'))
  await p.press('#pfSearch', 'Enter')
  await waitFor(p, 'the failure', () => /No price history came back for NOPE/.test(document.getElementById('pfResults').textContent))
  ok('no history: says which holding, offers a retry', await p.locator('#pfRetry').count() === 1)

  // Delete takes two taps.
  await p.click('#pfGallery [data-del="l:0"]')
  ok('the first tap on × only asks', await p.locator('#pfGallery [data-load]').count() === 1 && /Delete\?/.test(await p.textContent('#pfGallery [data-del="l:0"]')))
  await p.click('#pfGallery [data-del="l:0"]')
  ok('the second deletes it', await p.locator('#pfGallery [data-load]').count() === 0 && /Portfolios you save appear here/.test(await p.textContent('#pfGallery')))

  // ── featured portfolios: everyone sees them; only the developer changes them ──
  ok('a visitor sees the featured portfolio, with its description and return', await waitFor(p, 'featured', () => /Featured One/.test(document.getElementById('pfFeatured').textContent) && /%/.test(document.querySelector('#pfFeatured .pf-gc-ret')?.textContent ?? '')) && /Picked by us\./.test(await p.textContent('#pfFeatured')))
  ok('but cannot remove or republish it', await p.locator('#pfFeatured [data-del], #pfFeatured [data-pub]').count() === 0)
  await p.click('#pfFeatured [data-load="f:feat0001"] .pf-gc-name')
  await waitFor(p, 'opened', () => window.__pf.state.featuredId === 'feat0001')
  ok('opening it says changes stay theirs, and Save becomes "Save a copy"', /nothing here changes it/.test(await p.textContent('#pfMode')) && (await p.textContent('#pfSave')).trim() === 'Save a copy')
  await p.fill('#pfHoldings [data-w="0"]', '90')
  await p.locator('#pfHoldings [data-w="0"]').dispatchEvent('change')
  await waitFor(p, 'the re-run', () => window.__pf.last?.runs?.length > 0)
  ok('they can change it and test it', await p.evaluate(() => window.__pf.state.items[0].w) === 90 && /testing changes/.test(await p.textContent('#pfFeatured')))
  await p.click('#pfSave')
  ok('"Save a copy" keeps it on this device, and writes nothing to the server', writes.length === 0 && await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_pf_saved'))[0]?.name) === 'Featured One' && await p.evaluate(() => window.__pf.state.featuredId) === null)
  ok('the featured one is unchanged', featured.length === 1 && featured[0].items[0].w === 60)

  // A card whose newest holding was listed inside the window says the span it really tested.
  featured.push({ id: 'feat0002', name: 'Alpha Late', at: 2, items: [{ coin: 'xyz:NVDA', sym: 'NVDA', kind: 'hip3', w: 50, side: 'long' }, { coin: 'BTC', sym: 'BTC', kind: 'perp', w: 50, side: 'long' }] })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.click('#pfGalTf [data-g="365"]')
  await waitFor(p, 'both featured cards', () => [...document.querySelectorAll('#pfFeatured .pf-gc-ret')].filter(x => /%/.test(x.textContent)).length === 2)
  const late = (await p.textContent('#pfFeatured [data-load="f:feat0002"] .pf-gc-sub')).replace(/\s+/g, ' ')
  const full = (await p.textContent('#pfFeatured [data-load="f:feat0001"] .pf-gc-sub')).replace(/\s+/g, ' ')
  // A holding listed 50 days ago joins then; the card still covers the year, and says so.
  ok('a holding listed 50 days ago does not cut the year short: it joined later, and the card says so', /^1 year · 1 joined later · /.test(late) && /NVDA/.test(await p.getAttribute('#pfFeatured [data-load="f:feat0002"] .pf-gc-sub', 'title')), late)
  ok('a card with a full year still says "1 year"', /^1 year · /.test(full), full)
  await p.click('#pfFeatured [data-load="f:feat0002"] .pf-gc-name')
  await waitFor(p, 'the late basket\'s run', () => window.__pf.last?.joined?.length === 1)
  ok('the backtest covers the whole year and names who joined, and when', /Joined when listed: NVDA on /.test(await p.textContent('#pfResults')) && await p.evaluate(() => window.__pf.last.days.length) >= 360)
  await p.check('#pfWait')
  await waitFor(p, 'the waiting run', () => window.__pf.last && window.__pf.last.days.length <= 51 && window.__pf.state.listingWait)
  ok('"Wait until every holding is listed" starts the test when NVDA listed', await p.evaluate(() => window.__pf.last.days.length) <= 51 && /waits until every holding trades/.test(await p.textContent('#pfResults')))
  await p.uncheck('#pfWait')
  await waitFor(p, 'back to the year', () => window.__pf.last && window.__pf.last.days.length >= 360)
  // Sorting.
  const order = () => p.evaluate(() => [...document.querySelectorAll('#pfFeatured [data-load]')].map(c => c.querySelector('.pf-gc-name b').textContent))
  const rets = () => p.evaluate(() => [...document.querySelectorAll('#pfFeatured .pf-gc-ret')].map(c => parseFloat(c.textContent)))
  ok('newest first by default: as published', (await order()).join() === 'Featured One,Alpha Late')
  await p.selectOption('#pfGalSort', 'name')
  ok('sort by name', (await order()).join() === 'Alpha Late,Featured One', await order())
  await p.selectOption('#pfGalSort', 'ret-desc')
  const rd = await rets()
  ok('sort by best return', rd.length === 2 && rd[0] >= rd[1], rd)
  await p.selectOption('#pfGalSort', 'ret-asc')
  const ra = await rets()
  ok('and by worst', ra[0] <= ra[1] && ra[0] === rd[1], ra)
  ok('the sort is remembered', await p.evaluate(() => localStorage.getItem('hliq_pf_gallery_sort')) === '"ret-asc"')
  await p.selectOption('#pfGalSort', 'default')
  featured = featured.filter(x => x.id !== 'feat0002')
  await p.reload({ waitUntil: 'domcontentloaded' })
  // Each list can be folded away, and stays folded.
  await waitFor(p, 'featured back', () => document.querySelectorAll('#pfFeatured [data-load]').length === 1)
  await p.click('#pfHideFeatured')
  ok('Hide folds Featured to one line', await p.locator('#pfFeatured [data-load]').count() === 0 && /1 featured portfolio hidden/.test(await p.textContent('#pfFeatured')) && (await p.textContent('#pfHideFeatured')).trim() === 'Show')
  await p.click('#pfHideLocal')
  ok('and the device-only list too', await p.locator('#pfGallery [data-load]').count() === 0 && /portfolio of yours hidden/.test(await p.textContent('#pfGallery')))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'folded after reload', () => !!document.querySelector('#pfFeatured .pf-gal-folded') && !!document.querySelector('#pfGallery .pf-gal-folded'))
  ok('both stay hidden after a reload', await p.locator('.pf-gal-folded').count() === 2)
  await p.click('#pfFeatured .pf-gal-folded')
  await p.click('#pfHideLocal')
  ok('and come back with Show', await waitFor(p, 'shown', () => document.querySelectorAll('#pfFeatured [data-load]').length === 1 && document.querySelectorAll('#pfGallery [data-load]').length === 1, null, 5000))

  // A spot holding is named by its token, never by its market id — even stored as "@700",
  // the way a share link stores it.
  featured.push({ id: 'feat0003', name: 'Spot basket', at: 3, items: [{ coin: '@700', sym: '@700', kind: 'spot', w: 50, side: 'long' }, { coin: 'BTC', sym: 'BTC', kind: 'perp', w: 50, side: 'long' }] })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the spot basket', () => !!document.querySelector('#pfFeatured [data-load="f:feat0003"]'))
  await waitFor(p, 'markets', () => document.querySelectorAll('#pfSectors button').length > 2)
  await p.click('#pfFeatured [data-load="f:feat0003"] .pf-gc-name')
  await waitFor(p, 'its run', () => window.__pf.state.featuredId === 'feat0003' && window.__pf.last?.runs?.length > 0 && !!document.querySelector('.pf-contrib'))
  const seen = (await p.evaluate(() => ['#pfHoldings', '#pfComp', '.pf-contrib', '#pfResults'].map(q => document.querySelector(q)?.textContent ?? '').join(' '))).replace(/\s+/g, ' ')
  ok('a spot holding reads as its token (DRV), never as its market id (@700)', /DRV/.test(seen) && !/@700/.test(seen), seen.slice(0, 300))
  featured = featured.filter(x => x.id !== 'feat0003')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'featured back to one', () => document.querySelectorAll('#pfFeatured [data-load]').length === 1)

  // The developer: the app's dev mode and PIN.
  await p.evaluate(() => { localStorage.setItem('hliq_dev', '1'); localStorage.setItem('hliq_lb_pin', 'devpin') })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'dev cards', () => document.querySelectorAll('#pfGallery [data-pub]').length > 0 && /Developer mode/.test(document.getElementById('pfDevNote').textContent))
  ok('the developer can publish their own', await p.locator('#pfGallery [data-pub]').count() === 1)
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('hliq_pf_saved')); s[0].name = 'Mine, published'; localStorage.setItem('hliq_pf_saved', JSON.stringify(s)) })
  await p.evaluate(() => window.dispatchEvent(new Event('focus')))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'dev cards', () => document.querySelectorAll('#pfGallery [data-pub]').length > 0)
  await p.click('#pfGallery [data-pub]')
  await waitFor(p, 'published', () => document.querySelectorAll('#pfFeatured [data-load]').length === 2)
  ok('Publish puts it under Featured, sent with the PIN', featured.length === 2 && featured[0].name === 'Mine, published' && writes.at(-1).pin === 'devpin' && writes.at(-1).path.endsWith('/save'))
  await p.click('#pfFeatured [data-load="f:feat0001"] .pf-gc-name')
  await waitFor(p, 'opened', () => window.__pf.state.featuredId === 'feat0001')
  ok('for the developer, Save on a featured one is "Update featured"', (await p.textContent('#pfSave')).trim() === 'Update featured')
  await p.fill('#pfName', 'Featured One, revised')
  await p.click('#pfSave')
  await waitFor(p, 'updated', () => /revised/.test(document.getElementById('pfFeatured').textContent))
  ok('Update featured changes it for everyone, in place', featured.length === 2 && featured.find(x => x.id === 'feat0001')?.name === 'Featured One, revised')
  await p.click('#pfFeatured [data-del="f:feat0001"]')
  ok('removing a featured one also takes two taps', /Remove\?/.test(await p.textContent('#pfFeatured [data-del="f:feat0001"]')) && featured.length === 2)
  await p.click('#pfFeatured [data-del="f:feat0001"]')
  await waitFor(p, 'removed', () => document.querySelectorAll('#pfFeatured [data-load]').length === 1)
  ok('and the second removes it', featured.length === 1 && !featured.some(x => x.id === 'feat0001'))
  // A wrong PIN is refused by the server, and the page says so.
  await p.evaluate(() => localStorage.setItem('hliq_lb_pin', 'wrong'))
  await p.click('#pfGallery [data-pub]')
  await waitFor(p, 'refused', () => /not accepted/.test(document.getElementById('pfMode').textContent))
  ok('a wrong PIN is refused and the page says so', featured.length === 1 && /not accepted/.test(await p.textContent('#pfMode')))
  // Publish straight from the builder.
  await p.evaluate(() => localStorage.setItem('hliq_lb_pin', 'devpin'))
  await p.click('#pfGallery [data-load="l:0"] .pf-gc-name')
  await waitFor(p, 'the builder publish button', () => !document.getElementById('pfPublish').hidden)
  ok('the developer can publish what is in the builder', await p.locator('#pfPublish').isVisible())
  await p.click('#pfPublish')
  await waitFor(p, 'published from the builder', () => document.querySelectorAll('#pfFeatured [data-load]').length === 2)
  ok('Publish puts it under Featured, and Save becomes "Update featured"', featured.length === 2 && (await p.textContent('#pfSave')).trim() === 'Update featured' && await p.locator('#pfPublish').isHidden() && !!(await p.evaluate(() => window.__pf.state.featuredId)))

  // ── price data: one NVDA-only basket, the three buttons ──
  // Hyperliquid has NVDA for 50 days, flat at 180; the exchange has 400 days, rising.
  const dOfN = Math.floor(NOW / DAY) * DAY
  const srcLink = (src) => share({ n: 'NVDA only', i: [['xyz:NVDA', 100, 0]], s: { period: '365', from: null, to: null, capital: 10000, lev: 1, fee: 0, strats: ['hold'], bots: [], bench: false, source: src } })
  const runIn = async (src) => {
    await p.goto(BASE + '#p=' + srcLink(src), { waitUntil: 'domcontentloaded' })
    await p.reload({ waitUntil: 'domcontentloaded' })
    await waitFor(p, src + ' run', (s) => window.__pf.state.source === s && window.__pf.last?.runs?.length === 1 && (s === 'hl' || /Price data/.test(document.getElementById('pfResults').textContent)), src)
    return p.evaluate(() => { const l = window.__pf.last; return { days: l.days.length, ret: l.runs[0].ret, notes: document.getElementById('pfResults').textContent.replace(/\s+/g, ' ') } })
  }
  const hlR = await runIn('hl')
  ok('Hyperliquid: NVDA only has its 50 days there, flat', hlR.days <= 52 && Math.abs(hlR.ret) < 1e-9, hlR)
  const tvR = await runIn('tv')
  const tvWant = NV(dOfN) / NV(dOfN - 365 * DAY) - 1
  ok('"TradingView": the exchange\'s whole year, and its return', tvR.days === 366 && Math.abs(tvR.ret - tvWant) < 1e-9 && /exchange prices for NVDA/.test(tvR.notes), [tvR.days, tvR.ret, tvWant])
  ok('the button shows which data is on', await p.evaluate(() => document.querySelector('#pfSrc .is-on')?.dataset.src) === 'tv')
  const mxR = await runIn('mixed')
  const mxWant = NV(START['xyz:NVDA']) / NV(dOfN - 365 * DAY) - 1
  ok('Mixed: the exchange\'s history until NVDA listed, Hyperliquid (flat) after', mxR.days === 366 && Math.abs(mxR.ret - mxWant) < 1e-9 && /NVDA from exchange prices until/.test(mxR.notes), [mxR.days, mxR.ret, mxWant])
  ok('the asset rows say where their prices came from', /TV\+HL/.test(await p.textContent('#pfComp')))

  ok('no horizontal page scroll', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, await p.evaluate(() => document.documentElement.scrollWidth - innerWidth))
  if (SHOT) await p.screenshot({ path: `${SHOT}/portfolio-${label}.png`, fullPage: true })
  if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
  await browser.close()
}

await run('desktop', { viewport: { width: 1440, height: 1000 } })
await run('mobile', { ...devices['iPhone 14 Pro'] })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
