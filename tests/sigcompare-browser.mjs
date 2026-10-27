// Signals → Compare with, on screen. Asked: "lets add also a search bar for Compare with. also
// allow to compare with multiples assets simultaneously".
//
// Seven markets, ranked by open interest, so the compare row's usual five leave two to be found by
// search. Each market rises a fixed amount a day from 2023-01-01, so every one has history and its
// own line.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const DAY = 86_400_000
const T0 = Date.UTC(2023, 0, 1)

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

const COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'AVAX']
// Steeper first, so BTC is also the most valuable: the app ranks by open interest in dollars.
const rate = (coin) => 1 + 0.0005 * (COINS.length - COINS.indexOf(coin))
const px = (coin, t) => 100 * Math.pow(rate(coin), Math.round((t - T0) / DAY))
const candles = (coin, iv, start, end) => {
  const step = iv === '1h' ? 3_600_000 : iv === '1w' ? 7 * DAY : DAY, out = []
  for (let x = Math.max(T0, Math.floor(start / step) * step); x <= (end ?? Date.now()) && out.length < 5000; x += step) {
    const c = px(coin, Math.floor(x / DAY) * DAY)
    out.push({ t: x, T: x + step - 1, s: coin, i: iv, o: String(c), c: String(c), h: String(c), l: String(c), v: '1', n: 1 })
  }
  return out
}
const UNIVERSE = COINS.map(name => ({ name, szDecimals: 3, maxLeverage: 20 }))
const ctx0 = (p, oi) => ({ funding: '0', openInterest: String(oi), prevDayPx: String(p), dayNtlVlm: '1000000', premium: '0', oraclePx: String(p), markPx: String(p), midPx: String(p), impactPxs: [String(p), String(p)] })
const now = Date.now()
const HL = {
  meta: { universe: UNIVERSE },
  // Open interest falls down the list, so the order above is the order of the chips.
  metaAndAssetCtxs: [{ universe: UNIVERSE }, COINS.map((c, i) => ctx0(px(c, now), 9000 - i * 1000))],
  allMids: Object.fromEntries(COINS.map(c => [c, String(px(c, now))])), perpDexs: [null], allPerpMetas: [], perpCategories: [],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  const json = b.type === 'candleSnapshot' ? (COINS.includes(b.req?.coin) ? candles(b.req.coin, b.req.interval, b.req.startTime, b.req.endTime) : [])
    : (b.type in HL ? HL[b.type] : {})
  return route.fulfill({ status: 200, contentType: 'application/json', json })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('hliq_pulse_seg', 'signals')
  // A single comparison saved by the version before this one: it must still load.
  localStorage.setItem('hliq_sig_cmp', 'ETH')
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.evaluate(() => { window.switchTab('analysis'); window.__pulseSetSeg('signals') })
await waitFor(p, 'the compare row', () => document.querySelectorAll('#sigCmpRow button').length >= 5)

const state = () => p.evaluate(() => ({
  picked: [...document.querySelectorAll('#sigCmpRow button[aria-pressed="true"]')].map(b => b.textContent.replace('×', '').trim()),
  chips: [...document.querySelectorAll('#sigCmpRow button')].map(b => b.textContent.replace('×', '').trim()),
  perf: [...document.querySelectorAll('#sigRoot table tr td:first-child')].map(td => td.textContent.replace('●', '').trim()).filter(Boolean),
  lines: [...document.querySelectorAll('#sigChartCard svg path[stroke^="#"]')].map(e => e.getAttribute('stroke')),
}))

console.log('\n-- a comparison saved before still loads --')
let s = await state()
t('ETH is compared', s.picked, ['ETH'])

console.log('\n-- several at once --')
await p.evaluate(() => window.__sigSetCmp('SOL'))
await waitFor(p, 'two lines', () => document.querySelectorAll('#sigChartCard svg path[stroke="#a78bfa"]').length > 0)
s = await state()
t('ETH and SOL are both compared', s.picked, ['ETH', 'SOL'])
t('each has a performance row', s.perf, ['BTC', 'ETH', 'SOL'])
t('and its own line, in its own colour', ['#f472b6', '#a78bfa'].every(c => s.lines.includes(c)), true)
t('the calendar names both', await p.evaluate(() => /vs ETH, SOL/.test(document.getElementById('sigCalCard')?.textContent ?? '')), true)

console.log('\n-- compare has its own search --')
t('a search box beside it', await p.evaluate(() => !!document.getElementById('sigCmpSearch')), true)
t('AVAX is not in the usual five', s.chips.includes('AVAX'), false)
await p.fill('#sigCmpSearch', 'ava')
await waitFor(p, 'the match', () => [...document.querySelectorAll('#sigCmpRow button')].some(b => b.textContent.includes('AVAX')))
s = await state()
t('typing finds it, and the picked ones stay in reach', s.chips, ['None', 'ETH', 'SOL', 'AVAX'])
t('the search keeps the keyboard', await p.evaluate(() => document.activeElement?.id), 'sigCmpSearch')
t('and does not touch the market row', await p.evaluate(() => [...document.querySelectorAll('#sigMarketRow button')].length), 5)
await p.evaluate(() => [...document.querySelectorAll('#sigCmpRow button')].find(b => b.textContent.includes('AVAX')).click())
await waitFor(p, 'the third line', () => document.querySelectorAll('#sigChartCard svg path[stroke="#fbbf24"]').length > 0)
s = await state()
t('AVAX is the third', s.picked, ['ETH', 'SOL', 'AVAX'])
t('a nonsense search says so', await p.evaluate(() => { window.__sigCmpSearch('zzzz'); return document.getElementById('sigCmpNoMatch').style.display }), '')

console.log('\n-- taking them off --')
await p.evaluate(() => { window.__sigCmpSearch(''); window.__sigSetCmp('SOL') })
await p.waitForTimeout(200)
s = await state()
t('pressing one again removes it', s.picked, ['ETH', 'AVAX'])
t('the main market cannot be compared with itself', await p.evaluate(() => { window.__sigSetCmp('BTC'); return localStorage.getItem('hliq_sig_cmp') }), 'ETH,AVAX')
await p.evaluate(() => window.__sigSetCmp(''))
await p.waitForTimeout(200)
s = await state()
t('None clears them all', s.picked, [])
t('and the chart is back to one line in price units', s.lines.filter(c => ['#f472b6', '#a78bfa', '#fbbf24', '#34d399'].includes(c)).length, 0)

console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
await browser.close()
process.exit(fail + errs.length ? 1 : 0)
