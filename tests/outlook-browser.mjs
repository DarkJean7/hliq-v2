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
const BASE = { ETH: 100, BTC: 50000, SOL: 150 }

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
  const asked = [], starts = []
  let inflight = 0, peak = 0, slow = 0
  await ctx.route(/api\.hyperliquid\.xyz/, async (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    if (q.type === 'candleSnapshot') {
      const iv = q.req.interval
      asked.push(q.req.coin + ':' + iv)
      starts.push({ coin: q.req.coin, iv, start: q.req.startTime })
      inflight++; peak = Math.max(peak, inflight)
      await new Promise(r => setTimeout(r, 40 + slow))
      inflight--
      return route.fulfill({ json: candles(q.req.coin, iv, iv === '4h' ? 600 : iv === '1d' ? 400 : iv === '1w' ? 120 : 800) })
    }
    const meta = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'SOL', szDecimals: 2, maxLeverage: 20 }] }
    const json = q.type === 'l2Book' ? book(q.coin) : q.type === 'clearinghouseState' ? clearing(q.user)
      : q.type === 'allMids' ? { ETH: '100', BTC: '50000', SOL: '150' }
      : q.type === 'meta' ? meta
      : q.type === 'metaAndAssetCtxs' ? [meta, [{ markPx: '50000', midPx: '50000', funding: '0.0000125', openInterest: '1', dayNtlVlm: '1', prevDayPx: '50000' }, { markPx: '100', midPx: '100', funding: '0.0002', openInterest: '1', dayNtlVlm: '1', prevDayPx: '100' }, { markPx: '150', midPx: '150', funding: '0.00001', openInterest: '1', dayNtlVlm: '1', prevDayPx: '150' }]]
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
  let recAsked = 0
  await ctx.route('**/outlook-record?**', async (route) => {
    recAsked++
    if (slow) await new Promise(r => setTimeout(r, slow))
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
    ;['hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(k => localStorage.setItem(k, '1'))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  return { p, asked, ctx, errs, peak: () => peak, logged, starts, setSlow: (ms) => { slow = ms }, recAsked: () => recAsked }
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
  t(`${label}: the cone is calibrated, and says by how much`, /So the cone on this card is scaled ×\d\.\d\d to fit, and so are its touch chances/.test(rec.ETH), rec.ETH)
  t(`${label}: every horizon, the one on screen marked`, await p.$$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-hz`, els => els.map(e => e.textContent.trim().split(' ')[0]).join() + '|' + els.filter(e => e.classList.contains('cur')).length) === '4h,24h,3d,7d,30d|1')
  t(`${label}: all the markets pooled, at the top`, /Your 2 markets pooled · past year · 24h/.test(await p.$eval(`${root} .ol-pool`, e => e.textContent).catch(() => '')))
  const whyTxt = await p.$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-why`, e => e.textContent.replace(/\s+/g, ' ')).catch(() => '')
  t(`${label}: why gives each candle signal its own record`, (whyTxt.match(/Past year: (right \d+% of \d+ calls · chance \d+% · avg [+-]\d+\.\d\d% per call|it made no calls)/g) ?? []).length === 3, whyTxt.slice(0, 600))
  t(`${label}: and says the others have no history to check`, /No history here to check this one/.test(whyTxt))
  t(`${label}: and how the weights were learned`, /weighted by how each has called ETH over the past year \(×0\.25 to ×2\)/.test(whyTxt))
  // "something to act as a suggestion": every card leans somewhere, says how sure, and what to consider.
  const sug = await p.$$eval(`${root} .ol-card`, els => els.map(e => {
    const s = e.querySelector('.ol-sug')
    return s && { tag: s.querySelector('.ol-sug-tag')?.textContent, lean: s.querySelector('.ol-sug-lean')?.textContent, conv: s.querySelector('.ol-conv')?.textContent.trim(),
      acts: [...s.querySelectorAll('.ol-act')].map(a => a.textContent), note: s.querySelector('.ol-sug-note')?.textContent }
  }))
  t(`${label}: every card has a suggestion, for the timeframe on screen (24h)`, sug.length === 2 && sug.every(x => x && /Suggestion · next 24h/i.test(x.tag)), sug)
  // "build it": 24h is untested, and the box says so; its conviction is never above Low.
  const unt = await p.$$eval(`${root} .ol-sug`, els => els.map(e => ({ note: e.querySelector('.ol-sug-untested')?.textContent ?? '', conv: e.querySelector('.ol-conv')?.textContent.trim() })))
  t(`${label}: at 24h it says it is untested, and stays Low at most`, unt.every(u => /Untested at 24h: no signal set has beaten chance at this timeframe, so conviction stays Low\. Tested: 4h\./.test(u.note) && /(No edge|Low)$/.test(u.conv)), unt)
  t(`${label}: six timeframes, 1h to 30d`, (await p.$$eval(`${root} [data-ol-h]`, els => els.map(e => e.textContent).join())) === '1h,4h,24h,3d,7d,30d')
  t(`${label}: it names its lean, and how sure`, sug.every(x => /Leans to a (pullback|bounce) \(mean reversion\)|Leans (up|down) \(trend\)|No clear lean/.test(x.lean) && /(No edge|Low|Medium|High)$/.test(x.conv)), sug.map(x => [x.lean, x.conv]))
  t(`${label}: and what to consider for the position`, sug.every(x => x.acts.length >= 1), sug.map(x => x.acts))
  t(`${label}: and that it is not financial advice`, sug.every(x => /not financial advice/.test(x.note)))
  // "do 1": at 4h the score is the set that earned it — the two fades in, momentum out.
  await p.click(`${root} [data-ol-h="4h"]`)
  await p.waitForFunction((r) => document.querySelector(`${r} [data-ol-h="4h"]`)?.classList.contains('on'), root)
  const why4 = await p.$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-why`, e => e.textContent.replace(/\s+/g, ' ')).catch(() => '')
  t(`${label}: at 4h, tested: no untested note`, await p.$$eval(`${root} .ol-sug`, els => els.every(e => !e.querySelector('.ol-sug-untested') && /Suggestion · next 4h/.test(e.textContent))))
  t(`${label}: at 4h, the 3-day fade and the Bollinger stretch are in`, /3-day fade/.test(why4) && /Bollinger stretch/.test(why4) && /in 3 days · leaning against it/.test(why4) && /sd (above|below) its 20-candle average/.test(why4), why4.slice(0, 500))
  t(`${label}: momentum is out, and it says why`, !/Momentum\s*\d+%/.test(why4) && /momentum called it wrong \(43% vs 50%\), so it is left out here/.test(why4))
  t(`${label}: the 4h record replays the 4h set`, /trend, range, 3-day fade and Bollinger stretch only: the signals with history/i.test(await p.$eval(`${root} .ol-card:has(.ol-coin:text-is("ETH")) .ol-rec`, e => e.textContent.replace(/\s+/g, ' '))))
  await p.click(`${root} [data-ol-h="24h"]`)
  await p.waitForFunction((r) => document.querySelector(`${r} [data-ol-h="24h"]`)?.classList.contains('on'), root)
  t(`${label}: what is reported is the coin, horizon, score and volatility, nothing else`, logged.every(x => Object.keys(x).sort().join() === 'coin,hours,score,sigma' && Number.isInteger(x.score) && x.sigma > 0), logged[0])
}

// "make the cards unextended": they start folded, and a tap opens one.
async function unfold(p, root, label, n = 2) {
  await p.waitForFunction(({ r, n }) => document.querySelectorAll(`${r} .ol-card.ol-mini`).length === n, { r: root, n }, { timeout: 30000 }).catch(() => {})
  if (label) {
    const mini = await p.$$eval(`${root} .ol-card.ol-mini`, els => els.map(e => ({ cases: !!e.querySelector('.ol-cases'), lean: e.querySelector('.ol-mini-lean')?.textContent ?? '', row: e.querySelector('.ol-mini-row')?.textContent.replace(/\s+/g, ' ') ?? '' })))
    t(`${label}: the cards start folded`, mini.length === n && mini.every(m => !m.cases), mini)
    t(`${label}: folded, a card still shows the lean, how sure, and the P&L in each case`, mini.every(m => /(Leans|No clear lean)/.test(m.lean) && /(No edge|Low|Medium|High)/.test(m.lean) && /P&L now\s*[−+]\$[\d,.]+\s*Bear\s*[−+]\$[\d,.]+\s*Neutral\s*[−+]\$[\d,.]+\s*Bull\s*[−+]\$[\d,.]+/.test(m.row)), mini)
  }
  // The app's own prompts (install, announcements) can sit over the cards in a fresh browser.
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  // Found and tapped in one step: a price tick can repaint the cards between finding one and
  // tapping it, and a tap on the old copy goes nowhere. The real handler, not a shortcut to it.
  for (let k = 0; k < n + 3; k++) {
    const left = await p.evaluate((r) => { const b = document.querySelector(`${r} .ol-card.ol-mini [data-ol-open]`); b?.click(); return document.querySelectorAll(`${r} .ol-card.ol-mini`).length }, root)
    if (!left) break
  }
}

async function checks(p, root, label) {
  await unfold(p, root, label)
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
  const { p, asked, errs, peak, logged, starts, setSlow, recAsked } = await open({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 } })
  await p.waitForFunction(() => document.getElementById('mobVTab-outlook'), null, { timeout: 30000 })
  await p.waitForFunction(() => (window.__state?.perpState ?? true) && document.querySelectorAll('.mob-v-row').length >= 0, null, { timeout: 30000 })
  // "when i visit the oracle section and exit it redirects me again to oracle": leave while its
  // first market is still loading; when that load lands it must not draw Oracle over Positions.
  // A real connection: loads take a while, so they land after the person has gone.
  // A market only Oracle loads (watched, not held), on a slow connection: it is still loading
  // when the person leaves, as with a dozen markets on a phone.
  // Cards open, so each asks the server for its live record — and that answer arrives late.
  await p.evaluate(() => localStorage.setItem('hliq_oracle_open', '["ETH","BTC"]'))
  await p.evaluate(() => window.mobVTab('outlook'))
  await p.waitForFunction(() => document.querySelectorAll('#mobVContent .ol-card .ol-cases').length === 2, null, { timeout: 30000 }).catch(() => {})
  setSlow(2500)
  const r0 = recAsked()
  await p.evaluate(() => { document.querySelector('#mobVContent [data-ol-h="7d"]')?.click() })   // a new horizon: a new record to ask for
  for (let i = 0; i < 100 && recAsked() === r0; i++) await p.waitForTimeout(30)
  await p.evaluate(() => window.mobVTab('positions'))
  // Watch the whole time, not once at the end: a later repaint of Positions can cover the
  // intrusion before a single look would see it — on a phone it often does not.
  await p.evaluate(() => {
    window.__sawOracle = false
    const el = document.getElementById('mobVContent')
    window.__oracleWatch = new MutationObserver(() => { if (el.querySelector('.ol-view')) window.__sawOracle = true })
    window.__oracleWatch.observe(el, { childList: true, subtree: true })
  })
  await p.waitForTimeout(4000)
  // And deterministically: any redraw Oracle starts while away — a late answer, a load landing —
  // goes through the same paint. Start one (its own delegated click) and it must draw nothing.
  await p.evaluate(() => { const b = document.createElement('button'); b.dataset.olSort = 'az'; document.getElementById('mobVContent').appendChild(b); b.click(); b.remove() })
  await p.waitForTimeout(300)
  setSlow(0)
  await p.evaluate(() => { localStorage.setItem('hliq_oracle_open', '[]'); localStorage.setItem('hliq_outlook_h', '24h') })
  const away = await p.evaluate(() => { window.__oracleWatch.disconnect(); return { sawOracle: window.__sawOracle, tab: document.querySelector('.mob-v-tab.active')?.id } })
  t('phone: leaving Oracle mid-load, it never comes back over the tab moved to', !away.sawOracle && away.tab === 'mobVTab-positions', away)
  await p.evaluate(() => window.mobVTab('outlook'))
  await p.evaluate(() => { document.querySelector('#mobVContent [data-ol-h="24h"]')?.click(); document.querySelector('#mobVContent [data-ol-sort="default"]')?.click(); document.querySelectorAll('#mobVContent .ol-card:not(.ol-mini) .ol-less').forEach(b => b.click()) })
  await checks(p, '#mobVContent', 'phone')
  await v2(p, '#mobVContent', 'phone', logged)
  // "make the cards be able to unextend more easily": an open card folds from its header row,
  // a folded one opens from anywhere on it — but the coin's name still opens its market.
  const isMini = () => p.$eval('#mobVContent .ol-card:has(.ol-coin:text-is("ETH"))', e => e.classList.contains('ol-mini'))
  await p.evaluate(() => [...document.querySelectorAll('#mobVContent .ol-card')].find(c => c.querySelector('.ol-coin')?.textContent === 'ETH')?.querySelector('.ol-net, .ol-side')?.click())
  t('phone: an open card folds from its header row', await isMini())
  await p.evaluate(() => [...document.querySelectorAll('#mobVContent .ol-card')].find(c => c.querySelector('.ol-coin')?.textContent === 'ETH')?.querySelector('.ol-mini-row')?.click())
  t('phone: a folded card opens from anywhere on it', !(await isMini()))
  await p.evaluate(() => { window.__opened = []; window.__realOpen2 = window.__watchOpenTrade; window.__watchOpenTrade = c => window.__opened.push(c) })
  await p.evaluate(() => [...document.querySelectorAll('#mobVContent .ol-card')].find(c => c.querySelector('.ol-coin')?.textContent === 'ETH')?.querySelector('.ol-coin')?.click())
  t('phone: the coin name opens its market and does not fold the card', JSON.stringify(await p.evaluate(() => window.__opened)) === '["ETH"]' && !(await isMini()))
  await p.evaluate(() => { window.__watchOpenTrade = window.__realOpen2 })

  // "let the user add assets that he does not have as positions. make it organized. add sorts."
  const secs = () => p.$$eval('#mobVContent .ol-sec', els => els.map(e => ({ h: e.querySelector('.ol-sec-h')?.textContent.replace(/\s+/g, ' ').trim(), coins: [...e.querySelectorAll('.ol-card .ol-coin')].map(c => c.textContent) })))
  let sx = await secs()
  t('phone: two sections, positions and watching', sx.length === 2 && /^Your positions 2$/.test(sx[0].h) && /^Watching 0$/.test(sx[1].h), sx)
  await p.fill('#mobVContent .ol-add-in', 'so')
  await p.waitForSelector('#mobVContent .ol-add-res [data-ol-add]', { timeout: 5000 }).catch(() => {})
  const res = await p.$$eval('#mobVContent .ol-add-res [data-ol-add]', els => els.map(e => e.dataset.olAdd))
  t('phone: search finds a market not held, and not the ones already there', res.includes('SOL') && !res.includes('ETH') && !res.includes('BTC'), res)
  // A price tick repaints the cards; what is being typed must survive it.
  await p.evaluate(() => window.mobVTab && window._mobVRenderContent?.(true))
  t('phone: what is typed survives a repaint', (await p.$eval('#mobVContent .ol-add-in', e => e.value)) === 'so')
  await p.click('#mobVContent .ol-add-res [data-ol-add="SOL"]')
  await p.waitForFunction(() => [...document.querySelectorAll('#mobVContent .ol-sec')][1]?.querySelector('.ol-card.ol-mini .ol-mini-row'), null, { timeout: 30000 }).catch(() => {})
  sx = await secs()
  t('phone: added, it is under Watching', /^Watching 1$/.test(sx[1].h) && sx[1].coins.join() === 'SOL' && (await p.$eval('#mobVContent .ol-add-in', e => e.value)) === '', sx)
  const solMini = await p.$eval('#mobVContent .ol-watch .ol-mini-row', e => e.textContent.replace(/\s+/g, ' ')).catch(() => '')
  t('phone: folded, a watched market shows its price and the cases\' prices', /Price \$150/.test(solMini) && /Bear \$[\d,.]+ [−+-]\d/.test(solMini), solMini)
  t('phone: and it remembers', JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_oracle_watch')))) === '["SOL"]')
  await p.evaluate(() => document.querySelector('#mobVContent .ol-watch [data-ol-open]')?.click())
  await p.waitForSelector('#mobVContent .ol-watch .ol-sug', { timeout: 5000 }).catch(() => {})
  const sol = await p.$eval('#mobVContent .ol-watch', e => ({ accts: e.querySelectorAll('.ol-acct-row').length, pnl: e.querySelectorAll('.ol-case-pnl').length, acts: [...e.querySelectorAll('.ol-act')].map(a => a.textContent), chart: !!e.querySelector('svg.ol-chart'), cases: e.querySelectorAll('.ol-case').length })).catch(() => null)
  t('phone: open, it has the cone and cases but no position parts', sol && sol.chart && sol.cases === 3 && sol.accts === 0 && sol.pnl === 0, sol)
  t('phone: its suggestion speaks to getting in, not to a position', sol && sol.acts.length === 1 && /^(Not held\. If you want in, the lean favors a (long|short)|No edge in the next)/.test(sol.acts[0]), sol?.acts)
  // Sorts.
  const order = async () => (await secs())[0].coins.join()
  await p.evaluate(() => document.querySelector('#mobVContent [data-ol-sort="az"]')?.click())
  t('phone: A–Z', await order() === 'BTC,ETH')
  const scores = await p.evaluate(() => [...(document.querySelectorAll('#mobVContent .ol-sec')[0]?.querySelectorAll('.ol-card') ?? [])].map(e => [e.querySelector('.ol-coin')?.textContent, parseInt(e.querySelector('.ol-score b')?.textContent ?? 'NaN')]))
  await p.evaluate(() => document.querySelector('#mobVContent [data-ol-sort="bull"]')?.click())
  const bullOrder = [...scores].sort((a, b) => b[1] - a[1]).map(x => x[0]).join()
  // Highest score first; a tie keeps the default order, so check the scores never rise down the list.
  const after = await p.evaluate(() => [...(document.querySelectorAll('#mobVContent .ol-sec')[0]?.querySelectorAll('.ol-card') ?? [])].map(e => parseInt(e.querySelector('.ol-score b')?.textContent ?? 'NaN')))
  t('phone: most bullish first', after.length === 2 && after.every((v, i) => !i || v <= after[i - 1]), { after, scores, bullOrder })
  await p.evaluate(() => document.querySelector('#mobVContent [data-ol-sort="pnl"]')?.click())
  t('phone: P&L, biggest first (ETH +$100 before BTC +$50)', await order() === 'ETH,BTC')
  t('phone: the sort is remembered and shown', (await p.evaluate(() => localStorage.getItem('hliq_oracle_sort'))) === 'pnl' && (await p.$eval('#mobVContent .ol-sorts .on', e => e.dataset.olSort)) === 'pnl')
  t('phone: the sort row can be dragged sideways', await p.$eval('#mobVContent .ol-sorts', e => e.hasAttribute('data-dragscroll')))
  await p.evaluate(() => document.querySelector('#mobVContent [data-ol-sort="default"]')?.click())
  // Remove.
  await p.evaluate(() => document.querySelector('#mobVContent .ol-watch [data-ol-rm="SOL"]')?.click())
  sx = await secs()
  // "each time i open the app or reload and then i open oracle it fetches all the data again":
  // a reload draws the cards from what this device kept, and reads no candles while they are fresh.
  const reopen = async () => {
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => !!window.loadDashboard && !!window.mobVTab, null, { timeout: 60000 })
    await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
    await p.waitForFunction(() => document.getElementById('mobVTab-outlook'), null, { timeout: 30000 })
    await p.evaluate(() => window.mobVTab('outlook'))
  }
  const askedFirst = [...asked]   // "each market read once" is about the first load, before the reloads below
  starts.length = 0
  await reopen()
  const drawn = await p.waitForFunction(() => document.querySelectorAll('#mobVContent .ol-sec .ol-card .ol-score').length === 2, null, { timeout: 15000 }).then(() => true, () => false)
  await p.waitForTimeout(800)   // anything that was going to be fetched has had its chance
  t('phone: after a reload the cards come from this device, at once', drawn)
  t('phone: and no candles are read again while they are fresh', !starts.some(x => x.coin === 'ETH' || x.coin === 'BTC'), starts)
  // Kept twenty minutes ago: stale for Oracle, so it reads again — only from the last kept candle.
  await p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('hliq-candles', 1)
    r.onsuccess = () => {
      const tx = r.result.transaction('analysis', 'readwrite'), st = tx.objectStore('analysis')
      const q = st.openCursor()
      q.onsuccess = () => { const c = q.result; if (!c) return; c.update({ ...c.value, at: Date.now() - 20 * 60e3 }); c.continue() }
      tx.oncomplete = () => res(true)
    }
    r.onerror = () => res(false)
  }))
  starts.length = 0
  await reopen()
  await p.waitForFunction(() => document.querySelectorAll('#mobVContent .ol-sec .ol-card .ol-score').length === 2, null, { timeout: 15000 }).catch(() => {})
  await p.waitForFunction(() => true)
  // Up to a minute: by now this browser has spent a lot of the per-IP budget, and the app's pacer
  // holds a heavy read until the bucket refills — as it should.
  for (let i = 0; i < 240 && !starts.some(x => x.coin === 'BTC' && x.iv === '4h'); i++) await p.waitForTimeout(250)
  const s4 = starts.filter(x => x.iv === '4h')
  t('phone: stale, it reads again — from the last candle kept, not a year back', s4.length >= 1 && s4.every(x => Date.now() - x.start < 2 * 864e5), s4.map(x => ({ coin: x.coin, hoursBack: Math.round((Date.now() - x.start) / 3600e3) })))
  t('phone: ✕ stops watching it', /^Watching 0$/.test(sx[1].h) && (await p.evaluate(() => localStorage.getItem('hliq_oracle_watch'))) === '[]', sx)
  // "in phone it glitches after a while": once everything has loaded, nothing on the tab may be
  // wider than the screen — at the narrowest phone too.
  for (const w of [430, 360]) {
    await p.setViewportSize({ width: w, height: 900 })
    await p.waitForTimeout(150)
    const over = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .ol-view, #mobVContent .ol-card, #mobVContent .ol-sug, #mobVContent .ol-rec, #mobVContent .ol-pool')]
      .map(e => ({ c: e.className, r: Math.round(e.getBoundingClientRect().right) })).filter(x => x.r > innerWidth + 1))
    t(`phone: at ${w}px every card stays inside the screen`, over.length === 0, over.slice(0, 4))
  }
  await p.setViewportSize({ width: 430, height: 930 })
  t('phone: markets load one at a time, never in parallel', peak() === 1, { peak: peak(), asked })
  t('phone: each market read once', askedFirst.filter(x => x === 'ETH:4h').length === 1 && askedFirst.filter(x => x === 'BTC:4h').length === 1, askedFirst)
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
  await unfold(p, '#mobVContent', null)
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
  const groupActs = await p.$$eval('#mobVContent .ol-group .ol-act', els => els.map(e => e.textContent))
  t('combined: the suggestion speaks to each account, by name', ['Main', 'Hedge', 'Swing'].every(n => groupActs.some(a => a.includes(n))), groupActs)
  // "group them so it does not keep repeating the same stuff": the two longs share their lines.
  t('combined: accounts given the same advice share one line', groupActs.some(a => /^Main, Swing \(longs\)/.test(a)), groupActs)
  const kinds = await p.$$eval('#mobVContent .ol-group .ol-act', els => els.map(e => e.className))
  t('combined: no piece of advice is repeated per account', kinds.every(k => kinds.filter(x => x === k).length <= 2), kinds)
  t('combined: no page errors', errs.length === 0, errs)
  if (SHOT) {
    await p.evaluate(() => document.querySelector('#mobVContent .ol-group .ol-accts')?.scrollIntoView({ block: 'center' }))
    await p.screenshot({ path: `${SHOT}/outlook-group.png` })
  }
}

await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
