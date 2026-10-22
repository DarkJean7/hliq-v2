// Signals → Calendar, on screen. Asked: "in signals we have the asset performance just by
// timeframes. what if we also add a calendar performance so i can see the asset performance on a
// desired month from the past".
//
// The market rises exactly 0.1% a day from 2023-01-01, so every figure is known in advance: each
// day +0.1%, a 31-day month +3.1% (1.001^31 − 1). The calendar opens on this month, steps back a
// year, and opens a month from the past.
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

const px = (t) => 100 * Math.pow(1.001, Math.round((t - T0) / DAY))
const candles = (iv, start, end) => {
  const step = iv === '1h' ? 3_600_000 : iv === '1w' ? 7 * DAY : DAY, out = []
  for (let x = Math.max(T0, Math.floor(start / step) * step); x <= (end ?? Date.now()) && out.length < 5000; x += step) {
    const c = iv === '1d' ? px(x) : px(Math.floor(x / DAY) * DAY)
    out.push({ t: x, T: x + step - 1, s: 'BTC', i: iv, o: String(iv === '1d' ? px(x - DAY) : c), c: String(c), h: String(c), l: String(c), v: '1', n: 1 })
  }
  return out
}
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }]
const ctx0 = (p, oi) => ({ funding: '0', openInterest: String(oi), prevDayPx: String(p), dayNtlVlm: '1000000', premium: '0', oraclePx: String(p), markPx: String(p), midPx: String(p), impactPxs: [String(p), String(p)] })
const HL = {
  meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctx0(px(Date.now()), 9000), ctx0(50, 100)]],
  allMids: { BTC: String(px(Date.now())), ETH: '50' }, perpDexs: [null], allPerpMetas: [], perpCategories: [],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  const json = b.type === 'candleSnapshot' ? (b.req?.coin === 'BTC' ? candles(b.req.interval, b.req.startTime, b.req.endTime) : []) : (b.type in HL ? HL[b.type] : {})
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
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.evaluate(() => { window.switchTab('analysis'); window.__pulseSetSeg('signals') })
await waitFor(p, 'the calendar', () => document.querySelectorAll('#sigCalCard [data-calm]').length === 12)

// "make it more clear which asset is the one used for the calendar. also by default hide the
// month's days (add a toggle button)".
console.log('\n-- it says which market, and keeps the days folded --')
t('the header names the market the calendar is for', await p.evaluate(() => document.querySelector('#sigCalAsset b')?.textContent.trim()), 'BTC')
t('the days are hidden at first', await p.evaluate(() => document.querySelectorAll('#sigCalCard [data-calday]').length), 0)
t('behind a toggle', await p.evaluate(() => document.getElementById('sigCalDaysBtn')?.textContent.trim()), 'Show days ▾')
await p.click('#sigCalDaysBtn')
await waitFor(p, 'the days', () => document.querySelectorAll('#sigCalCard [data-calday]').length >= 28)
t('which shows them', await p.evaluate(() => document.getElementById('sigCalDaysBtn')?.textContent.trim()), 'Hide days ▴')
t('and is remembered', await p.evaluate(() => localStorage.getItem('hliq_sig_cal_days')), '1')

const now = new Date()
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const view = () => p.evaluate(() => ({
  year: document.getElementById('sigCalYearLbl')?.textContent,
  month: document.getElementById('sigCalMonthLbl')?.textContent,
  total: document.getElementById('sigCalTotal')?.textContent.trim(),
  months: document.querySelectorAll('#sigCalCard [data-calm]').length,
  day1: document.querySelector('#sigCalCard [data-calday="1"]')?.textContent.replace(/\s+/g, ' ').trim(),
  days: document.querySelectorAll('#sigCalCard [data-calday]').length,
}))

console.log('\n-- it opens on this month --')
let v = await view()
t('this year', v.year, String(now.getUTCFullYear()))
t('this month', v.month, MON[now.getUTCMonth()] + ' ' + now.getUTCFullYear())
t('twelve months to pick from', v.months, 12)
t('the 1st reads +0.1%, as the market moved', v.day1, '1 +0.1%')

console.log('\n-- a month from the past --')
await p.click('#sigCalCard [data-calyear="-1"]')
await p.waitForTimeout(200)
v = await view()
t('back a year', v.year, String(now.getUTCFullYear() - 1))
await p.click('#sigCalCard [data-calm="2"]')
await p.waitForTimeout(200)
v = await view()
t('March of last year', v.month, 'Mar ' + (now.getUTCFullYear() - 1))
t('with its 31 days', v.days, 31)
t('and its return: 31 days of +0.1% = +3.1%', v.total, 'BTC +3.1%')

console.log('\n-- back to where it started --')
await p.click('#sigCalCard [data-calyear="-1"]'); await p.click('#sigCalCard [data-calyear="-1"]')   // 2025 → 2024 → 2023
await p.waitForTimeout(200)
v = await view()
t('it stops at the first year there is data for', v.year, '2023')
t('where ‹ is disabled', await p.evaluate(() => document.querySelector('#sigCalCard [data-calyear="-1"]').disabled), true)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
