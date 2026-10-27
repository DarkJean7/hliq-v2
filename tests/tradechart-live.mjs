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
  for (let i = 0; i < 100 && !asked.includes(iv); i++) await p.waitForTimeout(100)
  await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
  t(`${pill} asks Hyperliquid for ${iv} candles and draws`, asked.includes(iv) && /\$/.test(await hero()), { asked, hero: await hero() })
}

// Drag the plot far to the left, several times: the window should end up mostly empty future.
await p.click('.chart-tf-btn:text-is("1h")')
await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 20000 })
const box = await (await p.$('#deskChartCanvas')).boundingBox()
const before = await p.screenshot({ clip: box })
for (let i = 0; i < 6; i++) {
  await p.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
  await p.mouse.down()
  await p.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 12 })
  await p.mouse.up()
}
const after = await p.screenshot({ clip: box, path: arg('shot', undefined) })
t('dragging left moves the chart', !before.equals(after))
console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
