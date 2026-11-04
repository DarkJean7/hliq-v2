// The Trade chart's candle budget against LIVE Hyperliquid (not hermetic, not in browser.mjs).
//
// "i just got rate limited in hyperliquid.xyz". A candle request costs 20 + 1 per 60 candles, and
// the chart asked for 5,000 at a time — twice on opening the Trade tab. It now opens on a page of
// 1,000, once, and asks for the page before only when you scroll back to it. Kept small on
// purpose — about a hundred weight — because the IP it runs from is the one you trade from.
//
//   npm run dev &   then   node tests/chartolder-live.mjs [--port=5175]
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
  try { const j = JSON.parse(r.postData() || '{}'); if (j.type === 'candleSnapshot') asked.push(j.req) } catch {}
})
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.loadDashboard && !!window.__selectCoin, null, { timeout: 120000 })
await p.evaluate(() => { document.getElementById('walletInput').value = '0x' + '0'.repeat(39) + '1'; return window.loadDashboard() })
await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
await p.evaluate(() => { window.__selectCoin('BTC'); window.switchTab('trade') })
await p.waitForFunction(() => (window.__tradeChartState?.()?.bars ?? 0) > 50 && /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 60000 })

const H = 3600e3
const span = (q) => Math.round(((q.endTime ?? Date.now()) - q.startTime) / H)
t('opening the chart asks once', asked.length === 1, asked)
t('for a 1,000-candle page, not 5,000', asked[0] && span(asked[0]) <= 1001, asked.map(span))
const n0 = (await p.evaluate(() => window.__tradeChartState())).bars

// Back to the oldest loaded candle: the page before it arrives, and the view stays put.
await p.evaluate(() => window.__tradeChartScrollTo?.(0))
await p.waitForFunction((n) => (window.__tradeChartState()?.bars ?? 0) > n, n0, { timeout: 30000 }).catch(() => {})
const st = await p.evaluate(() => window.__tradeChartState())
t('scrolled back, the earlier page is added', st.bars > n0 + 500, { n0, now: st.bars })
t('with one request for it, ending where the chart began', asked.length === 2 && asked[1].endTime != null, asked)
t('and the candles on screen did not jump', st.range.from > 500, st.range)

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
