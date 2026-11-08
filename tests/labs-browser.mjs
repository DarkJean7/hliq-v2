// Labs, in the app, on both shells (src/labsview.js; the engine is tests/suites/labs.test.mjs).
//
// Asked for: "a strategy + simulator all in one ... create on the spot unique strategies and test
// it with historical data ... group signals and make lets say 3 signals into one (but let the user
// also use the same 3 signals to pair them and make another one)". What a unit suite cannot see is
// the screen: that a run lands on the page, that building a group from signals already used in
// another one works by tapping, that an edit re-runs without taking the keyboard away, that the
// strategy is still there after a reload, and that a phone never scrolls sideways.
//
// Hermetic: the setup below is the simulator harness's, so candles are generated, the exchange is
// stubbed and sockets are closed.
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

const wideOf = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' *')]
  .filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('[data-dragscroll]') && e.offsetParent !== null)
  .map(e => e.className?.baseVal ?? e.className ?? e.tagName).slice(0, 5), sel)
// The boot splash is fixed over the whole page for its first seconds after a load; a pointer aimed
// at a chart under it lands on the splash.
const splashGone = (p) => waitFor(p, 'the boot splash to go', () => !document.querySelector('#bootSplash.show'), null, 20000)
const activeStrat = (p) => p.evaluate(() => { const s = JSON.parse(localStorage.getItem('hliq_labs_v1')); return s.list.find(x => x.id === s.active) })

console.log(NL + '-- desktop --')
{
  const { browser, p, errs, calls } = await open({ viewport: { width: 1600, height: 1000 } }, 'desktop')
  await p.evaluate(() => window.switchTab('labs', null))
  ok('it opens', await waitFor(p, 'labs', () => !!document.querySelector('#deskLabs .lab-root')))
  ok('it has a nav tab', await p.evaluate(() => [...document.querySelectorAll('.nav-tab')].some(b => b.textContent.trim() === 'Labs')))
  ok('a first visit starts from a working strategy and runs it', await waitFor(p, 'a result', () => !!document.querySelector('#deskLabs .lab-tiles')))
  const n0 = calls()
  ok('with one candle request', n0 === 1, n0)
  const cols = await p.evaluate(() => {
    const a = document.querySelector('#deskLabs .lab-col-build').getBoundingClientRect(), b = document.querySelector('#deskLabs .lab-col-res').getBoundingClientRect()
    return { side: a.right <= b.left + 1 }
  })
  ok('builder and results side by side', cols.side, cols)
  ok('every signal says how often it was true', await p.evaluate(() => [...document.querySelectorAll('#deskLabs [data-fire]')].every(e => /true \S+% · now [✓✗?]/.test(e.textContent))))
  ok('two charts: account value, and price with trades', await p.evaluate(() => document.querySelectorAll('#deskLabs svg[data-chart]').length === 2))

  console.log(NL + '-- desktop: build from shared signals --')
  const before = await p.evaluate(() => document.querySelectorAll('#deskLabs .lab-gcard').length)
  await p.click('#deskLabs [data-act="addGrp"]')
  await waitFor(p, 'a new group', (n) => document.querySelectorAll('#deskLabs .lab-gcard').length === n + 1, before)
  const g = '#deskLabs .lab-gcard >> nth=-1'
  // The first two signals are already in the template's group; they can go into this one too.
  await p.locator(g).locator('.lab-chip').nth(0).click()
  await p.locator(g).locator('.lab-chip').nth(1).click()
  await p.locator(g).locator('.lab-chip').nth(1).click()
  const f = (await p.locator(g).locator('[data-formula]').textContent()).trim()
  ok('tapping a signal adds it, tapping again negates it', f === 'A AND NOT B', f)
  const st = await activeStrat(p)
  const inTwo = st.groups.filter(x => x.members.some(m => m.ref === st.signals[0].id)).length
  ok('and the same signal now feeds two groups', inTwo === 2, inTwo)
  // Put the new group inside the template's: then the template's cannot go inside the new one.
  await p.locator('#deskLabs .lab-gcard').nth(0).locator('.lab-chip', { hasText: 'Group' }).click()
  ok('a group that would contain itself cannot be picked', await waitFor(p, 'the guard', () => {
    const cards = document.querySelectorAll('#deskLabs .lab-gcard')
    const chip = [...cards[cards.length - 1].querySelectorAll('.lab-chip')].find(c => /Dip in uptrend/.test(c.textContent))
    return chip && chip.disabled
  }, null, 3000))

  await p.click('#deskLabs [data-act="addRule"]')
  ok('a rule can point at a group', await waitFor(p, 'a rule', () => [...document.querySelectorAll('#deskLabs .lab-rule select[data-k="ref"]')].some(s => /◆/.test(s.selectedOptions[0]?.textContent ?? ''))))

  console.log(NL + '-- desktop: edits re-run, and keep the keyboard --')
  const sig0 = await p.textContent('#deskLabs .lab-range')
  const res0 = await p.evaluate(() => document.querySelector('#deskLabs .lab-tiles').textContent)
  await p.fill('#deskLabs [data-risk="stopPct"]', '0.5')
  await p.press('#deskLabs [data-risk="stopPct"]', 'Tab')
  ok('focus moved on to the next field, not lost to a rebuild', await p.evaluate(() => document.activeElement?.getAttribute('data-risk') === 'targetPct'))
  ok('and the run followed the edit', await waitFor(p, 'a re-run', (t) => document.querySelector('#deskLabs .lab-tiles')?.textContent !== t, res0, 5000))
  ok('without fetching again', calls() === n0, calls())
  ok('over the same candles', (await p.textContent('#deskLabs .lab-range')) === sig0)
  const nm = '#deskLabs .lab-card >> nth=0 >> [data-k="name"]'
  await p.fill(nm, 'Deep dip')
  await p.press(nm, 'Tab')
  ok('a renamed signal is renamed in every group and rule', await p.evaluate(() => {
    const els = [...document.querySelectorAll('#deskLabs [data-name-of]')].filter(e => /^A · /.test(e.textContent))
    return els.length >= 2 && els.every(e => /Deep dip/.test(e.textContent))
  }))

  console.log(NL + '-- desktop: kept --')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.evaluate(() => window.switchTab('labs', null))
  await waitFor(p, 'labs', () => !!document.querySelector('#deskLabs .lab-root'))
  ok('the strategy is still there after a reload', await p.evaluate(() =>
    document.querySelectorAll('#deskLabs .lab-gcard').length >= 2 && document.querySelector('#deskLabs .lab-card [data-k="name"]').value === 'Deep dip'))
  await p.selectOption('#deskLabs [data-act-change="newFrom"]', 'breakout')
  ok('a template starts a new strategy', await waitFor(p, 'the template', () => document.querySelector('#deskLabs .lab-sname')?.value === 'Confirmed breakouts'))
  ok('and runs', await waitFor(p, 'its result', () => !!document.querySelector('#deskLabs .lab-tiles')))
  ok('the old one is kept beside it', await p.evaluate(() => document.querySelectorAll('#deskLabs [data-act-change="pick"] option').length === 2))
  // Hover a chart: the crosshair and what happened on that candle.
  await splashGone(p)
  await p.locator('#deskLabs svg[data-chart="px"]').scrollIntoViewIfNeeded()
  const box = await p.locator('#deskLabs svg[data-chart="px"]').boundingBox()
  await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2)
  ok('hovering the price chart says what happened there', await waitFor(p, 'a tooltip', () => { const t = document.querySelector('#deskLabs [data-chart-wrap="px"] [data-tip]'); return t && !t.hidden && /Price/.test(t.textContent) }, null, 3000))
  await shot(p, 'labs-desktop')
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + '-- phone --')
{
  const { browser, p, errs } = await open({ ...devices['iPhone 14 Pro'], viewport: { width: 430, height: 930 } }, 'phone')
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 60000)
  ok('in the More menu', await p.evaluate(() => [...document.querySelectorAll('#mobMoreDrawer button')].some(b => b.textContent.trim() === 'Labs')))
  await p.evaluate(() => window.__mobMoreTab('labs'))
  ok('it opens', await waitFor(p, 'labs', () => !!document.querySelector('#mobVContent .lab-root')))
  ok('and runs', await waitFor(p, 'a result', () => !!document.querySelector('#mobVContent .lab-tiles')))
  const lay = await p.evaluate(() => {
    const a = document.querySelector('#mobVContent .lab-col-res').getBoundingClientRect(), b = document.querySelector('#mobVContent .lab-col-build').getBoundingClientRect()
    return { stacked: b.top >= a.bottom - 1, tiles: getComputedStyle(document.querySelector('#mobVContent .lab-tiles')).gridTemplateColumns.split(' ').length }
  })
  ok('results first, the builder under them', lay.stacked, lay)
  ok('two tiles to a row', lay.tiles === 2, lay)
  const wide = await wideOf(p, '#mobVContent .lab-root')
  ok('nothing runs off the right edge', wide.length === 0, wide)
  await p.selectOption('#mobVContent [data-act-change="addSig"]', '8')
  ok('a ready-made signal is added', await waitFor(p, 'the card', () => [...document.querySelectorAll('#mobVContent .lab-card [data-k="name"]')].some(i => i.value === 'Volume spike')))
  const wide2 = await wideOf(p, '#mobVContent .lab-root')
  ok('and still nothing runs off the edge', wide2.length === 0, wide2)
  await splashGone(p)
  await shot(p, 'labs-phone')
  await p.evaluate(() => window.mobVTab('positions'))
  await p.waitForTimeout(400)
  ok('leaving shows the tab chosen, not Labs', await p.evaluate(() => !document.querySelector('#mobVContent .lab-root')))
  ok('no errors on the page', errs.length === 0, errs)
  await browser.close()
}

console.log(NL + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
