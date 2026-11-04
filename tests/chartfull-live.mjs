// Full view for the Trade chart, and the desktop order book, against LIVE Hyperliquid
// (not hermetic, not in browser.mjs).
//
// "add the option to expand the chart to full view. also is desktop missing the order book? if
// so make it able to be hidden and visible". Desktop: the book is beside the chart with levels
// from the l2Book socket, a level clicked becomes the limit price, Book hides it and the choice
// survives a reload, and Expand fills the window until Esc. Phone: Expand fills the screen.
//
//   npm run dev &   then   node tests/chartfull-live.mjs [--port=5175] [--shot=dir]
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const shot = (p, name) => arg('shot') ? p.screenshot({ path: `${arg('shot')}/${name}.png` }) : null

const b = await chromium.launch()
async function open(opts) {
  const p = await (await b.newContext(opts)).newPage()
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_onboard_welcomed_v1', '1')   // the phone's first-visit sheet sits over everything
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard && !!window.__selectCoin, null, { timeout: 120000 })
  await p.evaluate(() => { document.getElementById('walletInput').value = '0x' + '0'.repeat(39) + '1'; return window.loadDashboard() })
  return p
}
const chartReady = (hero) => (window.__tradeChartState?.()?.bars ?? 0) > 50 && /\$/.test(document.getElementById(hero)?.textContent ?? '')

console.log('-- desktop --')
{
  const p = await open({ viewport: { width: 1500, height: 950 } })
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  await p.evaluate(() => { window.__selectCoin('BTC'); window.switchTab('trade') })
  await p.waitForFunction(chartReady, 'deskChartHero', { timeout: 60000 })

  // The book: on by default, filled from the socket.
  await p.waitForFunction(() => document.querySelectorAll('#deskBookRows .desk-book-row').length > 10, null, { timeout: 30000 })
  const sides = await p.evaluate(() => ({
    asks: document.querySelectorAll('#deskBookRows .desk-book-asks .desk-book-row').length,
    bids: document.querySelectorAll('#deskBookRows .desk-book-side:not(.desk-book-asks) .desk-book-row').length,
  }))
  t('the order book is beside the chart, both sides', sides.asks > 4 && sides.bids > 4, sides)
  const spent = await p.evaluate(() => performance.getEntriesByType('resource').filter(r => /l2Book/.test(r.name)).length)
  t('from the socket: no l2Book requests on the budget', spent === 0, spent)
  await shot(p, 'desk-book')

  const px = await p.$eval('#deskBookRows .desk-book-asks .desk-book-row:last-child', e => e.dataset.px)
  await p.click('#deskBookRows .desk-book-asks .desk-book-row:last-child')
  const lim = await p.evaluate(() => ({ v: document.getElementById('limitPriceInput')?.value, shown: getComputedStyle(document.getElementById('limitPriceField')).display !== 'none' }))
  t('a level clicked becomes the limit price', Number(lim.v) === Number(px) && lim.shown, { px, lim })

  await p.click('#deskBookBtn')
  t('Book hides it', await p.$eval('#deskBook', e => getComputedStyle(e).display === 'none'))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!document.getElementById('deskBook'), null, { timeout: 60000 })
  t('and it stays hidden after a reload', await p.$eval('#deskBook', e => getComputedStyle(e).display === 'none'))
  await p.evaluate(() => window.__toggleDeskBook())
  t('Book brings it back', await p.$eval('#deskBook', e => getComputedStyle(e).display !== 'none'))

  // Full view, on the chart as reloaded.
  await p.evaluate(() => { document.getElementById('walletInput').value = '0x' + '0'.repeat(39) + '1'; return window.loadDashboard() })
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  await p.evaluate(() => { window.__selectCoin('BTC'); window.switchTab('trade') })
  await p.waitForFunction(chartReady, 'deskChartHero', { timeout: 60000 })
  const before = await p.$eval('.tv-chart-host', e => e.getBoundingClientRect().height)
  await p.evaluate(() => window.__chartFull())
  await p.waitForFunction((h) => document.querySelector('.tv-chart-host').getBoundingClientRect().height > h + 200, before, { timeout: 5000 }).catch(() => {})
  const full = await p.evaluate(() => {
    const r = document.querySelector('.trade-chart-wrap').getBoundingClientRect()
    return { w: r.width, h: r.height, chart: document.querySelector('.tv-chart-host').getBoundingClientRect().height, vw: innerWidth, vh: innerHeight }
  })
  t('Expand fills the window', full.w >= full.vw - 1 && full.h >= full.vh - 1, full)
  t('and the chart grows into it', full.chart > before + 200, { before, after: full.chart })
  await shot(p, 'desk-full')
  await p.keyboard.press('Escape')
  t('Esc puts it back', await p.$eval('.trade-chart-wrap', e => !e.classList.contains('chart-full')))
  await p.close()
}

console.log('-- phone --')
{
  const p = await open({ viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true })
  await p.waitForFunction(() => !!window.mobVGoTab && !!window._mobSelectMarket, null, { timeout: 60000 })
  await p.evaluate(() => { window.mobVGoTab('trade'); window._mobSelectMarket('BTC') })
  await p.waitForFunction(chartReady, 'mobChartHero', { timeout: 60000 })
  t('the phone chart has an Expand button', !!(await p.$('.mob-chart-card .mob-chart-full-btn')))
  await p.evaluate(() => window.__chartFull())
  await p.waitForTimeout(300)
  const full = await p.evaluate(() => {
    const r = document.querySelector('.mob-chart-card').getBoundingClientRect()
    return { w: r.width, h: r.height, chart: document.querySelector('.tv-chart-host').getBoundingClientRect().height, vw: innerWidth, vh: innerHeight }
  })
  t('Expand fills the screen', full.w >= full.vw - 1 && full.h >= full.vh - 1, full)
  t('and the chart takes most of it', full.chart > full.vh * 0.7, full)
  await shot(p, 'phone-full')
  await p.click('.mob-chart-card .mob-chart-full-btn')
  t('the same button puts it back', await p.$eval('.mob-chart-card', e => !e.classList.contains('chart-full')))
  await p.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
