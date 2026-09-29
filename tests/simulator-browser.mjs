// The Trade Simulator, in the app, on both shells.
//
// Asked for: "remake the simulator tab to be more clean, detailed, optimized for multiple
// different strategies, make it non-transparent, add most common strategy bots". What the unit
// suites cannot see is the part that is a screen: that the page is solid over a wallpaper,
// that it is two columns on a monitor and one on a phone without scrolling sideways, that
// every strategy card is there and choosing one swaps the form, and that Run, Compare, a row
// of the board, and a sweep each put a real report on the page.
//
// Hermetic: candles are generated here and served for any market asked for, and sockets are
// closed, so a run cannot fail because Hyperliquid is having a bad morning.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || ('http://localhost:' + port + '/')
const SHOTS = (process.argv.find(a => a.startsWith('--shots=')) || '').split('=')[1] || ''
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

// ── candles for any market ───────────────────────────────────────────────────
// A slow swing with noise, seeded by the market's name so each market is different and every
// run of this file sees the same ones. Enough for every strategy to have something to do.
const IV = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 4 * 3600e3, '8h': 8 * 3600e3, '1d': 86400e3 }
function candles(coin, interval) {
  let seed = [...String(coin)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 2147483647 || 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const ms = IV[interval] ?? 3600e3
  const n = 5000, end = Math.floor(Date.now() / ms) * ms
  const out = []
  let px = 20 + (seed % 80)
  const base = px
  for (let i = 0; i < n; i++) {
    const o = px
    px = base * (1 + 0.15 * Math.sin(i / 90) + 0.05 * Math.sin(i / 17)) * (1 + (rnd() - 0.5) * 0.012)
    const h = Math.max(o, px) * (1 + rnd() * 0.004), l = Math.min(o, px) * (1 - rnd() * 0.004)
    const t = end - (n - i) * ms
    out.push({ t, T: t + ms - 1, s: coin, i: interval, o: String(o), c: String(px), h: String(h), l: String(l), v: '1000', n: 10 })
  }
  return out
}

const MARGIN = { accountValue: '1000.0', totalNtlPos: '0', totalRawUsd: '1000.0', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '1000.0', assetPositions: [], time: Date.now() }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: {},
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], extraAgents: [], allPerpMetas: [{ universe: [] }], outcomeMeta: {},
  perpDexs: [null], perpCategories: [], portfolio: [],
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '1000' },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

async function open(device, label) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext(device)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  let candleCalls = 0
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (b.type === 'candleSnapshot') {
      candleCalls++
      return route.fulfill({ status: 200, contentType: 'application/json', json: candles(b.req?.coin, b.req?.interval) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
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
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'One' }]))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  return { browser, p, errs, calls: () => candleCalls, label }
}

const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }) }

// ── desktop ──────────────────────────────────────────────────────────────────
console.log(NL + '-- desktop: the page --')
{
  const { browser, p, errs, calls } = await open({ viewport: { width: 1600, height: 1000 } }, 'desktop')
  await p.evaluate(() => window.switchTab('simulator', null))
  const there = await waitFor(p, 'the simulator', () => !!document.querySelector('#deskSim .sim-root'))
  ok('it opens', there)
  // Solid: the root paints a real colour, not transparent, whatever is behind it.
  const bg = await p.evaluate(() => getComputedStyle(document.querySelector('#deskSim .sim-root')).backgroundColor)
  ok('the page is solid, not see-through', bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg), bg)
  const cardBg = await p.evaluate(() => getComputedStyle(document.querySelector('#deskSim .sim-card')).backgroundColor)
  ok('and so is every card', cardBg && !/rgba\(0, 0, 0, 0\)|transparent/.test(cardBg) && !/, 0\.\d+\)$/.test(cardBg), cardBg)
  const cols = await p.evaluate(() => {
    const a = document.querySelector('#deskSim .sim-config').getBoundingClientRect()
    const b = document.querySelector('#deskSim .sim-results').getBoundingClientRect()
    return { side: a.right <= b.left + 1, top: Math.abs(a.top - b.top) < 4 }
  })
  ok('settings and report sit side by side', cols.side && cols.top, cols)
  const n = await p.evaluate(() => document.querySelectorAll('#deskSim .sim-strat').length)
  ok('every strategy has a card', n === 12, n)
  ok('a first visit says what a run will show', await p.evaluate(() => /No run yet/.test(document.querySelector('#deskSim .sim-results').textContent)))

  console.log(NL + '-- desktop: choosing a strategy swaps the form --')
  await p.click('#deskSim .sim-strat:has-text("RSI reversal")')
  await waitFor(p, 'the RSI form', () => !!document.getElementById('sim_rsiLen'))
  ok('its own settings appear', await p.evaluate(() => !!document.getElementById('sim_rsiLen') && !document.getElementById('sim_vbLookback')))
  ok('and it is the selected card', await p.evaluate(() => document.querySelector('#deskSim .sim-strat.on')?.textContent.includes('RSI')))
  // A category filter narrows the grid but never hides the chosen strategy.
  await p.click('#deskSim .sim-chip:text-is("Grid & DCA")')
  await p.waitForTimeout(150)
  const grid = await p.evaluate(() => [...document.querySelectorAll('#deskSim .sim-strat')].map(b => b.textContent.trim().split(/\s{2,}/)[0]))
  ok('a category narrows the cards', grid.length === 3 && grid.some(x => /DCA/.test(x)) && grid.some(x => /RSI/.test(x)), grid)
  await p.click('#deskSim .sim-chip:text-is("All")')

  console.log(NL + '-- desktop: run --')
  await p.fill('#sim_coin', 'BTC, ETH')
  await p.dispatchEvent('#sim_coin', 'change')
  await p.click('#deskSim .sim-runbar .sim-btn-p')
  const ran = await waitFor(p, 'a result', () => !!document.querySelector('#deskSim .sim-kpis'))
  ok('a run puts a report on the page', ran)
  const kpis = await p.evaluate(() => [...document.querySelectorAll('#deskSim .sim-kpi-l')].map(e => e.textContent.trim()))
  ok('with the headline numbers', ['Net PnL', 'vs buy & hold', 'Max drawdown', 'Win rate', 'Profit factor', 'Sharpe'].every(k => kpis.includes(k)), kpis)
  ok('an equity curve against holding', await p.evaluate(() =>
    document.querySelectorAll('#deskSim .sim-eq path').length >= 3 && /Buy & hold/.test(document.querySelector('#deskSim .sim-eq-legend').textContent)))
  ok('and the stats underneath', await p.evaluate(() => document.querySelectorAll('#deskSim .sim-stats .sim-row').length > 20))
  await p.hover('#deskSim .sim-eq-svg')
  ok('hovering the curve reads it out', await waitFor(p, 'the readout', () => /\$/.test(document.getElementById('simEqTip')?.textContent ?? ''), null, 3000))
  await shot(p, 'desk-run')
  const tabs = await p.evaluate(() => [...document.querySelectorAll('#deskSim .sim-tab')].map(e => e.textContent.trim().split(/\s/)[0]))
  ok('two markets get a Markets tab', tabs.includes('Markets'), tabs)
  await p.click('#deskSim .sim-tab:has-text("Trades")')
  ok('the ledger is a tab away', await waitFor(p, 'trades', () => document.querySelectorAll('#deskSim .sim-trade').length > 0, null, 5000))
  await p.click('#deskSim .sim-tab:has-text("Replay")')
  await p.click('#deskSim .sim-results .sim-btn-p:has-text("Replay this run")')
  ok('the replay draws candles', await waitFor(p, 'replay', () => !!document.querySelector('#simReplayBody svg'), null, 5000))

  console.log(NL + '-- desktop: a changed setting marks the result stale --')
  await p.fill('#sim_rsiLen', '21')
  ok('without re-rendering the box being typed in', await p.evaluate(() =>
    document.getElementById('simStale')?.style.display === '' && document.activeElement?.id === 'sim_rsiLen'))

  console.log(NL + '-- desktop: compare every strategy --')
  const before = calls()
  await p.click('#deskSim .sim-runbar .sim-btn:has-text("Compare all")')
  const cmp = await waitFor(p, 'the board', () => document.querySelectorAll('#deskSim .sim-cmp-row').length > 0, null, 60000)
  ok('the board appears', cmp)
  const rows = await p.evaluate(() => document.querySelectorAll('#deskSim .sim-cmp-row').length)
  // Tokyo cannot run BTC or ETH -- they are not in its table -- and says so rather than
  // pretending. Everything else ranks.
  ok('every strategy that can run on these markets is ranked', rows === 11, rows)
  ok('tokyo says why it is missing', await p.evaluate(() => /not in its table|none of these/.test(document.querySelector('#deskSim .sim-cmp').textContent)))
  ok('buy and hold is the bar to beat', await p.evaluate(() => !!document.querySelector('#deskSim .sim-cmp-bench')))
  ok('and the candles were not fetched again', calls() === before, [before, calls()])
  await p.click('#deskSim .sim-chip:text-is("Sharpe")')
  await shot(p, 'desk-compare')
  const first = await p.evaluate(() => document.querySelector('#deskSim .sim-cmp-row .sim-cmp-n b')?.textContent.trim())
  await p.click('#deskSim .sim-cmp-row >> nth=0')
  await waitFor(p, 'its report', () => !!document.querySelector('#deskSim .sim-res-t'))
  const title = await p.evaluate(() => document.querySelector('#deskSim .sim-res-t')?.textContent.trim())
  ok('a row opens as that strategy\'s full report', first && title && title.startsWith(first.split(/\s/)[0]), [first, title])

  console.log(NL + '-- desktop: sweep a setting --')
  await p.click('#deskSim .sim-tab:has-text("Sweep")')
  await p.click('#deskSim .sim-results .sim-btn-p:has-text("Run sweep")')
  ok('a sweep fills a table', await waitFor(p, 'the sweep', () => document.querySelectorAll('#deskSim .sim-best').length === 1, null, 30000))
  ok('each row can be applied', await p.evaluate(() => [...document.querySelectorAll('#deskSim .sim-tr .sim-chip')].filter(b => b.textContent.trim() === 'Use').length > 2))
  await shot(p, 'desk-sweep')

  console.log(NL + '-- desktop: DCA --')
  await p.click('#deskSim .sim-strat:has-text("DCA with safety orders")')
  await p.click('#deskSim .sim-runbar .sim-btn-p')
  await waitFor(p, 'a DCA report', () => /DCA/.test(document.querySelector('#deskSim .sim-res-t')?.textContent ?? '') && !!document.querySelector('#deskSim .sim-kpis'))
  ok('its own block is in the stats', await p.evaluate(() => /Deals closed/.test(document.querySelector('#deskSim .sim-stats')?.textContent ?? '')))
  ok('and the money models step aside for its dollar sizes', await p.evaluate(() => !document.getElementById('sim_pnlModel')))

  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

// ── phone ────────────────────────────────────────────────────────────────────
console.log(NL + '-- phone: one column, nothing off the side --')
{
  const { browser, p, errs } = await open({ ...devices['iPhone 14 Pro'], viewport: { width: 430, height: 930 } }, 'phone')
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)
  await p.evaluate(() => window.mobVTab('simulator'))
  const there = await waitFor(p, 'the simulator', () => !!document.querySelector('#mobVContent .sim-root'))
  ok('it opens', there)
  const lay = await p.evaluate(() => {
    const a = document.querySelector('#mobVContent .sim-config').getBoundingClientRect()
    const b = document.querySelector('#mobVContent .sim-results').getBoundingClientRect()
    return { stacked: b.top >= a.bottom - 1, width: a.width }
  })
  ok('the report is under the settings', lay.stacked, lay)
  const wide = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .sim-root *')]
    .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[data-dragscroll]'))
    .map(e => e.className || e.tagName).slice(0, 5))
  ok('nothing runs off the right edge', wide.length === 0, wide)
  await p.click('#mobVContent .sim-runbar .sim-btn-p')
  ok('a run reports', await waitFor(p, 'a result', () => !!document.querySelector('#mobVContent .sim-kpis')))
  const kp = await p.evaluate(() => getComputedStyle(document.querySelector('#mobVContent .sim-kpis')).gridTemplateColumns.split(' ').length)
  ok('two tiles to a row', kp === 2, kp)
  const wide2 = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .sim-root *')]
    .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[data-dragscroll]'))
    .map(e => e.className || e.tagName).slice(0, 5))
  ok('and the report fits the screen too', wide2.length === 0, wide2)
  await p.evaluate(() => document.getElementById('simResTop')?.scrollIntoView())
  await shot(p, 'phone-run')
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
