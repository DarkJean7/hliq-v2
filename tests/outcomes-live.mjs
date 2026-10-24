// LIVE check, not part of the hermetic browser suite: loads the app against real Hyperliquid and
// reports which outcome markets the Outcomes tab hides, and what a search for "nba" finds.
// Written when 80 live markets (every NBA game, totals, spreads, IPOs) were hidden as "junk".
//   npm run dev   (or a preview on 5175)   then   node tests/outcomes-live.mjs [--port=5175]
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '--port=5175').slice(7)
const URL = `http://localhost:${port}/app`
const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 430, height: 930 }, isMobile: true })).newPage()
const waitFor = async (what, fn, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await p.evaluate(fn).catch(() => false)) return; await p.waitForTimeout(250) }
  throw new Error('timed out waiting for ' + what)
}
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor('boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor('the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.evaluate(() => window.switchTab('outcomes'))
await waitFor('the outcome cards', () => document.querySelectorAll('#ocGrid .oc-card').length >= 20)

const r = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('#ocGrid .oc-card')]
  const shown = cards.filter(c => !c.classList.contains('oc-junk') && !c.classList.contains('oc-grouped'))
  const junk  = cards.filter(c => c.classList.contains('oc-junk')).map(c => c.querySelector('.oc-compact-q')?.textContent?.trim() || c.id)
  const nba   = shown.filter(c => (c.dataset.q || '').includes('nba')).map(c => c.querySelector('.oc-compact-q')?.textContent?.trim())
  const nbaEv = [...document.querySelectorAll('#ocGrid .oc-event')].filter(c => (c.dataset.q || '').includes('nba')).length
  return { total: cards.length, shown: shown.length, junk, nba, nbaEv }
})
console.log(`cards ${r.total}, standalone shown ${r.shown}, hidden as junk ${r.junk.length}`)
console.log('hidden:', r.junk.slice(0, 15))
console.log(`"nba": ${r.nba.length} games + ${r.nbaEv} events`, r.nba.slice(0, 6))
await b.close()
