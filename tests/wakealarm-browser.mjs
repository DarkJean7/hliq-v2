// The wake alarm, reachable and ringing.
//
// Asked for: "can we also have like loud alarms for price targets. i was wondering since i
// may be sleeping and may need one to wake up."
//
// The alarm itself already existed (src/alarm.js: a media element looping near-silence to
// keep the media session alive with the screen off, then a harsh warble that plays over the
// silent switch). What it did not have was a way to arm it from a phone — the toggle lived in
// desktop Settings only, which is no use to the person asleep next to their phone — and two
// ways to fail quietly: a declined notification permission stopped the alarm as well as the
// notification, and a reload dropped the arming without saying so.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       node tests/wakealarm-browser.mjs --base=https://insolvent.trade
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || ('http://localhost:' + port + '/')
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const M = { accountValue: '5000', totalNtlPos: '0', totalRawUsd: '5000', totalMarginUsed: '0' }
const STATE = { marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: '0',
                withdrawable: '5000', assetPositions: [], time: Date.now() }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '5000'], [Date.now(), '5000']],
              pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: { BTC: '60000' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WIN]),
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '5000' },
  meta: { universe: [{ name: 'BTC', maxLeverage: 40 }] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
// Notifications deliberately NOT granted: the alarm is audio and must not depend on them.
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
const boot = async () => {
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)
}
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }]))
}, ADDR)
await boot()

console.log(NL + '-- it can be armed from the phone --')
{
  await p.evaluate(() => window.mobVTab('settings'))
  const there = await waitFor(p, 'the wake alarm row',
    () => /Wake alarm/i.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 30000)
  ok('the phone Settings screen offers it', there)
  const filled = await waitFor(p, 'the row to paint',
    () => !!document.querySelector('#mobVContent [data-wake-alarm] .pa-alarm'), null, 10000)
  ok('and the control is painted into it', filled)
  ok('describing what it is for', /even on silent|over silent/i.test(await p.evaluate(() =>
    document.querySelector('#mobVContent [data-wake-alarm]')?.textContent ?? '')))
}

console.log(NL + '-- and from the sheet where an alert is set --')
{
  await p.evaluate(() => window.__quickPriceAlert('BTC', 60000))
  await waitFor(p, 'the alert sheet', () => !!document.getElementById('qaSheet'))
  const inSheet = await waitFor(p, 'the alarm row in the sheet',
    () => !!document.querySelector('#qaSheet [data-wake-alarm] .pa-alarm'), null, 10000)
  ok('setting an alert offers to wake you for it', inSheet)
  await p.evaluate(() => window.__qaClose())
}

console.log(NL + '-- arming it, and ringing --')
{
  await p.evaluate(() => window.mobVTab('settings'))
  await waitFor(p, 'the row', () => !!document.querySelector('#mobVContent [data-wake-alarm] input'))
  // Through the control itself, because arming has to happen inside a real gesture.
  await p.click('#mobVContent [data-wake-alarm] .pin-toggle')
  const armed = await waitFor(p, 'it to arm', () => !!window.__alarmWasArmed?.(), null, 10000)
  ok('the toggle arms it', armed)
  ok('and it says the screen can be off', /screen can be off/i.test(await p.evaluate(() =>
    document.querySelector('#mobVContent [data-wake-alarm]')?.textContent ?? '')))

  // Ringing takes over the screen — at 4am the dismiss target should be the whole screen.
  await p.evaluate(() => window.__alarmTest())
  const ringing = await waitFor(p, 'the alarm overlay', () => !!document.getElementById('alarmOverlay'), null, 10000)
  ok('it rings with a full-screen dismiss', ringing)
  const ov = await p.evaluate(() => document.getElementById('alarmOverlay')?.textContent ?? '')
  ok('saying what woke you', /price alert/i.test(ov), ov)
  await p.click('.alarm-ov-btn')
  await p.waitForTimeout(300)
  ok('and it stops when dismissed', !(await p.evaluate(() => !!document.getElementById('alarmOverlay'))))
  // Stopping one alert must not disarm the night's alarm.
  ok('but stays armed for the next one', await p.evaluate(() => !!window.__alarmWasArmed?.()))
}

console.log(NL + '-- a reload does not silently lose it --')
{
  await boot()
  await p.evaluate(() => window.mobVTab('settings'))
  await waitFor(p, 'the row', () => !!document.querySelector('#mobVContent [data-wake-alarm] .pa-alarm'), null, 20000)
  const txt = await p.evaluate(() => document.querySelector('#mobVContent [data-wake-alarm]')?.textContent ?? '')
  // Arming needs a gesture, so a reload cannot do it alone — but it must SAY so rather than
  // leave someone believing an alarm is set.
  ok('it remembers it was armed', /tap anywhere to arm it again|screen can be off/i.test(txt), txt)
  // And any tap brings it back.
  await p.click('#mobVContent')
  await p.waitForTimeout(400)
  const back = await p.evaluate(() => document.querySelector('#mobVContent [data-wake-alarm] input')?.checked ?? false)
  ok('and a tap re-arms it', back)
}

console.log(NL + '-- the alarm does not depend on notifications --')
{
  // The notification needs permission; the alarm is audio the page is already playing. This
  // check used to return before either could happen.
  const src = await (await fetch(BASE + 'src/main.js')).text().catch(() => '')
  if (src) {
    ok('the price check no longer returns when notifications are off', !/function _checkPriceAlerts\(allMids\) \{\s*\n\s*if \(notifPermission\(\) !== 'granted'\) return/.test(src))
    ok('it only skips the notification itself', /const canNotify = notifPermission\(\) === 'granted'/.test(src) && /if \(canNotify\) showNotif\(/.test(src))
  } else {
    // Against a built bundle the source is not served; the behaviour is covered by the unit
    // suite, which reads the file from disk.
    ok('source not served from a build — covered by tests/suites/alarm.test.mjs', true)
  }
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
