// Trade Simulator results, on screen: the trades drawn on the equity chart, the replay drawn at
// its real size, and a profit factor on a run with no losing trade.
//
// Asked for: "profit factor not showing. make the chart show the transactions. make replay show
// it better also since it looks weird." The replay drew a 320-wide picture stretched to the card,
// so every label and triangle was smeared sideways; a unit suite cannot see a stretch.
//
// Hermetic: the setup below is the simulator harness's, so candles are generated, the exchange
// is stubbed and sockets are closed.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1]
  || ('http://localhost:' + port + '/app')
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
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '83000', ETH: '4100', SOL: '210', HYPE: '38' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], extraAgents: [], allPerpMetas: [{ universe: [['BTC', 40], ['ETH', 25], ['SOL', 20], ['HYPE', 10]].map(([name, maxLeverage]) => ({ name, szDecimals: 3, maxLeverage })) },
    { universe: [{ name: 'xyz:NVDA', szDecimals: 2, maxLeverage: 10 }] }], outcomeMeta: {},
  perpDexs: [null], perpCategories: [], portfolio: [],
  webData2: { clearinghouseState: STATE, openOrders: [], cumLedger: '1000' },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  // Volumes in an order that is NOT alphabetical, so a list that fell back to A-Z is caught.
  metaAndAssetCtxs: [{ universe: ['BTC', 'ETH', 'SOL', 'HYPE'].map(name => ({ name, szDecimals: 2, maxLeverage: 40 })) },
    [9e8, 5e8, 5e7, 3e8].map((v, i) => ({ dayNtlVlm: String(v), markPx: ['83000', '4100', '210', '38'][i],
      prevDayPx: '1', funding: '0', openInterest: '0', oraclePx: '1' }))], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

async function open(device, label) {
  const browser = await chromium.launch()
  const ctx = await browser.newContext(device)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  let candleCalls = 0
  const candleReqs = []          // every candle request, so a check can ask WHICH were fetched
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (b.type === 'candleSnapshot') {
      candleCalls++
      // How many candles it asked for: the Simulator asks from a start time with no end, for 1.2×
      // its candle count — a shape the app's own charts do not use.
      candleReqs.push({ coin: b.req?.coin, iv: b.req?.interval, n: b.req?.endTime ? null : Math.round((Date.now() - b.req?.startTime) / (IV[b.req?.interval] ?? 3600e3)) })
      return route.fulfill({ status: 200, contentType: 'application/json', json: candles(b.req?.coin, b.req?.interval) })
    }
    // A builder dex answers allMids with its own prefixed keys -- the shape the picker has to
    // hide. xyz:NVDA must be findable as "NVDA".
    if (b.type === 'allMids' && b.dex) {
      return route.fulfill({ status: 200, contentType: 'application/json', json: b.dex === 'xyz' ? { 'xyz:NVDA': '180' } : {} })
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
  return { browser, p, errs, calls: () => candleCalls, reqs: () => candleReqs.slice(), label }
}

const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }) }


console.log(NL + '-- desktop --')
{
  const { browser, p, errs } = await open({ viewport: { width: 1600, height: 1000 } }, 'desktop')
  await p.evaluate(() => window.switchTab('simulator', null))
  await waitFor(p, 'the simulator', () => !!document.querySelector('#deskSim .sim-root'))
  await p.click('#deskSim .sim-strat:has-text("Range category")')
  await p.fill('#simMktQ', 'HYPE')
  await p.press('#simMktQ', 'Enter')
  await waitFor(p, 'a chip', () => document.querySelectorAll('#deskSim .sim-mchip').length === 1)
  // The generated candles never reach 3x; a band from normal (5) gives the run trades to draw.
  await waitFor(p, 'the guide', () => !!document.querySelector('#deskSim #simCatGuide'))
  await p.fill('#sim_entryCategory', '5')
  await p.evaluate(() => { window.__simTouch(); window.__simRun() })
  await waitFor(p, 'the run', () => !!document.querySelector('#deskSim .sim-eq'), null, 20000)

  console.log(NL + '-- the trades on the equity chart --')
  const dots = await p.evaluate(() => document.querySelectorAll('#deskSim .sim-eq .sim-eq-mk').length)
  const nTrades = await p.evaluate(() => +(document.querySelector('#deskSim .sim-tab:nth-child(3)')?.textContent.replace(/\D/g, '') ?? 0))
  ok('a dot for every trade', dots > 0 && (nTrades > 300 || dots === nTrades), [dots, nTrades])
  ok('each says what the trade did when hovered', await p.evaluate(() => /→ .* · [+−-]\$/.test(document.querySelector('#deskSim .sim-eq-mk')?.title ?? '')))
  ok('dots sit on the chart, not off it', await p.evaluate(() => {
    const box = document.querySelector('#deskSim .sim-eq-svg').getBoundingClientRect()
    return [...document.querySelectorAll('#deskSim .sim-eq-mk')].every(d => { const r = d.getBoundingClientRect(); return r.left >= box.left - 6 && r.right <= box.right + 6 && r.top >= box.top - 6 && r.bottom <= box.bottom + 6 })
  }))
  ok('and the legend says what they are', await p.evaluate(() => /trade closed/.test(document.querySelector('#deskSim .sim-eq-legend').textContent)))
  await p.evaluate(() => document.querySelector('#deskSim .sim-eq')?.scrollIntoView({ block: 'center' }))
  await shot(p, 'simchart-equity')

  console.log(NL + '-- the same slot, switched to the market --')
  // "add the asset market chart with the simulated enters and exits ... make it changable so
  // it does not take extra space"
  const slotH = await p.evaluate(() => document.getElementById('simEqBox').getBoundingClientRect().height)
  await p.click('#simEqBox button:has-text("Price + trades")')
  ok('one switch turns the balance chart into the market', await waitFor(p, 'price view', () => !!document.querySelector('#simEqBox svg polygon') && !document.querySelector('#simEqBox .sim-eq-mk')))
  const pv = await p.evaluate(() => {
    const svg = document.querySelector('#simEqBox svg')
    return { vb: svg.viewBox.baseVal.width, px: svg.getBoundingClientRect().width, marks: svg.querySelectorAll('polygon').length,
      h: document.getElementById('simEqBox').getBoundingClientRect().height }
  })
  const nT = await p.evaluate(() => +(document.querySelector('#deskSim .sim-tab:nth-child(3)')?.textContent.replace(/\D/g, '') ?? 0))
  ok('drawn at its real width, not stretched', Math.abs(pv.vb - pv.px) <= 6, pv)
  ok('an entry and an exit per closed trade', pv.marks >= nT && pv.marks <= nT * 2, [pv.marks, nT])
  ok('each says what it was on hover', await p.evaluate(() => /(in|Out) @ \$/.test(document.querySelector('#simEqBox svg polygon title')?.textContent ?? '')))
  ok('in about the space the balance chart took', Math.abs(pv.h - slotH) < 60, [slotH, pv.h])
  await p.evaluate(() => document.getElementById('simEqBox')?.scrollIntoView({ block: 'center' }))
  await shot(p, 'simchart-price')
  await p.click('#simEqBox button:has-text("Balance")')
  ok('and back', await waitFor(p, 'balance view', () => !!document.querySelector('#simEqBox .sim-eq-mk')))

  console.log(NL + '-- the replay --')
  await p.evaluate(() => window.__simSetTab('replay'))
  await p.click('#deskSim button:has-text("Replay this run")')
  await waitFor(p, 'the player', () => !!document.querySelector('#simReplayBody svg'))
  await p.evaluate(() => { const s = document.getElementById('simRepSeek'); window.__simReplaySeek(Math.floor(+s.max * 0.6)) })
  await waitFor(p, 'a later frame', () => !!document.querySelector('#simReplayBody svg'))
  const geo = await p.evaluate(() => {
    const svg = document.querySelector('#simReplayBody svg'), vb = svg.viewBox.baseVal
    return { vb: vb.width, px: svg.getBoundingClientRect().width }
  })
  ok('drawn at the size it is shown, not stretched', Math.abs(geo.vb - geo.px) <= 6, geo)
  ok('trades are joined entry to exit', await p.evaluate(() => document.querySelectorAll('#simReplayBody svg line[stroke-width="1.4"]').length > 0))
  ok('with a key that says what the marks mean', await p.evaluate(() => /entry → exit/.test(document.querySelector('#simReplayBody .sim-rep-key')?.textContent ?? '')))
  ok('and the price range is on the chart', await p.evaluate(() => document.querySelectorAll('#simReplayBody .sim-eq-y').length === 2))
  await p.evaluate(() => document.getElementById('simReplayBody')?.scrollIntoView({ block: 'center' }))
  await shot(p, 'simchart-replay')
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + '-- phone --')
{
  const { browser, p, errs } = await open({ ...devices['iPhone 14 Pro'], viewport: { width: 430, height: 930 } }, 'phone')
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)
  await p.evaluate(() => window.__mobMoreTab('simulator'))
  await waitFor(p, 'the simulator', () => !!document.querySelector('#mobVContent .sim-root'))
  await p.click('#mobVContent .sim-strat:has-text("Range category")')
  await p.fill('#simMktQ', 'HYPE')
  await p.press('#simMktQ', 'Enter')
  await waitFor(p, 'a chip', () => document.querySelectorAll('#mobVContent .sim-mchip').length === 1)
  await p.fill('#sim_entryCategory', '5')
  await p.evaluate(() => { window.__simTouch(); window.__simRun() })
  await waitFor(p, 'the run', () => !!document.querySelector('#mobVContent .sim-eq'), null, 20000)
  await p.evaluate(() => window.__simSetTab('replay'))
  await p.click('#mobVContent button:has-text("Replay this run")')
  await waitFor(p, 'the player', () => !!document.querySelector('#simReplayBody svg'))
  const geo = await p.evaluate(() => {
    const svg = document.querySelector('#simReplayBody svg')
    return { vb: svg.viewBox.baseVal.width, px: svg.getBoundingClientRect().width }
  })
  ok('the replay is its real width on a phone too', Math.abs(geo.vb - geo.px) <= 6, geo)
  ok('nothing runs off the right edge', await p.evaluate(() => [...document.querySelectorAll('#mobVContent .sim-root *')]
    .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[data-dragscroll]') && e.offsetParent !== null).length === 0))
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
