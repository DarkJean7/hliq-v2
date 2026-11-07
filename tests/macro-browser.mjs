// The Macro view inside Signals. Hermetic: the exchange and /macro-data are both stubbed.
// A report that never loaded must read as unavailable, and a zero must never stand in for it.
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const A1 = '0x' + '1'.repeat(40)
const sum = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '1000'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }
const P = (coin, szi, val) => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: '100', positionValue: String(val), unrealizedPnl: '0', returnOnEquity: '0', liquidationPx: '1', marginUsed: '5', maxLeverage: 10, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })
const POSITIONS = [P('BTC', 1, 1500), P('ETH', -1, 500)]
const reply = (q) => {
  switch (q.type) {
    case 'clearinghouseState': return { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: q.dex ? [] : POSITIONS, time: Date.now() }
    case 'frontendOpenOrders': case 'userFills': case 'userFillsByTime': case 'userFunding': case 'userNonFundingLedgerUpdates': case 'candleSnapshot': case 'perpCategories': case 'perpConciseAnnotations': return []
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return { BTC: '100' }
    case 'portfolio': return ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WIN])
    case 'metaAndAssetCtxs': return [{ universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50 }] }, [{ funding: '0', openInterest: '1', prevDayPx: '100', dayNtlVlm: '1000000', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: [] }]
    case 'perpDexs': return [null]
    default: return {}
  }
}

const NOW = Date.now(), D = 864e5
const pts = [[NOW - 2 * D, 2.9], [NOW - D, 3.1]]
const row = (key, group, fmt, period, date, value, prevDate, prev, next = null, extra = {}) => ({ key, group, fmt, period, next, date, value, prevDate, prev, pts, ...extra })
const DATA = {
  at: NOW,
  items: [
    row('cpi', 'inflation', 'pct1', 'm', '2026-09-01', 3.1, '2026-08-01', 2.9, 'cpi', { mom: 0.3, momDate: '2026-09-01' }),
    row('core', 'inflation', 'pct1', 'm', null, null, null, null, 'cpi', { pts: [] }),      // a series that never loaded
    row('unrate', 'jobs', 'pct1', 'm', '2026-10-01', 4.1, '2026-09-01', 4.1, 'jobs'),
    row('payrolls', 'jobs', 'jobs', 'm', '2026-10-01', -12, '2026-09-01', 45, 'jobs'),
    row('fed', 'rates', 'pct2', 'd', '2025-12-11', 4, '2025-10-30', 4.25, 'fomc', { low: 3.75 }),
    row('vix', 'sentiment', 'num2', 'd', '2026-11-05', 28.18, '2026-11-04', 27, null),
  ],
  // A year of readings at 60, then 20 at 40 and the last at 25: 365 days, so 1y and 30d give different stats.
  fng: { value: 25, label: 'Extreme Fear', date: NOW, d1: 40, d7: 40, d30: null, days: Array.from({ length: 900 }, (_, i) => [20000 + i, i === 899 ? 25 : i >= 880 ? 40 : i === 700 ? 90 : 60]) },
  global: { cap: 2.57e12, vol: 6e10, btc: 59.3, eth: 10.7, chg24: -2.5 },
  events: [{ t: NOW + 3600e3, kind: 'cpi' }, { t: NOW + 5 * D, kind: 'fomc', projections: true }, { t: NOW + 6 * D, kind: 'gdp', stage: 'second' }, { t: NOW + 30 * D, kind: 'cpi' }, { t: NOW - 3600e3, kind: 'ppi' }],
  unknownCal: [],
  nowcast: { asOf: Date.UTC(2026, 10, 6), periods: { '2026-10': { m: { cpi: 0.24, core: 0.21 }, y: { cpi: 3.74, core: 2.48 } } }, miss: { m: { cpi: { n: 12, avg: 0.11, max: 0.36 } } } },
  gdpnow: { date: '2026-10-01', value: 3.44 },
  sep: { year: 2026, rate: 4.1, rateNext: 4.1, core: 3.4, unemp: 4.1, gdp: 2.3 },
  reactions: { cpi: { n: 12, avgAbs: 2.1, up: 7, normal: 1.7, recent: [[20400, 1.25], [20370, -3.1]] } },
}

const b = await chromium.launch()
let macroMode = 'fail', macroCalls = 0
async function open(viewport, isMobile, privacy = '0') {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, timezoneId: 'America/New_York', locale: 'en-US' })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: reply(q) })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route(/s3\.tradingview\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }))
  await ctx.route('**/macro-data', (route) => {
    macroCalls++
    return macroMode === 'ok' ? route.fulfill({ status: 200, contentType: 'application/json', json: DATA }) : route.fulfill({ status: 503, contentType: 'application/json', json: { items: null } })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate((priv) => {
    localStorage.clear()
    for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_privacy', priv)
  }, privacy)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, A1)
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  if (isMobile) await p.evaluate(() => window.__mobMoreTab('analysis'))
  else await p.evaluate(() => window.switchTab('analysis', document.querySelector(`.nav-tab[onclick*="'analysis'"]`)))
  await p.evaluate(() => window.__pulseSetSeg('signals'))
  await p.waitForSelector('[data-sig-view="macro"]', { timeout: 20000 })
  return { ctx, p, errs }
}
const text = (p, sel) => p.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim())

console.log('-- desktop, the server has nothing yet --')
{
  const { ctx, p, errs } = await open({ width: 1500, height: 950 }, false)
  await p.waitForSelector('#sigRoot', { timeout: 30000 })
  t('Signals opens on the market view', true)
  await p.click('[data-sig-view="macro"]')
  await p.waitForFunction(() => /unavailable/i.test(document.getElementById('macroLoading')?.textContent ?? ''), null, { timeout: 15000 })
  t('a failed load says so', true)
  t('and the market view has gone', !(await p.$('#sigRoot')))

  console.log('-- desktop, the data arrives --')
  macroMode = 'ok'
  // Retried on its own, on a timer, with no action from the reader.
  await p.waitForSelector('#macroFng', { timeout: 60000 })
  t('fear and greed', (await text(p, '#macroMood')).includes('25') && /Extreme fear/.test(await text(p, '#macroMood')), await text(p, '#macroMood'))
  t('how long it has been there', /20 days in fear/.test(await text(p, '#macroFngStreak')), await text(p, '#macroFngStreak'))
  t('opens on a year', await p.$eval('[data-fng-range="1y"]', e => /accent/.test(e.getAttribute('style'))))
  const stats = () => text(p, '#macroFngStats')
  t('the window\'s high', /High ?90/.test(await stats()), await stats())
  await p.click('[data-fng-range="30d"]')
  await p.waitForFunction(() => !/High ?90/.test(document.getElementById('macroFngStats')?.textContent.replace(/\s+/g, ' ') ?? ''))
  t('a shorter window drops it', /High ?60/.test(await stats()) && /Low ?25/.test(await stats()), await stats())
  await p.click('[data-fng-range="all"]')
  await p.waitForFunction(() => /90/.test(document.getElementById('macroFngStats')?.textContent ?? ''))
  t('all of it brings it back', /High ?90/.test(await stats()), await stats())
  await p.click('[data-fng-range="1y"]')
  const plot = await (await p.$('#macroFngPlot')).boundingBox()
  await p.mouse.move(plot.x + plot.width * 0.01, plot.y + 50)
  const read = await text(p, '#macroFngRead')
  t('the crosshair reads the day under it', /60/.test(read) && /Greed/.test(read), read)
  await p.mouse.move(5, 5)
  t('and goes back to today', /25/.test(await text(p, '#macroFngRead')), await text(p, '#macroFngRead'))
  t('a look-back with no value is a dash, not 0', /Month ago\s*—/.test(await text(p, '#macroMood')), await text(p, '#macroMood'))
  t('market cap', /\$2\.57T/.test(await text(p, '#macroGlobal')) && /−2\.5% 24h/.test(await text(p, '#macroGlobal')), await text(p, '#macroGlobal'))
  t('the split adds up, with what is left named', /BTC 59\.3%/.test(await text(p, '#macroShare')) && /ETH 10\.7%/.test(await text(p, '#macroShare')) && /Everything else 30\.0%/.test(await text(p, '#macroShare')), await text(p, '#macroShare'))

  console.log('-- TradingView charts --')
  const sym = (c) => p.$eval(`#macroCard_${c} [data-tv-mount]`, e => e.dataset.symbol ?? null)
  const cfg = (c) => p.$eval(`#macroCard_${c} [data-tv-mount] script`, e => JSON.parse(e.textContent))
  await p.$eval('#macroCard_cap', e => e.scrollIntoView())
  await p.waitForFunction(() => document.querySelector('#macroCard_cap [data-tv-mount]')?.dataset.symbol)
  t('the market cap chart mounts when it comes into view', await sym('cap') === 'CRYPTOCAP:TOTAL', await sym('cap'))
  await p.$eval('#macroCard_dom', e => e.scrollIntoView())
  await p.waitForFunction(() => document.querySelector('#macroCard_dom [data-tv-mount]')?.dataset.symbol)
  t('dominance opens on BTC', await sym('dom') === 'CRYPTOCAP:BTC.D', await sym('dom'))
  t('a year of daily history, no volume bars', (await cfg('dom')).range === '12M' && (await cfg('dom')).hide_volume === true)
  const marked = await p.$eval('#macroCard_dom [data-tv-mount] .tradingview-widget-container', e => { e.dataset.same = '1'; return true })
  await p.click('[data-macro-row="unrate"] .mob-v-row')
  await p.waitForSelector('[data-macro-row="unrate"] [data-macro-detail]')
  t('redrawing the page leaves the chart alone', marked && await p.$eval('#macroCard_dom [data-tv-mount] .tradingview-widget-container', e => e.dataset.same === '1'))
  await p.click('[data-macro-row="unrate"] .mob-v-row')
  await p.click('#macroCard_dom [data-tv-sel="alts"]')
  await p.waitForFunction(() => document.querySelector('#macroCard_dom [data-tv-mount]')?.dataset.symbol === '100-CRYPTOCAP:BTC.D')
  t('alts share is the rest of the market', true)
  t('and warns about stablecoins', /Stablecoins count/.test(await text(p, '#macroCard_dom [data-tv-foot]')), await text(p, '#macroCard_dom [data-tv-foot]'))
  await p.click('#macroCard_dom [data-tv-sel="vs"]')
  await p.waitForFunction(() => document.querySelector('#macroCard_dom [data-tv-mount]')?.dataset.symbol === 'CRYPTOCAP:BTC')
  const vs = await cfg('dom')
  t('BTC vs alts compares the two', vs.studies?.[0]?.inputs?.symbol === 'CRYPTOCAP:TOTAL2', vs.studies)
  await p.click('#macroCard_cap [data-tv-sel="alts"]')
  await p.waitForFunction(() => document.querySelector('#macroCard_cap [data-tv-mount]')?.dataset.symbol === 'CRYPTOCAP:TOTAL2')
  t('one card\'s choice leaves the other alone', await sym('dom') === 'CRYPTOCAP:BTC', await sym('dom'))
  await p.click('#macroCard_dom [data-tv-sel="btcd"]')

  const ev = await text(p, '#macroEvents')
  t('the next report first', /CPI inflation report/.test(ev) && ev.indexOf('CPI') < ev.indexOf('Fed rate'), ev)
  t('each report once, the next of it', ev.split('CPI inflation report').length === 2, ev)
  t('it says when', /Today|Tomorrow/.test(ev), ev)
  t('a report already out is not coming up', !/Producer/.test(ev), ev)
  t('projections and estimates are named', /with projections/.test(ev) && /second estimate/.test(ev), ev)

  const cpi = await text(p, '[data-macro-row="cpi"]')
  t('CPI, with the period it covers', /3\.1%/.test(cpi) && /Sep 2026/.test(cpi), cpi)
  t('and the change', /\+0\.2 pt vs Aug 2026/.test(cpi), cpi)
  const core = await text(p, '[data-macro-row="core"]')
  t('a series that never loaded is unavailable, not 0', /Unavailable right now/.test(core) && /—/.test(core) && !/0\.0%/.test(core), core)
  t('jobs lost are signed', /−12K/.test(await text(p, '[data-macro-row="payrolls"]')), await text(p, '[data-macro-row="payrolls"]'))
  t('no change is said plainly', /0\.0 pt vs Sep 2026/.test(await text(p, '[data-macro-row="unrate"]')), await text(p, '[data-macro-row="unrate"]'))
  const fed = await text(p, '[data-macro-row="fed"]')
  t('the Fed as a range, since its last change', /3\.75–4\.00%/.test(fed) && /since Dec 2025/.test(fed) && /last move/.test(fed), fed)
  t('none of it is coloured good or bad', await p.$eval('[data-macro-row="payrolls"] .mob-v-row-val', e => !/green|red/.test(e.getAttribute('style') ?? '')))

  console.log('-- a report opens --')
  const ctl = '[data-macro-event="cpi"]'
  await p.$eval(ctl, e => e.scrollIntoView())
  await p.click(ctl)
  await p.waitForSelector('[data-ev-detail]')
  const evd = await text(p, '[data-ev-detail]')
  t('what it is', /basket of everyday goods/.test(evd), evd)
  t('the estimate beside the last report', /CPI, yearly\s*3\.7%\s*3\.1%/.test(evd) && /CPI, monthly\s*\+0\.24%\s*\+0\.30%/.test(evd), evd)
  t('whose estimate, for which month', /Cleveland Fed nowcast for October 2026/.test(evd), evd)
  t('and how often it has been wrong', /off by 0\.11 pt on average, and by as much as 0\.36 pt/.test(evd), evd)
  t('both ways it can go', /Higher than expected/.test(evd) && /Lower than expected/.test(evd), evd)
  t('what it means day to day', /Everyday money/.test(evd), evd)
  t('what Bitcoin did, beside a normal day', /moved 2\.1% on average/.test(evd) && /1\.7% on a typical day/.test(evd) && /higher on 7 of 12/.test(evd), evd)
  t('your positions, net', /\$1000 net long across 2 positions/.test(evd), evd)
  t('and the rough size of it', /about \$21 either way/.test(evd), evd)
  t('and that it is rough', /A rough scale/.test(evd), evd)
  t('not advice', /not financial advice/.test(evd), evd)
  t('it says it is open', await p.$eval(ctl, e => e.getAttribute('aria-expanded')) === 'true')
  await p.click(ctl)
  t('and closes', !(await p.$('[data-ev-detail]')))
  await p.click('[data-macro-event="fomc"]')
  await p.waitForSelector('[data-ev-detail]')
  const fo = await text(p, '[data-ev-detail]')
  t('the Fed: its own officials\' view', /Target range now\s*3\.75–4\.00%/.test(fo) && /end of 2026\s*4\.1%/.test(fo), fo)
  t('no invented reaction when there is no history', !/How Bitcoin moved/.test(fo), fo)
  await p.click('[data-macro-event="fomc"]')
  await p.click('[data-macro-event="gdp"]')
  await p.waitForSelector('[data-ev-detail]')
  t('GDP: the Atlanta Fed, labelled for its own quarter', /Q4 2026, Atlanta Fed GDPNow\s*3\.4%/.test(await text(p, '[data-ev-detail]')), await text(p, '[data-ev-detail]'))
  await p.click('[data-macro-event="gdp"]')

  console.log('-- a row opens --')
  await p.click('[data-macro-row="cpi"] .mob-v-row')
  await p.waitForSelector('[data-macro-row="cpi"] [data-macro-detail]')
  const d = await text(p, '[data-macro-row="cpi"] [data-macro-detail]')
  t('what it is', /basket/.test(d), d)
  t('month on month', /On the month before \+0\.3%/.test(d), d)
  t('when the next one lands', /Next report/.test(d), d)
  t('its source', /Source: BLS/.test(d), d)
  t('with a chart in its own units', (await text(p, '#rdv-macro_cpi')) === '3.1%', await text(p, '#rdv-macro_cpi'))
  await p.click('[data-macro-row="cpi"] .mob-v-row')
  t('and closes', !(await p.$('[data-macro-row="cpi"] [data-macro-detail]')))

  const calls = macroCalls
  await p.click('[data-sig-view="market"]')
  await p.waitForSelector('#sigRoot')
  t('back to the market', !(await p.$('#macroRoot')))
  await p.click('[data-sig-view="macro"]')
  await p.waitForSelector('#macroFng')
  t('coming back does not fetch again', macroCalls === calls, [calls, macroCalls])
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.__sigSetView, null, { timeout: 60000 })
  t('the choice is remembered', await p.evaluate(() => localStorage.getItem('hliq_sig_view')) === 'macro')
  t('no page errors', !errs.length, errs)
  await ctx.close()
}

console.log('-- phone --')
{
  const { ctx, p, errs } = await open({ width: 430, height: 930 }, true, '1')
  await p.tap('[data-sig-view="macro"]')
  await p.waitForSelector('#macroFng', { timeout: 20000 })
  const over = await p.$eval('#macroRoot', e => e.scrollWidth - e.clientWidth)
  t('nothing runs off the side', over <= 0, over)
  const wrapped = await p.$$eval('[data-macro-row] .mob-v-row-val', es => es.filter(e => e.scrollWidth > e.clientWidth + 1).length)
  t('every figure fits', wrapped === 0, wrapped)
  const chipsOver = await p.$eval('#macroMood', e => e.scrollWidth - e.clientWidth)
  t('the sentiment card fits', chipsOver <= 0, chipsOver)
  if (arg('shot')) await p.screenshot({ path: arg('shot'), fullPage: false })
  await p.tap('[data-macro-row="fed"] .mob-v-row')
  await p.waitForSelector('[data-macro-row="fed"] [data-macro-detail]')
  t('a tap opens a row', true)
  await p.tap('[data-macro-event="cpi"]')
  await p.waitForSelector('[data-ev-detail]')
  t('the report opens on a phone, and fits', await p.$eval('#macroEvents', e => e.scrollWidth - e.clientWidth) <= 0)
  t('in privacy mode, your position sizes stay hidden', !(await p.$('[data-ev-yours]')) && /How Bitcoin moved/.test(await text(p, '[data-ev-detail]')), await text(p, '[data-ev-detail]'))
  if (arg('evshot')) { await p.$eval('[data-ev-detail]', e => e.scrollIntoView()); await p.screenshot({ path: arg('evshot') }) }
  t('no page errors', !errs.length, errs)
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
