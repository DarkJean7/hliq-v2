// "What moved" against LIVE Hyperliquid, on a real wallet (not hermetic, not in browser.mjs).
//
// "in what moved it seems that it does not include spot, hip4 outcomes". Spot tokens and outcome
// positions still held must show their price move as rows, beside the perps; and the Positions
// sort bar must carry a labelled Allocation button rather than a bare ring.
//
//   npm run dev &   then   node tests/attribution-live.mjs --addr=0x… [--port=5175] [--shot=path.png]
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
const ADDR = arg('addr', '')
if (!/^0x[0-9a-fA-F]{40}$/.test(ADDR)) { console.error('--addr=0x… (a wallet holding spot or an outcome)'); process.exit(2) }
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 430, height: 930 }, isMobile: true })).newPage()
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 120000 })
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
// A PRICED token or an outcome — USDC alone, or a token whose mid has not loaded, is not yet
// something whose move could show.
await p.waitForFunction(() => (window.__ovSpotHoldings?.() ?? []).some(h => h.coin !== 'USDC' && h.usd > 1)
  || (window.__ovOutcomeHoldings?.() ?? []).length > 0, null, { timeout: 60000 })

// The sort bar is only drawn over positions; a wallet holding none has nothing to sort.
if (await p.$('.mob-sortbar')) {
  const btn = await p.$('.mob-pill-alloc')
  t('the sort bar has a labelled Allocation button', !!btn && /Allocation/.test(await btn.textContent()))
}

const held = await p.evaluate(() => ({
  spot: (window.__ovSpotHoldings?.() ?? []).filter(h => h.coin !== 'USDC' && h.usd > 1).map(h => h.coin),
  oc: (window.__ovOutcomeHoldings?.() ?? []).map(h => h.coin),
}))
console.log('  holding', JSON.stringify(held))

await p.evaluate(() => { window.__openMovers?.() })
await p.evaluate(() => window.__attrSetPeriod?.('ALL'))
await p.waitForFunction(() => {
  const b = document.getElementById('attrBody')
  return b && !/Calculating/.test(b.textContent)
}, null, { timeout: 45000 })
const body = await p.$eval('#attrBody', e => e.textContent)
t('spot holdings appear as Spot rows', !held.spot.length || /Spot/.test(body), body.slice(0, 300))
// Priced in cents AND unrealized: a settled outcome's realized row is in cents too, so only an
// Unrealized line in cents shows a position still held.
const lines = await p.$$eval('#attrBody [style*="line-height:1.5"]', es => es.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
console.log('  rows', JSON.stringify(lines.slice(0, 8)))
t('an outcome held appears too', !held.oc.length || lines.some(l => /Unrealized/.test(l) && /¢/.test(l)), lines)
if (arg('shot')) await p.screenshot({ path: arg('shot'), fullPage: false })
console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
