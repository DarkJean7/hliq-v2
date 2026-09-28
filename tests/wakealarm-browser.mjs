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

// Media without a gesture: the alarm is audio, and whether Chromium's autoplay policy lets a
// headless runner start it is not what is under test here — arming, choosing a sound, ringing
// and re-arming are. Without this the suite passed locally and failed on the runner, where a
// refused play() disarmed the alarm halfway through and the last check had nothing to re-arm.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
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

console.log(NL + '-- and there is more than one sound to wake to --')
{
  await p.evaluate(() => window.mobVTab('settings'))
  await waitFor(p, 'the alarm row', () => !!document.querySelector('#mobVContent [data-wake-alarm] .pa-alarm'), null, 20000)
  const pills = await p.evaluate(() => [...document.querySelectorAll('#mobVContent [data-wake-alarm] [data-alarm-snd]')]
    .map(b => b.textContent.trim()))
  ok('several sounds are offered', pills.length >= 5, pills)
  ok('named rather than numbered', pills.every(x => /^[A-Za-z]/.test(x)), pills)
  const before = await p.evaluate(() => localStorage.getItem('hliq_wake_alarm_sound'))
  // Tapping one picks it AND plays it — choosing an alarm you have never heard is guessing.
  await p.click('#mobVContent [data-wake-alarm] [data-alarm-snd="klaxon"]')
  await p.waitForTimeout(400)
  const after = await p.evaluate(() => localStorage.getItem('hliq_wake_alarm_sound'))
  ok('tapping one chooses it', after === 'klaxon', { before, after })
  ok('and the choice is shown', await p.evaluate(() =>
    !!document.querySelector('#mobVContent [data-wake-alarm] [data-alarm-snd="klaxon"].on')))
  // It survives a reload, which is the only way an alarm set at bedtime is any use.
  await boot()
  await p.evaluate(() => window.mobVTab('settings'))
  await waitFor(p, 'the alarm row again', () => !!document.querySelector('#mobVContent [data-wake-alarm] .pa-alarm'), null, 20000)
  ok('and the next night still has it', await p.evaluate(() =>
    !!document.querySelector('#mobVContent [data-wake-alarm] [data-alarm-snd="klaxon"].on')))
}

console.log(NL + '-- an alert reads as the price it was set at --')
{
  // Reported: an alert set at $0.00543 shown as "$0.01" — "idk if it triggers at that price
  // or 0.0054 like its really supposed". It triggers at what was stored; fmtUSD rounds to
  // cents, which erases a sub-cent coin entirely.
  await p.evaluate(() => {
    localStorage.setItem('hliq_price_alerts', JSON.stringify([
      { id: 'a1', coin: 'PUMP', dir: 'above', price: 0.00543, fired: false },
    ]))
  })
  await p.evaluate(() => window.__quickPriceAlert('PUMP', 0.005))
  await waitFor(p, 'the alert sheet', () => !!document.getElementById('qaSheet'))
  const existing = await p.evaluate(() => document.getElementById('qaExisting')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  // And the other half of the report: "when trying to set a new one it does not tell me the
  // ones that where already set".
  ok('the sheet lists what is already set on that market', /already set/i.test(existing), existing)
  ok('at the price it was set at, not rounded to a cent', /0\.00543/.test(existing), existing)
  ok('and not "$0.01"', !/\$0\.01/.test(existing), existing)
  ok('with the direction it was set in', /↑/.test(existing), existing)

  // Solid: numbers to read, not a window onto the wallpaper.
  const bg = await p.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('qaSheet'))
    return { color: cs.backgroundColor, image: cs.backgroundImage }
  })
  ok('the sheet is not see-through', !/rgba\([^)]+,\s*0(\.\d+)?\)/.test(bg.color), bg.color)
  ok('and carries no wallpaper behind it', !/url\(/.test(bg.image), bg.image.slice(0, 60))

  // Removing one from the sheet takes it off the list in place.
  await p.click('#qaExisting .qa-existing-x')
  await p.waitForTimeout(250)
  const after = await p.evaluate(() => document.getElementById('qaExisting')?.textContent?.trim() ?? '')
  ok('and one can be removed from here', after === '', after)
  await p.evaluate(() => window.__qaClose())
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

// That the alarm no longer depends on notification permission is asserted in
// tests/suites/alarm.test.mjs, which reads main.js from disk. This file used to fetch
// /src/main.js and check it here — which works against a dev server and silently reads the
// SPA's index.html against a build, where CI serves dist/. It failed there, on the one thing
// that is not a behaviour of the page at all.

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
