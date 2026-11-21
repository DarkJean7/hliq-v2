// The Outlook tab, in the real app, on both shells. Hermetic: the exchange is stubbed.
//
// "an active tab ... that tracks the user's positions and tries to predict the future movement
// of that asset ... 3 cases chart with neutral, bullish, bearish. include strength/rating", with
// the Range category on 4h candles in the score. It must show a card per position with all three
// cases, the score and its reasons, read the position's own TP and stop, and load the markets one
// at a time rather than fanning a ~120-weight read across every position at once.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN, --shot=DIR for pictures)
import { chromium, devices } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
const SHOT = arg('shot', '')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const ADDR = '0x' + 'b'.repeat(40)
const H4 = 4 * 3600e3, D = 864e5
const BASE = { ETH: 100, BTC: 50000 }

// A market with a shape, ending in two large green 4h candles so the Range factor has
// something to say.
function candles(coin, iv, n) {
  const step = iv === '1h' ? 3600e3 : iv === '4h' ? H4 : iv === '1d' ? D : 7 * D
  const now = Date.now(), out = [], b = BASE[coin] ?? 100
  for (let i = n; i > 0; i--) {
    let c = b * (1 + 0.1 * Math.sin(i / 9))
    let o = c * 0.996, h = c * 1.012, l = c * 0.984
    if (iv === '4h' && i <= 2) { o = c * 0.95; h = c * 1.01; l = c * 0.945 }   // ~6x normal, green
    out.push({ t: now - i * step, T: now - i * step + step - 1, s: coin, i: iv, o: String(o), c: String(c), h: String(h), l: String(l), v: String(1000 * (step / 3600e3)), n: 50 })
  }
  return out
}
const book = (coin) => {
  const m = BASE[coin] ?? 100
  const lv = (from, dir) => Array.from({ length: 20 }, (_, i) => ({ px: String(from + dir * i * m * 0.001), sz: '50', n: 3 }))
  return { coin, time: Date.now(), levels: [lv(m * 0.999, -1), lv(m * 1.001, 1)] }
}
const P = (coin, szi, entry, liq, lev) => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: String(entry), positionValue: String(Math.abs(szi) * BASE[coin]),
  unrealizedPnl: String(szi * (BASE[coin] - entry)), returnOnEquity: '0.1', liquidationPx: String(liq), marginUsed: String(Math.abs(szi) * BASE[coin] / lev),
  maxLeverage: 40, leverage: { type: 'cross', value: lev }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })
const POSITIONS = [P('ETH', 20, 95, 60, 10), P('BTC', -0.05, 51000, 70000, 5)]
const clearing = () => ({ marginSummary: { accountValue: '5000', totalNtlPos: '4500', totalRawUsd: '5000', totalMarginUsed: '700' },
  crossMarginSummary: { accountValue: '5000', totalNtlPos: '4500', totalRawUsd: '5000', totalMarginUsed: '700' },
  crossMaintenanceMarginUsed: '50', withdrawable: '4000', assetPositions: POSITIONS, time: Date.now() })
// The ETH long's own TP and stop, and a plain limit that is NOT protection.
const ORDERS = [
  { coin: 'ETH', side: 'A', limitPx: '0', sz: '20', oid: 1, timestamp: 1, triggerCondition: 'tp', isTrigger: true, triggerPx: '112', orderType: 'Take Profit Market', reduceOnly: true, isPositionTpsl: true, origSz: '20', tif: null, cloid: null },
  { coin: 'ETH', side: 'A', limitPx: '0', sz: '20', oid: 2, timestamp: 1, triggerCondition: 'sl', isTrigger: true, triggerPx: '90', orderType: 'Stop Market', reduceOnly: true, isPositionTpsl: true, origSz: '20', tif: null, cloid: null },
  { coin: 'ETH', side: 'B', limitPx: '80', sz: '1', oid: 3, timestamp: 1, triggerCondition: 'N/A', isTrigger: false, triggerPx: '0', orderType: 'Limit', reduceOnly: false, isPositionTpsl: false, origSz: '1', tif: 'Gtc', cloid: null },
]

const b = await chromium.launch()
async function open(opts) {
  const ctx = await b.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  const asked = []
  let inflight = 0, peak = 0
  await ctx.route(/api\.hyperliquid\.xyz/, async (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    if (q.type === 'candleSnapshot') {
      const iv = q.req.interval
      asked.push(q.req.coin + ':' + iv)
      inflight++; peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 40))
      inflight--
      return route.fulfill({ json: candles(q.req.coin, iv, iv === '4h' ? 600 : iv === '1d' ? 400 : iv === '1w' ? 120 : 800) })
    }
    const meta = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }
    const json = q.type === 'l2Book' ? book(q.coin) : q.type === 'clearinghouseState' ? clearing()
      : q.type === 'allMids' ? { ETH: '100', BTC: '50000' }
      : q.type === 'meta' ? meta
      : q.type === 'metaAndAssetCtxs' ? [meta, [{ markPx: '50000', midPx: '50000', funding: '0.0000125', openInterest: '1', dayNtlVlm: '1', prevDayPx: '50000' }, { markPx: '100', midPx: '100', funding: '0.0002', openInterest: '1', dayNtlVlm: '1', prevDayPx: '100' }]]
      : q.type === 'frontendOpenOrders' ? ORDERS
      : ['portfolio', 'userFills', 'userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'perpDexs', 'perpCategories'].includes(q.type) ? []
      : q.type === 'spotClearinghouseState' ? { balances: [] } : {}
    return route.fulfill({ json })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/markets-meta', (route) => route.fulfill({ json: { revenue: {}, cg: {}, stocks: {}, sic: {} } }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  return { p, asked, ctx, errs, peak: () => peak }
}

async function checks(p, root, label) {
  await p.waitForFunction((r) => document.querySelectorAll(`${r} .ol-card .ol-cases`).length === 2, root, { timeout: 30000 }).catch(() => {})
  const cards = await p.$$eval(`${root} .ol-card`, els => els.map(e => ({
    coin: e.querySelector('.ol-coin')?.textContent, cases: e.querySelectorAll('.ol-case').length,
    score: e.querySelector('.ol-score b')?.textContent ?? null, chart: !!e.querySelector('svg.ol-chart'), text: e.textContent })))
  t(`${label}: a card per position`, cards.length === 2 && cards.map(c => c.coin).sort().join() === 'BTC,ETH', cards.map(c => c.coin))
  t(`${label}: each with bearish, neutral and bullish`, cards.every(c => c.cases === 3 && /Bearish/.test(c.text) && /Neutral/.test(c.text) && /Bullish/.test(c.text)))
  t(`${label}: each with a score and a chart`, cards.every(c => /^[+-]?\d+$/.test(c.score) && c.chart), cards.map(c => c.score))
  const eth = cards.find(c => c.coin === 'ETH')?.text ?? ''
  t(`${label}: the ETH long reads its own TP and stop, not the plain limit`, /Take profit\$112/.test(eth) && /Stop\$90/.test(eth) && /TP before stop/.test(eth), eth.slice(0, 400))
  t(`${label}: and its liquidation`, /Liquidation\$60/.test(eth))
  // Why: the six factors, the Range one on 4h among them.
  await p.click(`${root} .ol-card:has(.ol-coin:text-is("ETH")) [data-ol-why]`)
  const why = await p.$$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-f`, els => els.map(e => e.textContent))
  t(`${label}: why lists the signals, Range (4h) among them`, why.length >= 5 && why.some(x => /Range \(4h\)/.test(x)), why)
  t(`${label}: the Range signal sees the two large green 4h candles`, why.some(x => /2 large 4h candles in 24h \(2 up, 0 down\)/.test(x)), why.find(x => /Range/.test(x)))
  // 24h → 7d widens the cone: the bullish case moves further away.
  const bullAt = () => p.$eval(`${root} .ol-card:has(.ol-coin:text-is("BTC")) .ol-case.bull .ol-case-px span`, e => parseFloat(e.textContent))
  const b24 = await bullAt()
  await p.click(`${root} [data-ol-h="7d"]`)
  await p.waitForFunction((r) => document.querySelector(`${r} [data-ol-h="7d"]`)?.classList.contains('on'), root)
  const b7 = await bullAt()
  t(`${label}: 7d is a wider cone than 24h`, b7 > b24, { b24, b7 })
  await p.click(`${root} [data-ol-h="24h"]`)
}

console.log('-- phone --')
{
  const { p, asked, errs, peak } = await open({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 } })
  await p.waitForFunction(() => document.getElementById('mobVTab-outlook'), null, { timeout: 30000 })
  await p.waitForFunction(() => (window.__state?.perpState ?? true) && document.querySelectorAll('.mob-v-row').length >= 0, null, { timeout: 30000 })
  await p.evaluate(() => window.mobVTab('outlook'))
  await checks(p, '#mobVContent', 'phone')
  t('phone: markets load one at a time, never in parallel', peak() === 1, { peak: peak(), asked })
  t('phone: each market read once', asked.filter(x => x === 'ETH:4h').length === 1 && asked.filter(x => x === 'BTC:4h').length === 1, asked)
  if (SHOT) { await p.evaluate(() => document.querySelector('#mobVContent .ol-view')?.scrollIntoView()); await p.screenshot({ path: `${SHOT}/outlook-phone.png`, fullPage: false }) }
  t('phone: no page errors', errs.length === 0, errs)
  if (errs.length) console.log(errs)
}

console.log('-- desktop --')
{
  const { p, errs } = await open({ viewport: { width: 1500, height: 950 } })
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  await p.evaluate(() => window.switchTab('outlook'))
  await checks(p, '#deskOutlook', 'desktop')
  if (SHOT) await p.screenshot({ path: `${SHOT}/outlook-desktop.png`, fullPage: false })
  t('desktop: no page errors', errs.length === 0, errs)
}

await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
