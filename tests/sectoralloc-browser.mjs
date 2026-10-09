// Allocation → By sector, driven for real: the switch, the ring, the rows and the totals.
// Rules: tests/suites/sectoralloc.test.mjs, src/sectoralloc.js.
//
// Hermetic — every figure is derivable from the fixtures:
//
//   BTC   perp long   $2,000   → Layer 1
//   HYPE  perp short    $500   → Derivatives (DefiLlama's category, /markets-meta stub)
//   HYPE  spot           $150  → Derivatives
//   KNTQ  spot            $20  → Other crypto
//   USDC  spot                 → cash, not exposure
//   ─────────────────────────
//   gross exposure     $2,670   net long $1,670
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = 'http://localhost:' + port + '/app'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.SECTOR_SHOT || ''

let pass = 0, fail = 0
const ok = (n, cond, got = '') => { cond ? pass++ : fail++; console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got))) }
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

const pos = (coin, szi, value, entry) => ({ position: { coin, szi, entryPx: entry, positionValue: value, unrealizedPnl: '0', marginUsed: String(Number(value) / 10),
  leverage: { type: 'cross', value: 10 }, maxLeverage: 40, returnOnEquity: '0', liquidationPx: null, cumFunding: { allTime: '0' } } })
const MARGIN = { accountValue: '1000', totalNtlPos: '2500', totalRawUsd: '1000', totalMarginUsed: '250' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '20', withdrawable: '750',
  assetPositions: [pos('BTC', '0.02', '2000', '100000'), pos('HYPE', '-10', '500', '50')], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'HYPE', szDecimals: 2, maxLeverage: 10 }]
const SPOT = { balances: [
  { coin: 'USDC', token: 0, hold: '0', total: '15' },
  { coin: 'HYPE', token: 150, hold: '0', total: '3', entryNtl: '120' },
  { coin: 'KNTQ', token: 300, hold: '0', total: '100', entryNtl: '0' },
] }
const SPOT_META = {
  tokens: [{ index: 150, name: 'HYPE' }, { index: 0, name: 'USDC' }, { index: 300, name: 'KNTQ' }],
  universe: [{ name: '@107', index: 107, tokens: [150, 0] }, { name: '@334', index: 334, tokens: [300, 0] }],
}
const CTX = { funding: '0', openInterest: '0', prevDayPx: '50', dayNtlVlm: '0', premium: '0', oraclePx: '50', markPx: '50', midPx: '50', impactPxs: ['50', '50'] }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: SPOT,
  allMids: { BTC: '100000', HYPE: '50', '@107': '50', '@334': '0.20' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {}, perpCategories: [], perpDexs: [null],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: SPOT_META,
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX, CTX]], spotMetaAndAssetCtxs: [SPOT_META, []],
}
const META = { revenue: { HYPE: { name: 'Hyperliquid', category: 'Derivatives', r24: 1e6, r7: 7e6, r30: 3e7, f30: 4e7 } }, cg: {}, stocks: {}, sic: {} }

async function run(label, opts) {
  console.log('\n-- ' + label + ' --')
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/offexprice**', r => r.fulfill({ status: 200, json: { prices: {} } }))
  let metaAsks = 0, metaFail = false
  await ctx.route('**/markets-meta', r => { metaAsks++; return metaFail ? r.fulfill({ status: 503, json: { revenue: null } }) : r.fulfill({ status: 200, json: META }) })
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate((a) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'positions', () => (window.__sectorAlloc?.().sectors.length ?? 0) > 0)

  // Open Allocation in this shell.
  const pane = opts.isMobile ? '#mobVContent' : '#deskAlloc'
  if (opts.isMobile) await p.evaluate(() => window.mobVTab('allocation'))
  else await p.evaluate(() => window.switchTab('allocation', null))
  await waitFor(p, 'the wheel', () => !!document.getElementById('allocCenter'))
  ok('the money wheel is still the default', await p.locator(`${pane} [data-alloc-mode="money"]`).count() === 1 && !!(await p.$('#allocCenter')))

  await p.click(`${pane} [data-alloc-mode="sector"]`)
  await waitFor(p, 'the sector view', () => !!document.getElementById('secCenter'))
  await waitFor(p, 'DefiLlama categories', () => (window.__sectorAlloc?.().sectors ?? []).some(s => s.key === 'derivatives') && !!document.querySelector('[data-sec-group="derivatives"]'))
  const d = await p.evaluate(() => window.__sectorAlloc())
  const by = Object.fromEntries(d.sectors.map(s => [s.key, Math.round(s.gross)]))
  ok('Layer 1: the BTC long, $2,000', by.l1 === 2000, by)
  ok('Derivatives: the HYPE short and the HYPE tokens, $650', by.derivatives === 650, by)
  ok('Other crypto: KNTQ, $20 — and USDC is cash, not a sector', by.other === 20 && Object.keys(by).length === 3, by)
  const txt = (await p.textContent(pane)).replace(/\s+/g, ' ')
  ok('the centre is the gross exposure, $2,670.00', /\$2,670\.00/.test(txt), txt.slice(0, 300))
  ok('and how much of it is net long', /Net long \$1,670\.00/.test(txt), txt.slice(0, 300))
  ok('rows show each sector\'s share', /Layer 1/.test(txt) && /74\.9%/.test(txt) && /Derivatives/.test(txt) && /24\.3%/.test(txt), txt)
  ok('the categories were asked of /markets-meta once', metaAsks === 1, metaAsks)

  await p.click(`${pane} [data-sec-row]:has-text("Derivatives")`)
  await waitFor(p, 'the rows', () => /HYPE/.test(document.querySelector('[data-sec-group="derivatives"]')?.innerText ?? ''))
  const g = (await p.textContent(`${pane} [data-sec-group="derivatives"]`)).replace(/\s+/g, ' ')
  ok('a sector opens to its assets, perp and spot, with the side', /Perp/.test(g) && /Short/.test(g) && /Spot/.test(g) && /\$500\.00/.test(g) && /\$150\.00/.test(g), g)

  const box = await p.locator(`${pane} [data-sec-hit]`).first().boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + 4)
  ok('the ring answers on hover', /of exposure/.test(await p.textContent('#secCenter')), await p.textContent('#secCenter'))
  ok('no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0)
  if (SHOT) await p.screenshot({ path: `${SHOT}/sector-${label}.png` })

  ok('the choice is remembered', await p.evaluate(() => localStorage.getItem('hliq_alloc_mode')) === 'sector')
  await p.click(`${pane} [data-alloc-mode="money"]`)
  ok('and switching back shows the money wheel', await waitFor(p, 'the wheel again', () => !!document.getElementById('allocCenter') && !document.getElementById('secCenter'), 5000))

  if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
  await browser.close()
}

await run('mobile', { ...devices['iPhone 14 Pro'] })
await run('desktop', { viewport: { width: 1440, height: 900 } })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
