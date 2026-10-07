// The "Order filled" card, driven for real: an order fills on the exchange while the app is
// open, and a card appears — one for the order, not one per fill — while history loaded at
// boot never does. Rules: tests/suites/fillnotify.test.mjs, src/fillnotify.js.
//
// Hermetic: the exchange is stubbed by host; its sockets closed.
//
// Run:  npm run test:browser        (expects a server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/app'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.FILLNOTIFY_SHOT || ''

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

const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 86400e3, '2000'], [Date.now(), '2000']], pnlHistory: [], vlm: '0' }
const rawFill = (o) => ({ coin: 'BTC', px: '86000', sz: '0.1', side: 'B', time: Date.now(), startPosition: '0', dir: 'Open Long',
  closedPnl: '0', hash: '0x' + '0'.repeat(64), oid: 1, crossed: true, fee: '1.0', tid: 1, feeToken: 'USDC', ...o })

async function run(label, opts) {
  console.log('\n-- ' + label + ' --')
  // An old fill (an hour ago): history. Later fills are pushed in as the test goes.
  const fills = [rawFill({ tid: 100, oid: 50, time: Date.now() - 3600e3, coin: 'ETH', px: '2700', sz: '2' })]
  const HL = {
    clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '86000', ETH: '2700' },
    frontendOpenOrders: [], userFunding: [], userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
    allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
    portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
    webData2: { clearinghouseState: STATE, openOrders: [] },
    meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
    metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  }
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    // Fills by time: only those after startTime, newest first, as Hyperliquid does.
    if (b.type === 'userFillsByTime' || b.type === 'userFills') {
      const from = Number(b.startTime ?? 0)
      return route.fulfill({ status: 200, contentType: 'application/json', json: fills.filter(f => f.time >= from).sort((x, y) => y.time - x.time) })
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
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_privacy', '0')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.waitForTimeout(2500)   // let the boot-time fill loads settle

  ok('history loaded at boot shows no card', await p.locator('#fillToasts .ft-card').count() === 0)

  // An order fills now, in two pieces.
  const t0 = Date.now()
  fills.push(rawFill({ tid: 201, oid: 77, time: t0, sz: '0.1', px: '86000' }), rawFill({ tid: 202, oid: 77, time: t0, sz: '0.15', px: '86100' }))
  await p.evaluate(() => window.__refreshAfterAction(0))
  await waitFor(p, 'the card', () => document.querySelectorAll('#fillToasts .ft-card').length > 0, null, 20000)
  const cards = await p.locator('#fillToasts .ft-card').count()
  ok('an order that fills while the app is open gets a card', cards === 1, cards)
  const txt = (await p.textContent('#fillToasts .ft-card')).replace(/\s+/g, ' ')
  ok('one card for the order: both pieces, side, size and average price', /Bought 0\.25 BTC/.test(txt) && /at \$86,060/.test(txt) && /2 fills/.test(txt), txt)
  ok('the opening direction is named', /Open Long/.test(txt), txt)
  ok('buy is marked as a buy', await p.evaluate(() => document.querySelector('#fillToasts .ft-card').classList.contains('ft-buy')))

  // A close, in profit.
  fills.push(rawFill({ tid: 301, oid: 78, time: Date.now(), side: 'A', dir: 'Close Long', sz: '0.25', px: '87000', closedPnl: '235.00' }))
  await p.evaluate(() => window.__refreshAfterAction(0))
  await waitFor(p, 'the second card', () => document.querySelectorAll('#fillToasts .ft-card').length === 2, null, 20000)
  const second = (await p.locator('#fillToasts .ft-card').nth(1).textContent()).replace(/\s+/g, ' ')
  ok('a closing fill says what it realized', /Sold 0\.25 BTC/.test(second) && /Realized \+\$235\.00/.test(second), second)

  const box = await p.locator('#fillToasts .ft-card').first().boundingBox()
  const vp = p.viewportSize()
  if (opts.isMobile) ok('on a phone it sits at the top, full width', box.y < 120 && box.width > vp.width * 0.85, box)
  else ok('on desktop it sits bottom-right', box.x > vp.width / 2 && box.y + box.height > vp.height * 0.6, box)
  if (SHOT) await p.screenshot({ path: `${SHOT}/fillnotify-${label}.png` })

  await p.click('#fillToasts .ft-card .ft-x >> nth=0')
  await waitFor(p, 'dismiss', () => document.querySelectorAll('#fillToasts .ft-card:not(.ft-out)').length === 1, null, 3000)
  ok('× dismisses it', await p.evaluate(() => document.querySelectorAll('#fillToasts .ft-card:not(.ft-out)').length === 1))

  // Switched off in Settings: the next fill is silent.
  await p.evaluate(() => window.__toggleFillToasts(false))
  const before = await p.evaluate(() => document.querySelectorAll('#fillToasts .ft-card:not(.ft-out)').length)
  fills.push(rawFill({ tid: 401, oid: 79, time: Date.now() }))
  await p.evaluate(() => window.__refreshAfterAction(0))
  await p.waitForTimeout(3000)
  ok('switched off, a new fill shows no card', await p.evaluate(() => document.querySelectorAll('#fillToasts .ft-card:not(.ft-out)').length) <= before)

  if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
  await browser.close()
}

await run('mobile', { ...devices['iPhone 14 Pro'] })
await run('desktop', { viewport: { width: 1440, height: 900 } })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
