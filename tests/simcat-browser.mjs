// Trade Simulator, Range category on screen: the category guide and the exit switches
// (src/simcat.js; the arithmetic is tests/suites/simcat.test.mjs).
//
// Asked for: "lacking the visual of letting the user know what is a category 1 vs 2, vs 3 ...
// also allow to turn off tp/sl individually. make it more visual and flexible." What a unit
// suite cannot see: that the guide fills in with the market's real candles after a run, that
// tapping a candle sets the band, that typing repaints it without taking the keyboard, that a
// switched-off level greys its box, and that none of it pushes a phone sideways.
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

const lit = (p, root) => p.evaluate((r) => [...document.querySelectorAll(r + ' #simCatGuide .simcat-col.on')].map(g => +g.dataset.cat).join(','), root)
const wideOf = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' *')]
  .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[data-dragscroll]') && e.offsetParent !== null)
  .map(e => e.className?.baseVal ?? e.className ?? e.tagName).slice(0, 5), sel)

console.log(NL + '-- desktop --')
{
  const { browser, p, errs } = await open({ viewport: { width: 1600, height: 1000 } }, 'desktop')
  await p.evaluate(() => window.switchTab('simulator', null))
  await waitFor(p, 'the simulator', () => !!document.querySelector('#deskSim .sim-root'))
  await p.click('#deskSim .sim-strat:has-text("Range category")')
  ok('Range shows the category guide', await waitFor(p, 'the guide', () => !!document.querySelector('#deskSim #simCatGuide .simcat-svg')))
  // Nine categories, normal (5) in the middle; the default band 8-9 is the old "3x and up".
  ok('nine candles, 8 and 9 lit by default', (await lit(p, '#deskSim')) === '8,9' && await p.evaluate(() => document.querySelectorAll('#simCatGuide .simcat-col').length === 9), await lit(p, '#deskSim'))
  ok('before any candles it explains instead of showing zeros', await p.evaluate(() => /Run once/.test(document.getElementById('simCatGuide').textContent)))
  ok('and the exits are drawn: 2.0 : 1, even at 33%', await p.evaluate(() => /2\.0 : 1/.test(document.getElementById('simLevels')?.textContent ?? '') && /33%/.test(document.getElementById('simLevels').textContent)))

  await p.fill('#simMktQ', 'HYPE')
  await p.press('#simMktQ', 'Enter')
  await waitFor(p, 'a chip', () => document.querySelectorAll('#deskSim .sim-mchip').length === 1)
  await p.evaluate(() => { window.__simRun() })
  ok('after a run it speaks in the market\'s own dollars', await waitFor(p, 'real sizes', () => /A normal .* candle on HYPE is \$/.test(document.getElementById('simCatGuide')?.textContent ?? ''), null, 20000))
  ok('with how many candles qualified, each way', await p.evaluate(() => /qualified: ▲ \d+ long · ▼ \d+ short/.test(document.getElementById('simCatGuide').textContent)))

  console.log(NL + '-- desktop: tap, type --')
  await p.click('#deskSim #simCatGuide .simcat-col[data-cat="6"]')
  ok('tapping a candle starts the band there', await waitFor(p, 'the band', () => document.getElementById('sim_entryCategory')?.value === '6'))
  ok('and lights 6 and up', (await lit(p, '#deskSim')) === '6,7,8,9', await lit(p, '#deskSim'))
  await p.fill('#sim_entryCategoryMax', '8')
  ok('typing a top repaints the band as you type', await waitFor(p, 'repaint', () => [...document.querySelectorAll('#simCatGuide .simcat-col.on')].map(g => g.dataset.cat).join(',') === '6,7,8', null, 3000))
  ok('without taking the keyboard', await p.evaluate(() => document.activeElement?.id === 'sim_entryCategoryMax'))
  await p.click('#deskSim #simCatGuide .simcat-col[data-cat="1"]')
  ok('the smallest candles can be picked too', await waitFor(p, 'band 1', () => document.getElementById('sim_entryCategory')?.value === '1'))
  await p.selectOption('#sim_rangeMode', 'fade')
  await p.evaluate(() => window.__simTouch())
  ok('fade says green candles open shorts', await waitFor(p, 'fade', () => /faded: green ones open shorts/.test(document.getElementById('simCatGuide').textContent), null, 3000))

  console.log(NL + '-- desktop: exits --')
  await p.click('#sim_useTp')
  ok('switching the target off greys its box', await waitFor(p, 'off', () => document.getElementById('sim_takeProfitPct')?.disabled === true))
  ok('the picture says no target', await p.evaluate(() => /no target/.test(document.getElementById('simLevels').textContent)))
  ok('the stop is still on', await p.evaluate(() => document.getElementById('sim_stopLossPct')?.disabled === false && document.getElementById('sim_useSl').checked))
  await p.click('#sim_useSl')
  ok('both off, nothing else to close a trade: it warns', await waitFor(p, 'warn', () => /only a liquidation or the end of the data/.test(document.getElementById('simLevels')?.textContent ?? '')))
  await p.click('#sim_useTp'); await waitFor(p, 'tp back', () => document.getElementById('sim_takeProfitPct')?.disabled === false)
  await p.click('#sim_useSl'); await waitFor(p, 'sl back', () => document.getElementById('sim_stopLossPct')?.disabled === false)
  ok('switching back on keeps the number', await p.evaluate(() => document.getElementById('sim_takeProfitPct').value === '1'))
  await p.click('#sim_splitLevels')
  ok('shorts can have their own pair', await waitFor(p, 'short boxes', () => !!document.getElementById('sim_shortTpPct') && !!document.getElementById('sim_shortSlPct')))
  await p.fill('#sim_shortTpPct', '0.3'); await p.fill('#sim_shortSlPct', '0.3')
  ok('drawn per side, 1 : 1 needs half', await waitFor(p, 'per side', () => { const t = document.getElementById('simLevels').textContent; return /Longs/.test(t) && /Shorts/.test(t) && /1\.0 : 1/.test(t) && /50%/.test(t) }, null, 3000))

  // The generated candles are smooth and never reach 3x; start the band at normal (5) so the run has trades to show.
  await p.click('#deskSim #simCatGuide .simcat-col[data-cat="5"]')
  await waitFor(p, 'band 5', () => document.getElementById('sim_entryCategory')?.value === '5')
  await p.fill('#sim_entryCategoryMax', '9')
  await p.evaluate(() => { window.__simRun() })
  await waitFor(p, 'the run', () => /long TP 1% \/ SL 0\.5% · short TP 0\.3% \/ SL 0\.3%/.test(document.querySelector('#deskSim .sim-results')?.textContent ?? ''), null, 20000)
  ok('the result states both pairs', await p.evaluate(() => /short TP 0\.3% \/ SL 0\.3%/.test(document.querySelector('#deskSim .sim-results').textContent)))
  await p.evaluate(() => window.__simSetTab('trades'))
  ok('each trade says the candle that opened it and how it closed', await waitFor(p, 'trade rows', () => {
    const rows = [...document.querySelectorAll('#deskSim .sim-trade')]
    return rows.length > 0 && rows.every(r => /cat [5-9] \(\d+\.\d×\)/.test(r.textContent)) && rows.some(r => /· (target|stop|trail)/.test(r.textContent))
  }, null, 5000))
  await p.evaluate(() => window.__simSetTab('overview'))
  console.log(NL + '-- desktop: how many of each --')
  ok('a count under every candle', await p.evaluate(() => document.querySelectorAll('#simCatGuide .simcat-c').length === 9))
  ok('a row per category, totals adding up', await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#simCatGuide [data-tbl="counts"] tbody tr')]
    const sum = rows.reduce((a, r) => a + +r.children[4].textContent.replace(/,/g, ''), 0)
    return rows.length === 9 && sum === +document.querySelector('#simCatGuide [data-tbl="counts"] tfoot td.n').textContent.replace(/,/g, '')
  }))
  ok('after the run: trades, won, lost, win rate and PnL per category', await p.evaluate(() => {
    const th = [...document.querySelectorAll('#simCatGuide [data-tbl="trades"] th')].map(x => x.textContent.trim())
    const n = +document.querySelector('#simCatGuide [data-tbl="trades"] tfoot td.n')?.textContent
    return th.join() === 'Cat,Trades,Won,Lost,Win rate,PnL' && n === +document.querySelector('#deskSim .sim-tab:nth-child(3)')?.textContent.replace(/\D/g, '')
  }))
  ok('both tables fit the settings column: nothing hidden off to the side', await p.evaluate(() =>
    [...document.querySelectorAll('#simCatGuide .simcat-tbl')].every(t => t.scrollWidth <= t.clientWidth + 1)))
  await p.click('#simCatGuide [data-tbl="counts"] tbody tr:nth-child(4)')
  ok('a row can be tapped to start the band there', await waitFor(p, 'band 4', () => document.getElementById('sim_entryCategory')?.value === '4'))

  console.log(NL + '-- desktop: average or median --')
  const sizeOf = () => p.evaluate(() => (document.getElementById('simCatGuide').textContent.match(/candle on HYPE is \$([\d.,]+)/) ?? [])[1])
  const meanNormal = await sizeOf()
  ok('with the average it explains why most candles are under 1x', await p.evaluate(() => /pull the average up/.test(document.getElementById('simCatGuide').textContent)))
  await p.selectOption('#sim_baselineKind', 'median')
  await p.evaluate(() => window.__simTouch())
  ok('switching normal to the median redraws it as a median', await waitFor(p, 'median', () => /the median of/.test(document.getElementById('simCatGuide')?.textContent ?? '') && /median/.test(document.querySelector('#simCatGuide .simcat-n')?.textContent), null, 3000))
  ok('and normal is a different size', (await sizeOf()) !== meanNormal, [meanNormal, await sizeOf()])
  await p.evaluate(() => document.querySelector('#simCatGuide .simcat-sub')?.scrollIntoView({ block: 'start' }))
  await shot(p, 'simcat-desktop')
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
  ok('the guide is there', await waitFor(p, 'the guide', () => !!document.querySelector('#mobVContent #simCatGuide .simcat-svg')))
  const w = await p.evaluate(() => document.querySelector('#mobVContent .simcat-svg').getBoundingClientRect().width)
  ok('and fills the card rather than shrinking to a stamp', w > 300, w)
  await p.click('#sim_splitLevels')
  await waitFor(p, 'short boxes', () => !!document.getElementById('sim_shortTpPct'))
  ok('the table scrolls inside itself on a phone', await p.evaluate(() => { const t = document.querySelector('#mobVContent .simcat-tbl'); return !t || t.hasAttribute('data-dragscroll') }))
  const wide = await wideOf(p, '#mobVContent .sim-root')
  ok('nothing runs off the right edge', wide.length === 0, wide)
  await p.evaluate(() => document.getElementById('simLevels')?.scrollIntoView({ block: 'center' }))
  await shot(p, 'simcat-phone')
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
