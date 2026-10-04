// The front door, driven for real: / shows the landing to a first-time visitor, "Launch app"
// takes them to /app, and from then on / goes straight to the app — until they tap the
// >insolvent logo, which is the one way back. Rules: tests/suites/landing.test.mjs.
//
// Hermetic: the exchange answers {} and the app's server is offline. Nothing here needs data;
// it needs the routes and the redirect.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       LANDING_SHOT=<dir> to save screenshots of the landing and the mobile brand bar.
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const ROOT = 'http://localhost:' + port
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.LANDING_SHOT || ''

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }
const isLanding = p => p.evaluate(() => !!document.querySelector('.ln-hero')).catch(() => false)
const isApp     = p => p.evaluate(() => !!document.getElementById('mobileView')).catch(() => false)

// Just enough account for the mobile shell to come up: it stays hidden until a wallet loads.
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '1000', assetPositions: [], time: Date.now() }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: {},
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], perpDexs: [null], perpCategories: [], portfolio: [],
  webData2: { clearinghouseState: STATE, openOrders: [] }, meta: { universe: [] },
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: [] }, []],
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}
async function loadAccount(p) {
  await p.evaluate(a => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, ADDR)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate(a => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
}

async function newCtx(browser, opts) {
  const ctx = await browser.newContext(opts)
  await blockHlSockets(ctx)
  await ctx.route(HL_HOST, r => {
    let b = {}
    try { b = JSON.parse(r.request().postData() || '{}') } catch {}
    return r.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/offexprice**', r => r.fulfill({ status: 200, json: { prices: {} } }))
  return ctx
}

const browser = await chromium.launch()

for (const [label, opts] of [['mobile', { ...devices['iPhone 14 Pro'] }], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
  console.log('\n-- ' + label + ' --')
  const ctx = await newCtx(browser, opts)
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))

  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' })
  ok('a first visit to / shows the landing', await isLanding(p) && new URL(p.url()).pathname === '/', p.url())
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  ok('no horizontal page scroll', wide <= 0, wide)
  if (SHOT) {
    await p.waitForTimeout(1800)   // let the terminal lines finish their entrance; screenshot only
    await p.screenshot({ path: `${SHOT}/landing-${label}.png`, fullPage: label === 'mobile' ? false : false })
    await p.screenshot({ path: `${SHOT}/landing-${label}-full.png`, fullPage: true })
  }

  await Promise.all([p.waitForURL(u => u.pathname === '/app'), p.locator('.ln-hero [data-launch]').first().click()])
  ok('"Launch app" opens /app', new URL(p.url()).pathname === '/app' && await isApp(p), p.url())
  ok('and remembers it', await p.evaluate(() => localStorage.getItem('hliq_app_entered')) === '1')

  await p.goto(ROOT + '/?coin=BTC', { waitUntil: 'domcontentloaded' })
  await p.waitForURL(u => u.pathname === '/app').catch(() => {})
  const u = new URL(p.url())
  ok('from then on / goes straight to the app', u.pathname === '/app' && await isApp(p), p.url())
  ok('carrying the query along', u.search === '?coin=BTC', u.search)

  // The way back: the logo. Mobile has it in the brand bar, desktop in the sidebar.
  const sel = label === 'mobile' ? '#mobPredictHandle .mob-v-brand' : '.sidebar .brand a.insolvent-logo'
  await loadAccount(p)
  const onScreen = s => { const e = document.querySelector(s); const r = e?.getBoundingClientRect()
    return !!r && r.width > 0 && r.height > 0 && document.elementFromPoint(r.x + 4, r.y + r.height / 2)?.closest('a') === e }
  ok('the >insolvent logo is on screen in the app, and nothing covers it', await waitFor(p, 'the logo', onScreen, sel))
  if (SHOT && label === 'mobile') await p.screenshot({ path: `${SHOT}/app-mobile-brandbar.png`, clip: { x: 0, y: 0, width: 393, height: 220 } })
  // A real tap, so stopPropagation is what decides it: the row it sits in opens Predictions.
  await Promise.all([p.waitForURL(u => u.pathname === '/', { timeout: 10000 }).catch(() => {}), p.locator(sel).click()])
  ok('tapping it shows the landing again (not Predictions)', await isLanding(p), p.url())
  ok('?home is gone from the address bar', p.url() === ROOT + '/', p.url())
  ok('no page errors', errs.length === 0, errs.slice(0, 3))

  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForURL(u => u.pathname === '/app').catch(() => {})
  ok('and a later visit to / opens the app again', new URL(p.url()).pathname === '/app', p.url())
  await ctx.close()
}

// Someone who used the app before the landing existed has hliq_ keys but no hliq_app_entered.
console.log('\n-- existing user --')
{
  const ctx = await newCtx(browser, { ...devices['iPhone 14 Pro'] })
  const p = await ctx.newPage()
  await p.goto(ROOT + '/?home', { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => { localStorage.clear(); localStorage.setItem('hliq_wallets', '[]') })
  await p.goto(ROOT + '/', { waitUntil: 'domcontentloaded' })
  await p.waitForURL(u => u.pathname === '/app').catch(() => {})
  ok('a pre-landing user is never shown the landing', new URL(p.url()).pathname === '/app', p.url())
  await ctx.close()
}

await browser.close()
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
