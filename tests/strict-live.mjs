// LIVE check, not part of the hermetic browser suite: the phone market list against real
// Hyperliquid, Strict and All. Written for "make our app trade search be strict" (QUANT/USDC
// showed in ours; Hyperliquid shows it only under All).
//   npm run dev (or a preview on 5175)   then   node tests/strict-live.mjs [--port=5175]
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '--port=5175').slice(7)
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true })).newPage()
const waitFor = async (what, fn, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await p.evaluate(fn).catch(() => false)) return; await p.waitForTimeout(250) }
  throw new Error('timed out waiting for ' + what)
}
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor('boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor('the mobile shell', () => !!window.mobVTab)
await p.evaluate(() => window.mobVTab('trade'))
await waitFor('the markets', () => document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length >= 4)

const rows = (q) => p.evaluate((q) => {
  window._mobTradeSearch(q)
  return [...document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]')].map(e => e.id.slice('mobFavBtn-'.length).replace(/^_/, '@'))   // the row id writes '@107' as '_107'
}, q)
// spotMeta arrives after the first paint; the strict set is built from it.
await waitFor('the spot names', async () => (await window._mobTradeSearch?.('hype'), document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length > 1))

t('Strict is on by default', (await p.evaluate(() => document.getElementById('mobMktStrictBtn')?.getAttribute('aria-pressed'))) === 'true')
const qStrict = await rows('qua')
t('"qua" under Strict finds no spot QUANT', !qStrict.some(k => k.startsWith('@')), qStrict)
const hype = await rows('hype')
t('HYPE spot is still there', hype.includes('@107'), hype)
await p.evaluate(() => window.__spotStrictToggle(false))
const qAll = await rows('qua')
t('under All, QUANT appears', qAll.some(k => k.startsWith('@')), qAll)
t('and the switch says so', (await p.evaluate(() => document.getElementById('mobMktStrictBtn')?.textContent)) === 'All spot')
await p.evaluate(() => window.__spotStrictToggle(true))
t('back to Strict hides it again', !(await rows('qua')).some(k => k.startsWith('@')))
const spot = await p.evaluate(() => { window._mobTradeSearch(''); window._mobTradeSetFilter('spot'); return document.querySelectorAll('#mobMktRows [id^="mobFavBtn-"]').length })
t('the Spot tab under Strict is the strict list (64 pairs, fewer once duplicates fold)', spot > 20 && spot <= 64, spot)

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
