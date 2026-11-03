// The Exchanges view on /markets and the Markets tab inside the app, against LIVE DefiLlama
// (not hermetic, not in browser.mjs).
//
// "can we also add the revenue of cex, dex? in the markets tab. also add the markets tab in the
// main app (adapted version just like portfolios from landing page)". A DEX table ranked by
// revenue, a CEX table with assets and inflows, and /markets?embed=1 framed in the app on both
// shells without the public site's menu.
//
//   npm run dev &   then   node tests/exchanges-live.mjs [--port=5175] [--shot=dir]
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const BASE = `http://localhost:${arg('port', '5175')}`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const shot = (p, name) => arg('shot') ? p.screenshot({ path: `${arg('shot')}/${name}.png` }) : null

const b = await chromium.launch()

console.log('-- /markets → Exchanges --')
{
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  await p.goto(BASE + '/markets', { waitUntil: 'domcontentloaded' })
  await p.click('#mkMode button[data-mode="exchanges"]')
  await p.waitForFunction(() => document.querySelectorAll('#mkBody tr').length > 5, null, { timeout: 120000 })
  const head = await p.$eval('#mkHead', e => e.textContent)
  t('DEX table ranks by revenue', /Revenue 24h/.test(head) && /Fees 30d/.test(head), head)
  const names = await p.$$eval('#mkBody tr b', es => es.slice(0, 30).map(e => e.textContent))
  t('Hyperliquid is on it, as one row', names.filter(n => n === 'Hyperliquid').length === 1, names)
  // On screen, not the attribute: .mk-tabs sets its own display, which beat hidden the first time.
  t('the market filters are out of the way', await p.$eval('#mkTabs', e => getComputedStyle(e).display === 'none'))
  await p.waitForFunction(() => [...document.querySelectorAll('#mkBody .mk-ico img')].filter(i => i.naturalWidth > 1).length > 3, null, { timeout: 45000 }).catch(() => {})
  const dl = await p.$$eval('#mkBody .mk-ico img', is => ({ n: is.length, ok: is.filter(i => i.naturalWidth > 1).length, first: is.slice(0, 3).map(i => [i.src.slice(-50), i.complete, i.naturalWidth]) }))
  t('exchange logos load', dl.ok > 3, dl)
  await shot(p, 'ex-dex')
  await p.click('#mkExKind button[data-ex="cex"]')
  await p.waitForFunction(() => /Assets/.test(document.getElementById('mkHead').textContent), null, { timeout: 30000 })
  const cex = await p.$$eval('#mkBody tr b', es => es.slice(0, 5).map(e => e.textContent))
  t('CEX table, biggest first', cex[0] === 'Binance', cex)
  t('inflows are signed', await p.$eval('#mkBody', e => /[+−]\$/.test(e.textContent)))
  await p.waitForFunction(() => [...document.querySelectorAll('#mkBody .mk-ico img')].filter(i => i.naturalWidth > 1).length > 3, null, { timeout: 45000 }).catch(() => {})
  t('CEX logos load too', await p.$$eval('#mkBody .mk-ico img', is => is.filter(i => i.naturalWidth > 1).length) > 3)
  await shot(p, 'ex-cex')
  await p.click('#mkMode button[data-mode="market"]')
  t('back to Markets puts the filters back', await p.$eval('#mkTabs', e => getComputedStyle(e).display !== 'none'))
  // The DEX/CEX switch set display in CSS over its hidden attribute, crowding the phone's controls row
  // until the sector chips under it could not be tapped (markets-browser.mjs caught it in CI).
  t('and hides the DEX/CEX switch', await p.$eval('#mkExKind', e => getComputedStyle(e).display === 'none'))
  await p.close()
}

console.log('-- the app: desktop Markets tab --')
{
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
  await p.goto(BASE + '/app', { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => typeof window.loadDashboard === 'function', null, { timeout: 120000 })
  // The dashboard, every tab in it, only shows once a wallet is loaded; any address will do.
  await p.evaluate(() => { document.getElementById('walletInput').value = '0x' + '0'.repeat(39) + '1'; return window.loadDashboard() })
  await p.waitForFunction(() => getComputedStyle(document.getElementById('dashboard')).display !== 'none', null, { timeout: 60000 })
  await p.evaluate(() => window.switchTab('markets', document.querySelector('.nav-tab[onclick*="\'markets\'"]')))
  const f = await (await p.waitForSelector('#mkEmbedFrame[src]', { timeout: 20000 })).contentFrame()
  await f.waitForSelector('#mkBody tr', { timeout: 60000 })
  t('the frame is the embedded page', await f.evaluate(() => document.documentElement.classList.contains('pf-embed')))
  t('without the public menu', await f.evaluate(() => getComputedStyle(document.getElementById('lnNav')).display === 'none'))
  await shot(p, 'app-desk')
  await p.close()
}

console.log('-- the app: phone More → Markets --')
{
  const p = await (await b.newContext({ viewport: { width: 430, height: 930 }, isMobile: true })).newPage()
  await p.goto(BASE + '/app', { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => typeof window.__openMarkets === 'function', null, { timeout: 120000 })
  t('the More menu has it', await p.evaluate(() => !![...document.querySelectorAll('#mobMoreDrawer button')].find(x => /Markets/.test(x.textContent))))
  await p.evaluate(() => window.__openMarkets())
  const f = await (await p.waitForSelector('#mkEmbedSheet iframe', { timeout: 20000 })).contentFrame()
  await f.waitForSelector('#mkBody tr', { timeout: 60000 })
  t('opens as a sheet over the app', true)
  await shot(p, 'app-phone')
  await p.click('#mkEmbedSheet [data-close]')
  t('and closes', !(await p.$('#mkEmbedSheet')))
  await p.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
