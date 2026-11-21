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
// "group same assets cards together": two more accounts hold ETH — one hedged short, one long.
const A2 = '0x' + 'c'.repeat(40), A3 = '0x' + 'd'.repeat(40)
const BY_USER = { [A2]: [P('ETH', -5, 104, 140, 3)], [A3]: [P('ETH', 4, 98, 52, 2)] }
const clearing = (user) => ({ marginSummary: { accountValue: '5000', totalNtlPos: '4500', totalRawUsd: '5000', totalMarginUsed: '700' },
  crossMarginSummary: { accountValue: '5000', totalNtlPos: '4500', totalRawUsd: '5000', totalMarginUsed: '700' },
  crossMaintenanceMarginUsed: '50', withdrawable: '4000', assetPositions: BY_USER[String(user ?? '').toLowerCase()] ?? POSITIONS, time: Date.now() })
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
    const json = q.type === 'l2Book' ? book(q.coin) : q.type === 'clearinghouseState' ? clearing(q.user)
      : q.type === 'allMids' ? { ETH: '100', BTC: '50000' }
      : q.type === 'meta' ? meta
      : q.type === 'metaAndAssetCtxs' ? [meta, [{ markPx: '50000', midPx: '50000', funding: '0.0000125', openInterest: '1', dayNtlVlm: '1', prevDayPx: '50000' }, { markPx: '100', midPx: '100', funding: '0.0002', openInterest: '1', dayNtlVlm: '1', prevDayPx: '100' }]]
      : q.type === 'frontendOpenOrders' ? (BY_USER[String(q.user ?? '').toLowerCase()] ? [] : ORDERS)
      : ['portfolio', 'userFills', 'userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'perpDexs', 'perpCategories'].includes(q.type) ? []
      : q.type === 'spotClearinghouseState' ? { balances: [] } : {}
    return route.fulfill({ json })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/markets-meta', (route) => route.fulfill({ json: { revenue: {}, cg: {}, stocks: {}, sic: {} } }))
  // Version 2's server: what the page reports, and a live record for ETH (BTC has none yet).
  const logged = []
  await ctx.route('**/outlook-log', (route) => { try { logged.push(JSON.parse(route.request().postData())) } catch {} ; return route.fulfill({ status: 204, body: '' }) })
  await ctx.route('**/outlook-record?**', (route) => {
    const u = new URL(route.request().url()), coin = u.searchParams.get('coin'), h = Number(u.searchParams.get('h'))
    const z = { n: 0, hits: 0 }
    const all = { n: 40, hits: 22, up: { n: 20, hits: 12 }, down: { n: 15, hits: 7 }, flat: { n: 5, hits: 3 } }
    const eth = { n: 12, hits: 8, inside: 9, up: { n: 7, hits: 5 }, down: { n: 5, hits: 3 }, flat: z }
    return route.fulfill({ json: { hours: h, coin: coin === 'ETH' ? eth : { n: 0, hits: 0, up: z, down: z, flat: z }, all, pending: 3 } })
  })
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
  return { p, asked, ctx, errs, peak: () => peak, logged }
}

// Version 2: the track record on each card, and what was reported to the server.
async function v2(p, root, label, logged) {
  await p.waitForFunction((r) => [...document.querySelectorAll(`${r} .ol-rec`)].filter(e => /graded|Grading started/.test(e.textContent)).length === 2, root, { timeout: 15000 }).catch(() => {})
  const rec = await p.$$eval(`${root} .ol-card`, els => Object.fromEntries(els.map(e => [e.querySelector('.ol-coin')?.textContent, e.querySelector('.ol-rec')?.textContent.replace(/\s+/g, ' ') ?? ''])))
  t(`${label}: a past-year line with its base rate and verdict`, /candle signals read .* on \d+% of \d+ days — on all days \d+%\. (Better than the base rate|Worse than the base rate|No better than chance|Too few days to tell)/.test(rec.ETH)
    || /Never read like this in the past year/.test(rec.ETH), rec.ETH)
  t(`${label}: the live record for ETH`, /12 graded ETH calls, 67% right · bullish 5\/7 · bearish 3\/5 · all markets 55% of 40 · 3 waiting/.test(rec.ETH), rec.ETH)
  t(`${label}: BTC has none yet, and says grading has started`, /Grading started: every rating is checked 24h after it was shown\. 3 waiting on BTC\. All markets so far: 55% right of 40\./.test(rec.BTC), rec.BTC)
  // Each card reported its rating once for this hour and horizon — the toggles and ticks since
  // must not have sent it again. 7d was opened once, so it reported once too.
  const by = (coin, h) => logged.filter(x => x.coin === coin && x.hours === h)
  t(`${label}: each rating reported once per market and horizon`, by('ETH', 24).length === 1 && by('BTC', 24).length === 1 && by('ETH', 168).length === 1 && by('BTC', 168).length === 1, logged)
  // "do all": the record grows — move size, learned weights, the cone, every horizon, pooled.
  t(`${label}: the size of the move after the reading, and on any day`, /Average move after [+-]\d+\.\d\d% · on all days [+-]\d+\.\d\d%/.test(rec.ETH), rec.ETH)
  t(`${label}: the learned-weights record, against chance, and whether learning helped`, /Weighted by how each signal did on ETH \(now [+-]?\d+\): right \d+% of \d+ days — chance \d+%/.test(rec.ETH) && /Learning (helped|made it worse|made little difference)/.test(rec.ETH), rec.ETH)
  t(`${label}: the cone checked, past and live`, /Ended inside the 1σ band on \d+% of \d+ days \(expect 68%\) · touched the bullish line \d+%, the bearish \d+% \(expect 32% each\)\./.test(rec.ETH) && /Live: inside on 75% of 12 graded/.test(rec.ETH), rec.ETH)
  t(`${label}: every horizon, the one on screen marked`, await p.$$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-hz`, els => els.map(e => e.textContent.trim().split(' ')[0]).join() + '|' + els.filter(e => e.classList.contains('cur')).length) === '4h,24h,3d,7d|1')
  t(`${label}: all the markets pooled, at the top`, /Your 2 markets pooled · past year · 24h/.test(await p.$eval(`${root} .ol-pool`, e => e.textContent).catch(() => '')))
  const whyTxt = await p.$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-why`, e => e.textContent.replace(/\s+/g, ' ')).catch(() => '')
  t(`${label}: why gives each candle signal its own record`, (whyTxt.match(/Past year: (right \d+% of \d+ calls · chance \d+% · avg [+-]\d+\.\d\d% per call|it made no calls)/g) ?? []).length === 3, whyTxt.slice(0, 600))
  t(`${label}: and says the others have no history to check`, /No history here to check this one/.test(whyTxt))
  t(`${label}: and how the weights were learned`, /weighted by how each has called ETH over the past year \(×0\.25 to ×2\)/.test(whyTxt))
  t(`${label}: what is reported is the coin, horizon, score and volatility, nothing else`, logged.every(x => Object.keys(x).sort().join() === 'coin,hours,score,sigma' && Number.isInteger(x.score) && x.sigma > 0), logged[0])
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
  t(`${label}: the ETH long reads its own TP and stop, not the plain limit`, /TP \$112/.test(eth) && /Stop \$90/.test(eth) && /TP before stop/.test(eth), eth.slice(0, 400))
  t(`${label}: and its liquidation`, /Liq \$60/.test(eth))
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
  const { p, asked, errs, peak, logged } = await open({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 } })
  await p.waitForFunction(() => document.getElementById('mobVTab-outlook'), null, { timeout: 30000 })
  await p.waitForFunction(() => (window.__state?.perpState ?? true) && document.querySelectorAll('.mob-v-row').length >= 0, null, { timeout: 30000 })
  await p.evaluate(() => window.mobVTab('outlook'))
  await checks(p, '#mobVContent', 'phone')
  await v2(p, '#mobVContent', 'phone', logged)
  t('phone: markets load one at a time, never in parallel', peak() === 1, { peak: peak(), asked })
  t('phone: each market read once', asked.filter(x => x === 'ETH:4h').length === 1 && asked.filter(x => x === 'BTC:4h').length === 1, asked)
  if (SHOT) { await p.evaluate(() => document.querySelector('#mobVContent .ol-view')?.scrollIntoView()); await p.screenshot({ path: `${SHOT}/outlook-phone.png`, fullPage: false }) }
  t('phone: no page errors', errs.length === 0, errs)
  if (errs.length) console.log(errs)
}

console.log('-- desktop --')
{
  const { p, errs, logged } = await open({ viewport: { width: 1500, height: 950 } })
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  await p.evaluate(() => window.switchTab('outlook'))
  await checks(p, '#deskOutlook', 'desktop')
  await v2(p, '#deskOutlook', 'desktop', logged)
  if (SHOT) { await p.screenshot({ path: `${SHOT}/outlook-desktop.png`, fullPage: false }); await p.evaluate(() => document.querySelector('#deskOutlook .ol-card .ol-rec')?.scrollIntoView({ block: 'start' })); await p.screenshot({ path: `${SHOT}/outlook-record.png`, fullPage: false }) }
  t('desktop: no page errors', errs.length === 0, errs)
}

console.log('-- All Accounts: one card per market --')
{
  const { p, errs } = await open({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 } })
  await p.waitForFunction(() => !!window.mobVTab, null, { timeout: 30000 })
  await p.evaluate(({ a1, a2, a3 }) => {
    const ws = [{ addr: a1, label: 'Main' }, { addr: a2, label: 'Hedge' }, { addr: a3, label: 'Swing' }]
    localStorage.setItem('savedWallets', JSON.stringify(ws))
    localStorage.setItem('hliq_multi_accounts', JSON.stringify(ws))
  }, { a1: ADDR, a2: A2, a3: A3 })
  await p.evaluate(() => window.__goAllAccounts?.())
  await p.waitForFunction(() => (document.getElementById('mobVBalance')?.textContent ?? '').length > 0 && /All Accounts|combined/i.test(document.body.textContent ?? ''), null, { timeout: 40000 })
  await p.evaluate(() => window.mobVTab('outlook'))
  await p.waitForFunction(() => {
    const c = [...document.querySelectorAll('#mobVContent .ol-card')]
    return c.length === 2 && c.every(e => e.querySelector('.ol-cases')) && document.querySelectorAll('#mobVContent .ol-group .ol-acct-row').length === 3
  }, null, { timeout: 40000 }).catch(() => {})
  const cards = await p.$$eval('#mobVContent .ol-card', els => els.map(e => ({
    coin: e.querySelector('.ol-coin')?.textContent, group: e.classList.contains('ol-group'),
    rows: [...e.querySelectorAll('.ol-acct-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
    head: e.querySelector('.ol-card-head')?.textContent.replace(/\s+/g, ' ').trim(),
    agree: e.querySelector('.ol-agree')?.textContent ?? '',
    tiles: [...e.querySelectorAll('.ol-case-pnl')].map(x => x.textContent.trim()),
    cap: e.querySelector('.ol-cases-cap')?.textContent ?? '',
    liqLabels: [...e.querySelectorAll('svg .ol-lbl.liq')].map(x => x.textContent) })))
  const eth = cards.find(c => c.coin === 'ETH'), btc = cards.find(c => c.coin === 'BTC')
  t('combined: one card per market, not one per position', cards.length === 2 && !!eth && !!btc, cards.map(c => c.coin))
  t('combined: the ETH card holds all three accounts', eth?.group && eth.rows.length === 3 && /3 accounts/.test(eth.head), eth?.head)
  t('combined: net size, and it says the group is hedged', /Net long 19 · hedged/.test(eth?.head ?? ''), eth?.head)
  t('combined: each row is named', ['Main', 'Hedge', 'Swing'].every(n => eth?.rows.some(r => r.startsWith(n))), eth?.rows)
  const row = (n) => eth?.rows.find(r => r.startsWith(n)) ?? ''
  t('combined: a row has its side, size, entry and P&L now', /Long 10× 20 ETH @ \$95\.0+ P&L \+\$100\.00/.test(row('Main')) && /Short 3× 5 ETH @ \$104\.0+ P&L \+\$20\.00/.test(row('Hedge')), [row('Main'), row('Hedge')])
  t('combined: its own liquidation', /Liq \$140\.00/.test(row('Hedge')) && /Liq \$52\.000/.test(row('Swing')))
  t('combined: only Main has a TP and stop, and only Main shows them', /TP \$112/.test(row('Main')) && /Stop \$90/.test(row('Main')) && !/TP \$/.test(row('Hedge')) && !/TP \$/.test(row('Swing')))
  t('combined: and what each case does to it', ['Main', 'Hedge', 'Swing'].every(n => /Bearish\s*[−+]\$[\d,.]+\s*Neutral\s*[−+]\$[\d,.]+\s*Bullish\s*[−+]\$[\d,.]+/.test(row(n))), row('Swing'))
  // Each tile is the three rows' figure for that case, added up.
  const money = (x) => { const m = /([−+])\$([\d,.]+)/.exec(x); return m ? (m[1] === '−' ? -1 : 1) * parseFloat(m[2].replace(/,/g, '')) : NaN }
  const sumOf = (word) => ['Main', 'Hedge', 'Swing'].reduce((s, n) => s + money(new RegExp(word + '\\s*([−+]\\$[\\d,.]+)').exec(row(n))?.[1] ?? ''), 0)
  const okTiles = ['Bearish', 'Neutral', 'Bullish'].every((w, i) => Math.abs(money(eth?.tiles[i] ?? '') - sumOf(w)) < 0.02)
  t('combined: the tiles add every account up', /P&L across all 3 accounts/.test(eth?.cap ?? '') && okTiles, { tiles: eth?.tiles, sums: ['Bearish', 'Neutral', 'Bullish'].map(sumOf) })
  // Who the lean is with and against, by name — when it leans at all; a flat read has no line.
  const leanTxt = eth?.agree ?? ''
  const okAgree = !leanTxt ? /Neutral/.test(eth?.head ?? '')
    : /bearish/.test(leanTxt) ? /with Hedge \(short\)/.test(leanTxt) && /against Main \(long\), Swing \(long\)/.test(leanTxt)
    : /with Main \(long\), Swing \(long\)/.test(leanTxt) && /against Hedge \(short\)/.test(leanTxt)
  t('combined: it says who the lean is with and against, by name', okAgree, { leanTxt, head: eth?.head })
  t('combined: each account\'s liquidation is on the chart, named', ['Main', 'Hedge', 'Swing'].every(n => eth?.liqLabels.some(l => l.includes(n))), eth?.liqLabels)
  t('combined: a market one account holds is a single card, with its account named', !btc?.group && /Main/.test(btc?.head ?? '') && btc?.rows.length === 1, btc?.head)
  t('combined: no page errors', errs.length === 0, errs)
  if (SHOT) {
    await p.evaluate(() => document.querySelector('#mobVContent .ol-group .ol-accts')?.scrollIntoView({ block: 'center' }))
    await p.screenshot({ path: `${SHOT}/outlook-group.png` })
  }
}

await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
