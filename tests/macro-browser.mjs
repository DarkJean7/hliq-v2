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
const reply = (q) => {
  switch (q.type) {
    case 'clearinghouseState': return { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
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
  fng: { value: 25, label: 'Extreme Fear', date: NOW, d1: 28, d7: 40, d30: null, pts: [[NOW - D, 28], [NOW, 25]] },
  global: { cap: 2.57e12, vol: 6e10, btc: 59.3, eth: 10.7, chg24: -2.5 },
  events: [{ t: NOW + 3600e3, kind: 'cpi' }, { t: NOW + 5 * D, kind: 'fomc', projections: true }, { t: NOW + 6 * D, kind: 'gdp', stage: 'second' }, { t: NOW + 30 * D, kind: 'cpi' }, { t: NOW - 3600e3, kind: 'ppi' }],
  unknownCal: [],
}

const b = await chromium.launch()
let macroMode = 'fail', macroCalls = 0
async function open(viewport, isMobile) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile, timezoneId: 'America/New_York', locale: 'en-US' })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: reply(q) })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/macro-data', (route) => {
    macroCalls++
    return macroMode === 'ok' ? route.fulfill({ status: 200, contentType: 'application/json', json: DATA }) : route.fulfill({ status: 503, contentType: 'application/json', json: { items: null } })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.clear()
    for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_privacy', '0')
  })
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
  t('a look-back with no value is a dash, not 0', /Month ago\s*—/.test(await text(p, '#macroMood')), await text(p, '#macroMood'))
  t('market cap and dominance', /\$2\.57T/.test(await text(p, '#macroGlobal')) && /59\.3%/.test(await text(p, '#macroGlobal')), await text(p, '#macroGlobal'))

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
  const { ctx, p, errs } = await open({ width: 430, height: 930 }, true)
  await p.tap('[data-sig-view="macro"]')
  await p.waitForSelector('#macroFng', { timeout: 20000 })
  const over = await p.$eval('#macroRoot', e => e.scrollWidth - e.clientWidth)
  t('nothing runs off the side', over <= 0, over)
  const wrapped = await p.$$eval('[data-macro-row] .mob-v-row-val', es => es.filter(e => e.scrollWidth > e.clientWidth + 1).length)
  t('every figure fits', wrapped === 0, wrapped)
  if (arg('shot')) await p.screenshot({ path: arg('shot'), fullPage: false })
  await p.tap('[data-macro-row="fed"] .mob-v-row')
  await p.waitForSelector('[data-macro-row="fed"] [data-macro-detail]')
  t('a tap opens a row', true)
  t('no page errors', !errs.length, errs)
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
