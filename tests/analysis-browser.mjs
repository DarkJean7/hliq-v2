// Analysis → Support & resistance (src/analysis.js + src/zones.js), driven through the real app.
//
// Reported: "i would like for the analysis section to be non-transparent and remade to contain
// more data ... identify the asset's possible supports and resistances". Asserts the zones
// table, the price-now divider, sorting, an unknown market, and that the view stays SOLID with
// a wallpaper set (the panels go translucent then, and the old cards used a colour that was
// never defined at all).
//
// Hermetic: Hyperliquid is stubbed by host with synthetic candles and a book; sockets blocked.
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 400))) }
const until = async (label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 200)) }
}
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const MS = { '4h': 4 * 3600e3, '1d': 864e5, '1w': 7 * 864e5 }
// A market oscillating between ~80 and ~120 around 100, so swings land on both sides of price.
function candles(interval, n) {
  const step = MS[interval] ?? 864e5, now = Date.now()
  return Array.from({ length: n }, (_, i) => {
    const m = 100 + 18 * Math.sin(i / 6) * (0.4 + 0.6 * Math.abs(Math.sin(i / 37))) + 4 * Math.sin(i / 2.3)
    return { t: now - (n - i) * step, T: now - (n - i - 1) * step, s: 'BTC', i: interval, o: String(m), c: String(m + 0.5), h: String(m + 2), l: String(m - 2), v: '1000', n: 10 }
  })
}
const lv = (px, sz, n) => ({ px: String(px), sz: String(sz), n })
const book = (step) => ({ coin: 'BTC', time: Date.now(), levels: [
  Array.from({ length: 20 }, (_, i) => lv(+(99.95 - i * step).toFixed(4), 50, 5)),
  Array.from({ length: 20 }, (_, i) => lv(+(100.05 + i * step).toFixed(4), 40, 4)),
] })
const HL = {
  allMids: { BTC: '100' }, meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
  outcomeMeta: {}, clearinghouseState: { assetPositions: [], marginSummary: { accountValue: '0' } },
}
const asked = []
// 1×1 PNG: enough for the app to switch into wallpaper mode.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const browser = await chromium.launch()
for (const [w, h, mob] of [[1400, 900, false], [430, 930, true]]) {
  console.log(`\n== ${mob ? 'phone' : 'desktop'} ==`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    asked.push(b)
    let json = HL[b.type] ?? {}
    if (b.type === 'candleSnapshot') json = b.req?.coin === 'NOPE' ? [] : candles(b.req.interval, b.req.interval === '1w' ? 100 : 300)
    if (b.type === 'l2Book') json = b.coin === 'NOPE' ? null : book(b.nSigFigs === 2 ? 1 : b.nSigFigs === 3 ? 0.1 : 0.01)
    return route.fulfill({ status: 200, contentType: 'application/json', json })
  })
  await ctx.route(/\/api\/|\/paper\//, route => route.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate((png) => {
    localStorage.clear()
    for (const [k, v] of Object.entries({ hliq_lang: 'en', hliq_lang_chosen: '1', hliq_onboard_done: '1', hliq_onboard_welcomed_v1: '1', hliq_onboard_tour_v1: '1', hliq_install_nudge_v2: '9999999999999', hliq_ann_dismissed: '["*"]', hliq_pulse_seg: 'analysis', hliq_ana_coin: 'BTC', hliq_backdrop_img: png }))
      localStorage.setItem(k, v)
  }, PNG)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await until('boot', () => p.evaluate(() => !!window.__goPaper))
  await p.evaluate(() => window.__goPaper('main'))
  await p.evaluate((mob) => { if (mob) window.__mobMoreTab('analysis'); else window.switchTab('analysis') }, mob)

  await until('zones', () => p.evaluate(() => document.querySelectorAll('.ana-row[data-i]').length > 2))
  const rows = await p.evaluate(() => [...document.querySelectorAll('.ana-row[data-i], .ana-row.now')].map(r => ({ now: r.classList.contains('now'), px: parseFloat(r.querySelector('.c-px')?.textContent.replace(/,/g, '')), kind: r.querySelector('.k')?.className.split(' ')[1] })))
  const at = rows.findIndex(r => r.now)
  ok('zones are found on both sides of price', rows.some(r => r.kind === 'support') && rows.some(r => r.kind === 'resistance'), rows)
  ok('by price: resistances above the "price now" row, supports below it', at > 0 && rows.slice(0, at).every(r => r.kind !== 'support') && rows.slice(at + 1).every(r => r.kind !== 'resistance'), rows)
  ok('and they are in price order', rows.every((r, i) => i === 0 || r.px <= rows[i - 1].px), rows.map(r => r.px))
  const stats = await p.evaluate(() => [...document.querySelectorAll('.ana-stat .l')].map(e => e.textContent.trim().toLowerCase()))
  ok('the stats read price, nearest support and resistance, ATR, POC, zones and the book', ['price', 'nearest support', 'nearest resistance', 'daily range (atr)', 'volume poc', 'zones', 'book bid/ask ±2%'].every(s => stats.includes(s)), stats)
  ok('the chart draws bands and candles', await p.evaluate(() => document.querySelectorAll('.ana-plot rect').length > 50))
  ok('a wall is read from the book near price', await p.evaluate(() => [...document.querySelectorAll('.ana-row[data-i] .c-wall')].some(e => /^\$/.test(e.textContent.trim()))))
  ok('all three timeframes were asked for', ['4h', '1d', '1w'].every(iv => asked.some(b => b.type === 'candleSnapshot' && b.req?.interval === iv)))
  ok('and the book at three aggregations', [undefined, 3, 2].every(n => asked.some(b => b.type === 'l2Book' && b.nSigFigs === n)))
  ok('the chips offer markets', await p.evaluate(() => [...document.querySelectorAll('#anaZChips button')].map(b => b.textContent).includes('ETH')))

  console.log('-- solid with a wallpaper --')
  ok('the wallpaper is on (panels are translucent app-wide)', await p.evaluate(() => document.documentElement.classList.contains('has-bg-image') && document.documentElement.classList.contains('panels-clear')))
  const alpha = await p.evaluate(() => [document.querySelector('.ana-stat'), document.querySelector('.ana-card'), document.querySelector('#pulseSegBody')].map(e => {
    const m = getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/)
    const parts = m ? m[1].split(',').map(Number) : []
    return parts.length === 4 ? parts[3] : 1
  }))
  ok('stat cards, cards and the view itself are opaque', alpha.every(a => a === 1), alpha)
  ok('the chart cards below have a ground too (--panel-1 is defined here)', await p.evaluate(() => getComputedStyle(document.querySelector('#anaCharts')).getPropertyValue('--panel-1').trim() !== ''))

  console.log('-- a row goes to its line on the chart, and the chart zooms --')
  const bars = () => p.evaluate(() => document.querySelectorAll('.ana-plot svg line:not(.zl):not(.now):not(.poc)').length)
  // The farthest zone from price: the one least likely to be on screen already.
  const far = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.ana-row[data-i]')]
    const d = r => Math.abs(parseFloat(r.querySelector('.c-dist').textContent))
    return +rows.sort((x, y) => d(y) - d(x))[0].dataset.i
  })
  await p.evaluate(() => window.scrollTo(0, 0))
  await p.click(`.ana-row[data-i="${far}"]`)
  await until('the selection', () => p.evaluate((i) => !!document.querySelector(`.ana-lab.on[data-i="${i}"]`), far), 5000)
  ok('pressing a row marks that zone on the chart, labelled, even far from price', await p.evaluate((i) => !!document.querySelector(`.ana-lab.on[data-i="${i}"]`) && !!document.querySelector('.ana-plot line.zl.on'), far))
  await until('the scroll', () => p.evaluate(() => { const r = document.querySelector('.ana-plot').getBoundingClientRect(); return r.top >= -5 && r.bottom <= innerHeight + 5 }), 5000)
  ok('and brings the chart into view', await p.evaluate(() => { const r = document.querySelector('.ana-plot').getBoundingClientRect(); return r.top >= -5 && r.bottom <= innerHeight + 5 }))
  const labelled = await p.evaluate(() => document.querySelectorAll('.ana-lab[data-act="selz"]').length)
  ok('several zones are labelled on the chart, not only the strongest few', labelled >= 3, labelled)
  const b0 = await bars()
  if (!mob) {
    // Let the smooth scroll to the chart finish before aiming at it.
    let box = null
    await until('settled', async () => { const b = await p.locator('.ana-plot').boundingBox(); const same = box && Math.abs(b.y - box.y) < 0.5; box = b; return same }, 5000)
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await p.mouse.wheel(0, -600)
    await until('zoom in', async () => (await bars()) < b0, 5000)
    const b1 = await bars()
    ok('the wheel zooms in: fewer candles on screen', b1 < b0, [b0, b1])
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const box2 = await p.locator('.ana-plot').boundingBox()
    ok('the wheel zooms the chart, it does not scroll the page', Math.abs(box2.y - box.y) < 1, [box.y, box2.y])
    const d0 = await p.evaluate(() => document.querySelector('.ana-date').textContent)
    await p.mouse.down(); await p.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 5 }); await p.mouse.up()
    await until('pan', () => p.evaluate((d) => document.querySelector('.ana-date').textContent !== d, d0), 5000)
    ok('dragging pans to older candles', await p.evaluate((d) => document.querySelector('.ana-date').textContent !== d, d0), d0)
  } else {
    await p.click('[data-act="zoom"][data-v="in"]')
    await until('zoom in', async () => (await bars()) < b0, 5000)
    ok('the + button zooms in: fewer candles on screen', (await bars()) < b0, [b0, await bars()])
  }
  await p.click('[data-act="zoom"][data-v="reset"]')
  await until('reset', async () => (await bars()) === b0, 5000)
  ok('Reset puts it back', (await bars()) === b0)
  // From the chart back to the table.
  const other = await p.evaluate((i) => +[...document.querySelectorAll('.ana-lab[data-act="selz"]')].find(l => +l.dataset.i !== i).dataset.i, far)
  await p.click(`.ana-lab[data-i="${other}"]`)
  await until('row', () => p.evaluate((i) => !!document.querySelector(`.ana-row.sel[data-i="${i}"]`), other), 5000)
  ok('pressing a label on the chart selects its row', await p.evaluate((i) => !!document.querySelector(`.ana-row.sel[data-i="${i}"]`), other))

  console.log('-- sorting and an unknown market --')
  await p.click('.ana-seg button[data-act="sort"][data-v="score"]')
  const sc = await p.evaluate(() => [...document.querySelectorAll('.ana-row[data-i] .c-str b')].map(b => +b.textContent))
  ok('by strength: strongest first', sc.length > 2 && sc.every((s, i) => i === 0 || s <= sc[i - 1]), sc)
  ok('and the choice is remembered', await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_ana_prefs')).sort === 'score'))
  await p.fill('#anaZInput', 'nope')
  await p.press('#anaZInput', 'Enter')
  await until('the answer', () => p.evaluate(() => /no market called/i.test(document.getElementById('anaZBody').textContent)))
  ok('an unknown market says there is none, by its name', await p.evaluate(() => /no market called NOPE/i.test(document.getElementById('anaZBody').textContent)))
  await p.click('#anaZChips button[data-coin="BTC"]')
  await until('back', () => p.evaluate(() => document.querySelectorAll('.ana-row[data-i]').length > 2))
  ok('a chip brings a market back', await p.evaluate(() => document.querySelectorAll('.ana-row[data-i]').length > 2))
  ok('no page errors', !errs.length, errs)
  await ctx.close()
}
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
