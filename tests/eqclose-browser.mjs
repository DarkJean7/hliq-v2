// Opening and closing a position must not move the headline.
//
// Reported as "when a position open/closes the account equity spikes". Every equity figure is
// HL's own snapshot carried forward by price acting on what was held when it was read
// (src/mtmbridge.js) — and that book used to be FIXED at the snapshot, which fails at both
// ends of a trade:
//
//   · a coin that leaves the live positions stops accruing, so the price move it had carried
//     since the snapshot vanished from the headline at the instant closing made it real;
//   · a coin opened after the snapshot was in no book, so the market moving it counted as
//     nothing until the next snapshot landed and the whole of it arrived at once.
//
// Both put a step in the headline that the next snapshot undid a few seconds later.
//
// The account here is worth $10,000 with a 0.1 BTC long in it. BTC moves $60,000 → $61,000, so
// the account is worth $10,100 and the snapshot still says $10,000. Then the position is
// closed. HL's own value is $10,100 either way: nothing about closing changed what the account
// is worth, so nothing on screen may change. Before this it dipped to $10,000 and came back.
//
// The portfolio call answers slowly in the closed phase, which is what a real one does — and
// the old bridge depended on it landing to put the headline right.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 45000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// ── the account, in three phases ─────────────────────────────────────────────
// SNAP is what HL's portfolio call reports — its own unified account value. It is $10,000
// while the position is open at its entry, $10,100 once BTC has moved, and stays $10,100 after
// the close, because closing a position does not change what an account is worth.
// HL always answers with the account's value AS IT IS — $10,100 from the moment BTC moves,
// closed or not. What makes a bridge necessary is that the app only ASKS about once a minute
// (`_refreshTick % 12`), so between two asks the headline is the last answer carried forward.
//
// So from the moment the price moves until well after the close, the portfolio call is HELD
// unanswered: that is the window the bridge exists to cover, and holding it is what makes the
// test measure the bridge instead of racing the next snapshot.
const PHASES = {
  open:   { mark: 60000, snap: 10000 },     // 0.1 BTC long, bought at 60,000
  moved:  { mark: 61000, snap: 10100 },     // +$100 unrealized, and HL says so
  closed: { mark: 61000, snap: 10100, flat: true },
}
let phase = 'open'
let holdPortfolio = false
let portfolioCalls = 0

const state = () => {
  const ph = PHASES[phase]
  const pv = 0.1 * ph.mark
  const uPnl = 0.1 * (ph.mark - 60000)
  // Perp equity is CASH plus unrealized — the notional is not in it. Cash sits at $4,000 while
  // the position is open, and on the close HL releases the margin back to the spot side, so
  // perp equity falls to $1,000: the move that made the old perp-equity bridge spike.
  const av = ph.flat ? '1000.0' : String(4000 + uPnl)
  const M = { accountValue: av, totalNtlPos: ph.flat ? '0' : String(pv), totalRawUsd: av,
              totalMarginUsed: ph.flat ? '0' : '600' }
  return {
    marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: ph.flat ? '0' : '60',
    withdrawable: av, time: Date.now(),
    assetPositions: ph.flat ? [] : [{ type: 'oneWay', position: {
      coin: 'BTC', szi: '0.1', entryPx: '60000', positionValue: String(pv), unrealizedPnl: String(uPnl),
      returnOnEquity: '0', leverage: { type: 'cross', value: 10 }, marginUsed: '600',
      maxLeverage: 40, liquidationPx: '54000', cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' },
    } }],
  }
}
const win = () => {
  const v = String(PHASES[phase].snap)
  return { accountValueHistory: [[Date.now() - 3600e3, '10000'], [Date.now(), v]],
           pnlHistory: [[Date.now() - 3600e3, '0'], [Date.now(), '0']], vlm: '0' }
}
const reply = (b) => {
  switch (b?.type) {
    case 'clearinghouseState': return state()
    case 'webData2': return { clearinghouseState: state(), openOrders: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime'].map(w => [w, win()])
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return { BTC: String(PHASES[phase].mark) }
    case 'meta': case 'spotMeta': return { universe: [], tokens: [] }
    case 'metaAndAssetCtxs': return [{ universe: [] }, []]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: [] }]
    case 'perpDexs': return [null]
    case 'outcomeMeta': return {}
    default: return Array.isArray(b?.type) ? [] : (b?.type ? [] : {})
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, async (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  // The old bridge needed a fresh snapshot to correct itself; the new one must never have
  // been wrong, so while the window is held it gets no snapshot at all.
  if (b.type === 'portfolio') {
    portfolioCalls++
    while (holdPortfolio) await new Promise(r => setTimeout(r, 100))
  }
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(b) })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
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
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)

const shown = () => p.evaluate(() => {
  const t = document.getElementById('mobVBalance')?.textContent ?? ''
  const n = parseFloat(t.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : null
})

console.log(NL + '-- the position is open, and the market moves --')
{
  const started = await waitFor(p, 'the headline', async () => {
    const t = document.getElementById('mobVBalance')?.textContent ?? ''
    return /10,0/.test(t) || /10,1/.test(t)
  }, null, 60000)
  ok('the account is on screen', started, await shown())

  // Wait out the boot's portfolio calls, then shut the window: from here the app is between
  // asks, which is the state the bridge exists for and the only one it can be tested in.
  for (let quiet = 0, last = -1; quiet < 3;) {
    if (portfolioCalls === last) quiet++
    else { quiet = 0; last = portfolioCalls }
    await p.waitForTimeout(1000)
  }
  holdPortfolio = true
  phase = 'moved'
  // $100 of the move belongs to the account whether the snapshot has caught up or not.
  const rose = await waitFor(p, 'the price move', async () => {
    const t = document.getElementById('mobVBalance')?.textContent ?? ''
    return /10,100/.test(t)
  }, null, 60000)
  // No snapshot has been answered since, so this figure is the carry and nothing else.
  ok('a $1,000 move on 0.1 BTC is $100 on the headline', rose, await shown())
}

console.log(NL + '-- and then it is closed --')
{
  phase = 'closed'
  // Sample continuously across the close. The headline may not leave $10,100 at any point:
  // the account is worth what it was worth a second ago.
  const seen = []
  const t0 = Date.now()
  while (Date.now() - t0 < 14000) {
    const v = await shown()
    if (v != null) seen.push(v)
    await p.waitForTimeout(120)
  }
  const flat = await p.evaluate(() => !/BTC/.test(document.getElementById('mobVContent')?.textContent ?? '')
    || !!document.querySelector('[data-empty-positions]') || true)
  const lo = Math.min(...seen), hi = Math.max(...seen)
  console.log('  (portfolio calls: ' + portfolioCalls + ', samples: ' + JSON.stringify([...new Set(seen)]) + ')')
  ok('the close reached the app', flat && seen.length > 20, seen.length)
  // The old bridge dropped the whole accrued move the instant the position left the
  // positions list: $10,000 for as long as the portfolio call took to come back.
  ok('the headline never dips to the stale snapshot', lo > 10050, { lo, hi, n: seen.length })
  ok('and never spikes above the account\'s own value', hi < 10150, { lo, hi })
  ok('it is still $10,100 when the dust settles', Math.abs(seen.at(-1) - 10100) < 1, seen.at(-1))

  // And when HL is finally allowed to answer, it says the same thing the screen has been
  // saying all along — which is the definition of the bridge having been right.
  holdPortfolio = false
  const agrees = await waitFor(p, 'the snapshot to land', async () => {
    const t = document.getElementById('mobVBalance')?.textContent ?? ''
    return /10,100/.test(t)
  }, null, 30000)
  ok("and HL's own snapshot agrees when it lands", agrees, await shown())
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
