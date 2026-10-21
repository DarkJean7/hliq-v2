// Portfolios on a phone: a grid you can see at a glance, and a tap that zooms a card.
//
// Asked: "in mobile make the portfolio cards smaller so that the user can see at glance a few
// portfolios like lets say 9, when pressing one it should zoom the cards to make it more
// readable, with an x exit button". Nine saved portfolios, an iPhone-sized screen:
//   - three to a row, and all nine fit on one screen
//   - a tap zooms that card, readable (its description shows), with × to close
//   - Open in builder does what a tap used to: the builder holds that portfolio
//   - on a desktop nothing changed: a click opens it directly
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/portfolios'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const DAY = 86_400_000

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const T0 = Math.floor(Date.now() / DAY) * DAY - 400 * DAY
const PRICE = { BTC: (x) => 100 * (1 + (x - T0) / (400 * DAY)), ETH: () => 50 }
const ctx0 = (px) => ({ funding: '0', openInterest: '1000', prevDayPx: String(px), dayNtlVlm: '5000000', premium: '0', oraclePx: String(px), markPx: String(px), midPx: String(px), impactPxs: [String(px), String(px)] })
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }]
const HL = { metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctx0(200), ctx0(50)]], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []], perpDexs: [null] }
const SAVED = Array.from({ length: 9 }, (_, i) => ({ name: 'Basket ' + (i + 1), desc: 'A long description of basket number ' + (i + 1) + ' that only fits when the card is zoomed in.',
  items: [{ coin: 'BTC', sym: 'BTC', kind: 'perp', w: 50 + i, side: 'long' }, { coin: 'ETH', sym: 'ETH', kind: 'perp', w: 50 - i, side: 'long' }] }))

async function open(opts) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (b.type === 'candleSnapshot') {
      const f = PRICE[b.req.coin], step = b.req.interval === '1d' ? DAY : 4 * 3_600_000, out = []
      if (f) for (let x = Math.max(T0, Math.floor(b.req.startTime / step) * step); x <= b.req.endTime && out.length < 5000; x += step) { const c = f(x); out.push({ t: x, T: x + step - 1, s: b.req.coin, i: b.req.interval, o: String(c), h: String(c), l: String(c), c: String(c), v: '1', n: 1 }) }
      return route.fulfill({ status: 200, contentType: 'application/json', json: out })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/pf-closes**', r => r.fulfill({ status: 200, json: { closes: {} } }))
  await ctx.route('**/pf-history**', r => r.fulfill({ status: 404, json: { pts: null } }))
  await ctx.route('**/markets-meta', r => r.fulfill({ status: 200, json: { revenue: {}, cg: {}, stocks: {}, sic: {} } }))
  await ctx.route('**/portfolios-data/**', r => r.fulfill({ status: 200, json: [] }))
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('hliq_pf_saved', JSON.stringify(s)) }, SAVED)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the nine cards', () => document.querySelectorAll('#pfGallery [data-load]').length === 9)
  // A folded list hides its cards; unfold if this device had folded it.
  await p.evaluate(() => { if (document.getElementById('pfHideLocal')?.textContent === 'Show') document.getElementById('pfHideLocal').click() })
  return { browser, p, errs }
}

console.log('\n-- a phone: nine at a glance --')
{
  const { browser, p, errs } = await open({ ...devices['iPhone 14 Pro'] })
  await p.evaluate(() => document.getElementById('pfGallery').scrollIntoView({ block: 'start' }))
  await p.waitForTimeout(300)
  const g = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#pfGallery [data-load]')]
    const r = cards.map(c => c.getBoundingClientRect())
    return { cols: getComputedStyle(document.getElementById('pfGallery')).gridTemplateColumns.split(' ').length,
      span: Math.round(r[8].bottom - r[0].top), vh: innerHeight, sideways: document.getElementById('pfGallery').scrollWidth > document.getElementById('pfGallery').clientWidth + 2 }
  })
  t('three to a row', g.cols, 3)
  t('all nine fit on one screen (' + g.span + 'px of ' + g.vh + ')', g.span < g.vh, true)
  t('no sideways strip any more', g.sideways, false)
  t('the small card leaves the description for the zoom', await p.evaluate(() => getComputedStyle(document.querySelector('#pfGallery .pf-gc-desc')).display), 'none')

  console.log('\n-- a tap zooms it --')
  await p.click('#pfGallery [data-load] >> nth=4')
  t('a zoomed card opens', await waitFor(p, 'the zoom', () => !!document.querySelector('#pfZoom .pf-gc')), true)
  t('the one pressed', await p.evaluate(() => document.querySelector('#pfZoom .pf-gc-name b')?.textContent), 'Basket 5')
  t('readable: its description shows', await p.evaluate(() => getComputedStyle(document.querySelector('#pfZoom .pf-gc-desc')).display !== 'none'), true)
  t('wider than the small one', await p.evaluate(() => document.querySelector('#pfZoom .pf-gc').getBoundingClientRect().width > 2.2 * document.querySelector('#pfGallery .pf-gc').getBoundingClientRect().width), true)
  t('the builder did not change under it', await p.evaluate(() => document.getElementById('pfName')?.value !== 'Basket 5'), true)
  // Two crosses side by side is how a portfolio gets deleted by someone closing a card.
  t('delete is spelled out in the zoom, not a second ×', await p.evaluate(() => getComputedStyle(document.querySelector('#pfZoom .pf-gc-del'), '::after').content), '"Delete"')
  await p.click('#pfZoom .pf-zoom-x')
  t('× closes it', await p.evaluate(() => !document.getElementById('pfZoom')), true)

  // Delete from the zoom: the first tap asks, the second does it and closes.
  const before = await p.evaluate(() => document.querySelectorAll('#pfGallery [data-load]').length)
  await p.click('#pfGallery [data-load] >> nth=8')
  await waitFor(p, 'the zoom', () => !!document.querySelector('#pfZoom .pf-gc-del'))
  await p.click('#pfZoom .pf-gc-del')
  await p.waitForTimeout(200)
  t('the first tap on Delete asks', await p.evaluate(() => document.querySelector('#pfZoom .pf-gc-del')?.textContent), 'Delete?')
  await p.click('#pfZoom .pf-gc-del')
  await p.waitForTimeout(300)
  t('the second deletes it and closes the zoom', await p.evaluate(() => [!document.getElementById('pfZoom'), document.querySelectorAll('#pfGallery [data-load]').length]), [true, before - 1])

  await p.click('#pfGallery [data-load] >> nth=2')
  await waitFor(p, 'the zoom', () => !!document.querySelector('#pfZoom .pf-gc'))
  // The gallery is sorted by return, so which basket is third is the sort's business: take the
  // name off the zoomed card.
  const zoomed = await p.evaluate(() => document.querySelector('#pfZoom .pf-gc-name b')?.textContent)
  t('the zoom names the card that was pressed', zoomed, await p.evaluate(() => document.querySelectorAll('#pfGallery .pf-gc-name b')[2]?.textContent))
  await p.click('#pfZoom .pf-zoom-open')
  await p.waitForTimeout(500)
  t('Open in builder closes the zoom', await p.evaluate(() => !document.getElementById('pfZoom')), true)
  t('and the builder holds that portfolio', await p.evaluate(() => document.getElementById('pfName')?.value), zoomed)
  await browser.close()
  t('no page errors on the phone', errs, [])
}

console.log('\n-- a desktop: unchanged --')
{
  const { browser, p, errs } = await open({ viewport: { width: 1400, height: 900 } })
  t('cards are full size', await p.evaluate(() => getComputedStyle(document.querySelector('#pfGallery .pf-gc-desc')).display !== 'none'), true)
  await p.click('#pfGallery [data-load] >> nth=6')
  await p.waitForTimeout(500)
  t('a click opens it straight away, no zoom', await p.evaluate(() => [!document.getElementById('pfZoom'), document.getElementById('pfName')?.value]), [true, 'Basket 7'])
  await browser.close()
  t('no page errors on the desktop', errs, [])
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
