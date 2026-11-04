// The desktop trade chart against LIVE Hyperliquid (not hermetic, not in browser.mjs).
//
// "add 30min, 2hours, 8hours, 12hours, 3days. also allow the user to scroll to the right ...
// even if it shows just one candle (like hyperliquid)" and "add the horizontal dotted line of
// mark price". Each new pill must ask Hyperliquid for its own interval and draw; a long drag left
// must carry the last candle to the left edge rather than stopping 30 candles past it.
//
//   npm run dev &   then   node tests/tradechart-live.mjs [--port=5175] [--shot=path.png]
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage()
const asked = []
p.on('request', r => {
  if (!/hyperliquid/.test(new URL(r.url()).host) || r.method() !== 'POST') return
  try { const j = JSON.parse(r.postData() || '{}'); if (j.type === 'candleSnapshot') asked.push(j.req.interval) } catch {}
})
// Any address opens the dashboard; an empty one has nothing to show but the chart.
const ADDR = '0x0000000000000000000000000000000000000001'
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
// Chosen up front: the first refresh otherwise picks BTC itself, seconds in, and that redraw
// lands in the middle of whatever the test is doing to the chart.
await p.waitForFunction(() => !!window.__selectCoin)
await p.evaluate(() => window.__selectCoin('BTC'))
await p.evaluate(() => window.switchTab('trade'))
await p.waitForSelector('.chart-tf-btn', { state: 'visible' })
// The first chart (1h) must have loaded, or its request lands inside the first pill's check.
await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 20000 })

const pills = await p.$$eval('.chart-tf-btn', bs => bs.map(b => b.textContent.trim()))
t('the desktop row offers every timeframe', ['30m', '2h', '8h', '12h', '3D'].every(x => pills.includes(x)), pills)

const hero = () => p.$eval('#deskChartHero', e => e.textContent)
for (const [pill, iv] of [['30m', '30m'], ['2h', '2h'], ['8h', '8h'], ['12h', '12h'], ['3D', '3d']]) {
  asked.length = 0
  await p.click(`.chart-tf-btn:text-is("${pill}")`)
  // The hero still holds the previous price when the click lands, so wait on the request first.
  for (let i = 0; i < 200 && !asked.includes(iv); i++) await p.waitForTimeout(100)
  await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
  t(`${pill} asks Hyperliquid for ${iv} candles and draws`, asked.includes(iv) && /\$/.test(await hero()), { asked, hero: await hero() })
}

// Lightweight Charts (src/tradechart.js): "the chart is like meh". A terminal's chart opens on
// candles, the recent window, with the bar under the crosshair read out in the corner.
asked.length = 0
await p.click('.chart-tf-btn:text-is("1h")')
// Some intervals take Hyperliquid several seconds; measure the 1h chart, not the one before it.
for (let i = 0; i < 200 && !asked.includes('1h'); i++) await p.waitForTimeout(100)
await p.waitForFunction(() => document.getElementById('deskChartHero')?.textContent !== 'Loading…', null, { timeout: 30000 })
await p.waitForFunction(() => (window.__tradeChartState?.()?.bars ?? 0) > 50 && /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 20000 })
// Opening the tab and selecting a coin each start a load; the guard lets only the newest draw.
await p.waitForTimeout(0)
const st0 = await p.evaluate(() => window.__tradeChartState())
t('opens on candles', st0?.mode === 'candle', st0)
t('the recent ~90 bars on screen, the newest at the right',
  st0?.range && st0.range.to >= st0.bars - 1 && st0.range.to - st0.range.from <= 100, st0)
const host = await p.$('#deskChartCanvas ~ .tv-chart-host')
t('drawn by the new chart, in place of the old canvas',
  !!host && await p.$eval('#deskChartCanvas', c => getComputedStyle(c).display === 'none'))
t('with the TradingView attribution its licence asks for',
  await p.evaluate(() => !!document.querySelector('.tv-chart-host a[href*="tradingview"]')))
await p.mouse.move(2, 2)
t('the readout shows the bar: OHLC and its change', /O.*H.*L.*C/.test(await hero()) && /%/.test(await hero()), await hero())

// A long drag left must carry the last candle to the LEFT edge, as on Hyperliquid.
const box = await host.boundingBox()
for (let i = 0; i < 8; i++) {
  await p.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2)
  await p.mouse.down()
  await p.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2, { steps: 12 })
  await p.mouse.up()
}
const st1 = await p.evaluate(() => window.__tradeChartState())
t('dragging left takes the last candle to the left edge', st1.range.from >= st1.bars - 3, st1)
await p.screenshot({ path: arg('shot', undefined), clip: box }).catch(() => {})
await host.dblclick({ position: { x: box.width / 2, y: box.height / 2 } })
// The library applies a new range on its next frame.
await p.waitForFunction(() => { const s = window.__tradeChartState(); return s.range.from < s.bars - 10 }, null, { timeout: 3000 }).catch(() => {})
const st2 = await p.evaluate(() => window.__tradeChartState())
t('double-click brings back the recent window', st2.range.to >= st2.bars - 1 && st2.range.from < st2.bars - 10, st2)
console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
