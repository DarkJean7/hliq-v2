// /portfolios backtests (src/pfbacktest.js): every figure below is worked out by hand.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b))

const B = await import('../../src/pfbacktest.js')
const D = B.DAY
const T0 = Date.UTC(2026, 0, 1)            // a Thursday
const series = (prices, t0 = T0) => prices.map((p, i) => [t0 + i * D, p])
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1))

console.log(nl + '-- weights and the daily grid --')
{
  const w = B.normalizeWeights([{ key: 'A', weight: 30 }, { key: 'B', weight: 10, side: 'short' }, { key: 'C', weight: 0 }])
  t('weights are signed and their absolute values add to 1', near(w.A, 0.75) && near(w.B, -0.25) && !('C' in w), w)
  const g = B.alignDaily({ A: [[T0, 10], [T0 + 2 * D, 12]], B: [[T0 + D, 5]] }, T0, T0 + 3 * D)
  t('a day with no candle carries the last close', JSON.stringify(g.px.A) === JSON.stringify([10, 10, 12, 12]), g.px.A)
  t('before its first candle an asset has no price, not zero', g.px.B[0] === null && g.px.B[1] === 5 && g.first.B === T0 + D)
  t('the basket starts when its last holding is listed', B.commonStart(g.px, ['A', 'B']) === 1)
}

const opts0 = { capital: 1000, feeBps: 0, trendDays: 5 }
console.log(nl + '-- strategies --')
{
  const c = { A: series(lin(100, 200, 61)), B: series(Array(61).fill(50)) }
  const items = [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }]
  const r = B.backtest({ candles: c, items, from: T0, to: T0 + 60 * D, strategies: ['hold', 'monthly', 'weekly', 'band', 'dca'], opts: opts0 })
  const by = Object.fromEntries(r.runs.map(x => [x.id, x]))
  t('buy & hold: half doubled, half flat = 1.5×', near(by.hold.final, 1500), by.hold.final)
  t('buy & hold trades once', by.hold.rebalances === 1)
  t('rebalancing sells the winner, so it ends below hold in a one-way market', by.monthly.final < by.hold.final && by.weekly.final < by.hold.final && by.weekly.rebalances > by.monthly.rebalances)
  t('the drift band trades less than every week', by.band.rebalances < by.weekly.rebalances && by.band.rebalances >= 2, [by.band.rebalances, by.weekly.rebalances])
  t('DCA buys later and higher: less than hold, more than the capital', by.dca.final < by.hold.final && by.dca.final > 1000)
  t('the curve starts at the capital, one point per day', near(by.hold.equity[0], 1000) && by.hold.equity.length === 61)
  const f = B.backtest({ candles: c, items, from: T0, to: T0 + 60 * D, strategies: ['hold'], opts: { ...opts0, feeBps: 10 } }).runs[0]
  t('a fee is the bps of what was traded: 10 bps of $1,000, paid from cash', near(f.fees, 1) && near(f.final, 1500 - 1), [f.fees, f.final])
  t('contribution by asset adds up to the result', near(Object.values(by.hold.pnlBy).reduce((a, v) => a + v, 0), by.hold.final - 1000))
}
{
  const c = { A: series(lin(100, 50, 31)) }
  const short = B.backtest({ candles: c, items: [{ key: 'A', weight: 1, side: 'short' }], from: T0, to: T0 + 30 * D, strategies: ['hold'], opts: opts0 }).runs[0]
  t('a short gains what the price lost: 100% short, price halves = +50%', near(short.final, 1500), short.final)
  const lev = B.backtest({ candles: { A: series([100, 90, 60, 60]) }, items: [{ key: 'A', weight: 1 }], from: T0, to: T0 + 3 * D, strategies: ['hold'], opts: { ...opts0, leverage: 3 } }).runs[0]
  t('3× long through a 40% drop is liquidated, and stays at zero', lev.liquidated === T0 + 2 * D && lev.equity[2] === 0 && lev.equity[3] === 0, lev.equity)
  t('3× long through a 10% drop is down 30%', near(lev.equity[1], 700))
}
{
  // Up, then a fall well below its 5-day average: the trend filter steps aside into cash.
  const px = [...lin(100, 120, 20), ...lin(118, 60, 20)]
  const r = B.backtest({ candles: { A: series(px) }, items: [{ key: 'A', weight: 1 }], from: T0 + 5 * D, to: T0 + 39 * D, strategies: ['hold', 'trend'], opts: opts0 })
  const [hold, trend] = r.runs
  t('trend filter: out of the fall, so it loses less than holding', trend.final > hold.final, [trend.final, hold.final])
  t('and while out it is flat cash', near(trend.equity[trend.equity.length - 1], trend.equity[trend.equity.length - 2]))
}
{
  const c = { A: series(lin(100, 110, 40)), B: series(lin(10, 11, 30), T0 + 10 * D) }
  const items2 = [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }]
  // 'wait': the old rule, still selectable — start when every holding trades.
  const r = B.backtest({ candles: c, items: items2, from: T0, to: T0 + 39 * D, strategies: ['hold'], opts: { ...opts0, listing: 'wait' }, bench: 'A' })
  t('listing "wait": the window starts when the last holding lists, and says which', r.start === T0 + 10 * D && r.clippedBy === 'B' && r.joined.length === 0)
  t('the benchmark runs over the same days', r.bench && r.bench.equity.length === r.days.length)
  // 'join', the default: the full window; B comes in the day it lists.
  const j = B.backtest({ candles: c, items: items2, from: T0, to: T0 + 39 * D, strategies: ['hold', 'monthly', 'trend', 'dca'], opts: opts0 })
  t('by default the full window is tested: a later listing does not cut it short', j.start === T0 && j.days.length === 40 && j.clippedBy === null)
  t('and the late holding is named, with its listing day', j.joined.length === 1 && j.joined[0].key === 'B' && j.joined[0].t === T0 + 10 * D)
  // By hand: 10 days all in A (100 → A(10)), then half each from day 10 to day 39.
  const A = lin(100, 110, 40), Bp = lin(10, 11, 30)
  const e10 = 1000 * A[10] / A[0]
  const want2 = e10 / 2 * (A[39] / A[10]) + e10 / 2 * (Bp[29] / Bp[0])
  const hold = j.runs.find(x => x.id === 'hold')
  t('buy & hold: all in A until B lists, then half each — worked out by hand', near(hold.final, want2), [hold.final, want2])
  t('which is one extra trade on the listing day', hold.rebalances === 2 && Object.keys(hold.pnlBy).length === 2)
  t('every strategy runs the full window', j.runs.every(x => x.equity.length === 40 && x.equity.every(Number.isFinite)))
  // A window that starts before ANY holding traded still starts at the first one to.
  const k = B.backtest({ candles: { B: c.B, A: series(lin(5, 6, 20), T0 + 20 * D) }, items: items2, from: T0, to: T0 + 39 * D, strategies: ['hold'], opts: opts0 })
  t('before any holding traded, it starts at the first listing, and says which', k.start === T0 + 10 * D && k.clippedBy === 'B' && k.joined[0]?.key === 'A')
  t('a holding with no candles stops the run and is named', B.backtest({ candles: { A: series([1, 2]) }, items: [{ key: 'A', weight: 1 }, { key: 'Z', weight: 1 }], from: T0, to: T0 + D, strategies: ['hold'] }).missing[0] === 'Z')
}

console.log(nl + '-- metrics --')
{
  const m = B.metrics([100, 120, 90, 110, 130], 100)
  t('max drawdown from the peak: 120 → 90 is -25%', near(m.maxDd, -0.25))
  t('return over the capital', near(m.ret, 0.3))
  t('no annualised figure for under a year', m.cagr === null)
  const yr = B.metrics(Array.from({ length: 366 }, (_, i) => 100 * 1.2 ** (i / 365)), 100)
  t('a year at +20% annualises to 20%', near(yr.cagr, 0.2, 1e-6), yr.cagr)
}

console.log(nl + '-- the Simulator\'s strategies on every holding --')
{
  t('a step curve is read at each day\'s close', JSON.stringify(B.stepOnDays([[T0 + D + 5, 7], [T0 + 3 * D, 9]], [T0, T0 + D, T0 + 2 * D, T0 + 3 * D], 5)) === JSON.stringify([5, 7, 7, 9]))
  const ohlc = { A: lin(100, 140, 120).map((c, i) => ({ t: T0 + i * D / 4, o: c * 0.99, h: c * 1.03, l: c * 0.97, c })), B: lin(50, 40, 120).map((c, i) => ({ t: T0 + i * D / 4, o: c * 1.01, h: c * 1.03, l: c * 0.97, c })) }
  const days = Array.from({ length: 30 }, (_, i) => T0 + i * D)
  for (const [id] of B.BOT_STRATEGIES) {
    const r = B.botRun(ohlc, [{ key: 'A', weight: 60 }, { key: 'B', weight: 40 }], days, id, { capital: 1000 })
    if (!(r.equity.length === 30 && near(r.equity[0], 1000, 0.05) && r.equity.every(v => Number.isFinite(v) && v >= 0))) { t(id + ': one funded sub-account per holding, summed', false, r.equity.slice(0, 3)); continue }
  }
  t('every Simulator strategy runs on a basket: one funded sub-account per holding, summed', true)
  const SRC = fs.readFileSync('src/pfbacktest.js', 'utf8')
  t('it is the Simulator\'s own engine, not a copy', SRC.includes("import { runBacktest, strategyKind } from './backtest.js'"))
  t('each holding trades only its own direction unless asked', SRC.includes('useDirection: !both, direction: side'))
}

console.log(nl + '-- names: what Hyperliquid shows, not only the ticker --')
{
  const N = await import('../../src/coinnames.js')
  const M = await import('../../src/marketsdata.js')
  t('xyz:CL is WTIOIL, OAI is OPENAI', N.displayName('xyz:CL') === 'WTIOIL' && N.displayName('OAI') === 'OPENAI' && N.displayName('BTC') === 'BTC')
  const rows = M.perpRows({ universe: [{ name: 'xyz:CL', maxLeverage: 20 }] }, [{ markPx: '70', prevDayPx: '69', dayNtlVlm: '1000', openInterest: '10', funding: '0' }], 'xyz')
  t('a market row carries the shown name and keeps its ticker', rows[0].label === 'WTIOIL' && rows[0].sym === 'CL')
  t('/markets search finds it by the shown name', M.filterRows(rows, { q: 'wtioil' }).length === 1 && M.filterRows(rows, { q: 'oil' }).length === 1)
  const P = fs.readFileSync('src/portfolio.js', 'utf8'), MAIN = fs.readFileSync('src/main.js', 'utf8')
  t('/portfolios searches the shown name anywhere in it', P.includes("const names = (r) => [r.sym, r.label ?? '', r.name ?? '', ...(r.keywords ?? [])]") &&P.includes('names(r).some(x => x.includes(q))'))
  t('the app reads the same list', MAIN.includes('const _MKT_DISPLAY = DISPLAY_NAMES'))
  // Hyperliquid's own names: perpConciseAnnotations, with perpCategories accepted as before.
  const A = M.readAnnotations([['xyz:HO', { category: 'commodities', displayName: 'DIESEL', keywords: ['ho', 'ulsd'] }], ['xyz:SMSN', { category: 'stocks', displayName: 'SAMSUNG' }], ['xyz:NVDA', 'stocks']])
  t('annotations give categories, names and keywords; the old shape still reads', A.cat.length === 3 && A.names.get('xyz:HO').label === 'DIESEL' && A.names.get('xyz:SMSN').label === 'SAMSUNG' && !A.names.has('xyz:NVDA'))
  const rows2 = M.buildMarkets({ hip3: [{ dex: 'xyz', label: 'XYZ', data: [{ universe: [{ name: 'xyz:HO', maxLeverage: 10 }] }, [{ markPx: '4.7', prevDayPx: '4.6', dayNtlVlm: '100000', openInterest: '50000', funding: '0' }]] }],
    cats: [['xyz:HO', { category: 'commodities', displayName: 'DIESEL', keywords: ['ho', 'ulsd'] }]] })
  t('xyz:HO is DIESEL, found by "diesel" and by its keyword "ulsd"', rows2[0].label === 'DIESEL' && M.filterRows(rows2, { q: 'diesel' }).length === 1 && M.filterRows(rows2, { q: 'ulsd' }).length === 1)
  t('and is energy, not just "commodities"', rows2[0].tags.includes('energy'), rows2[0].tags)
  t('both public pages ask for the annotations, falling back to perpCategories', ['src/markets.js', 'src/portfolio.js'].every(f => { const x = fs.readFileSync(f, 'utf8'); return x.includes("type: 'perpConciseAnnotations'") && x.includes("post({ type: 'perpCategories' })") }))
  t('sector rows scroll with the wheel and a drag on both pages', fs.readFileSync('src/markets.js', 'utf8').includes("from './sidescroll.js'") && P.includes("sideScroll($('pfSectors'), '.pf-sec-row')"))
  t('a description is saved, shared and shown on its card', P.includes("desc: (S.desc ?? '').trim()") && P.includes('d: S.desc || undefined') && P.includes('pf-gc-desc'))
}

console.log(nl + '-- featured portfolios: public to read, the developer\'s to change --')
{
  const F = await import('../../src/pfshared.js')
  const ok1 = F.cleanPortfolio({ name: '  Asia  ', desc: 'x'.repeat(400), items: [{ coin: 'xyz:SMSN', w: 14, side: 'long', kind: 'hip3' }, { coin: 'xyz:SMSN', w: 3 }, { coin: '<script>', w: 5 }, { coin: 'BTC', w: 0 }, { coin: 'ETH', w: 2, side: 'short' }] })
  t('a stored portfolio is cleaned: name trimmed, description capped, bad and duplicate holdings dropped', ok1.name === 'Asia' && ok1.desc.length === 280 && ok1.items.map(i => i.coin).join() === 'xyz:SMSN,ETH' && ok1.items[1].side === 'short', ok1)
  t('no name or no weighted holding is not a portfolio', F.cleanPortfolio({ name: '', items: [{ coin: 'BTC', w: 1 }] }) === null && F.cleanPortfolio({ name: 'A', items: [] }) === null)
  t('an id only survives when it is one of ours', F.cleanPortfolio({ id: '../../etc', name: 'A', items: [{ coin: 'BTC', w: 1 }] }).id === null)
  const l1 = F.upsertFeatured([], F.cleanPortfolio({ name: 'A', items: [{ coin: 'BTC', w: 1 }] }), 100)
  const l2 = F.upsertFeatured(l1, { ...F.cleanPortfolio({ name: 'A2', items: [{ coin: 'ETH', w: 1 }] }), id: l1[0].id }, 200)
  t('new ones get an id; an update replaces in place and keeps when it was first published', l1.length === 1 && /^[a-z0-9]{6,}$/.test(l1[0].id) && l2.length === 1 && l2[0].name === 'A2' && l2[0].at === 100 && l2[0].updated === 200)
  t('the list has a ceiling', F.upsertFeatured(Array.from({ length: F.PF_FEATURED_MAX }, (_, i) => ({ id: 'id' + String(i).padStart(6, '0') })), F.cleanPortfolio({ name: 'A', items: [{ coin: 'BTC', w: 1 }] })) === null)
  const SRV = fs.readFileSync('serve-prod.js', 'utf8')
  const route = SRV.slice(SRV.indexOf("if (url === '/portfolios-data' ||"), SRV.indexOf("if (url === '/markets-meta')"))
  // The read now carries the precomputed cards as well (perf, asOf — src/pfgallery.js); what
  // this is pinning is that it is still a GET anyone may make and that the PIN is still
  // checked before a write reads its body, both of which are unchanged.
  t('the server: anyone reads; every write first asks the strategy server whether the PIN is right', /return send\(200, \{ portfolios: pfRead\(\)(, perf, asOf(, src: [^}]+)?)? \}\)/.test(route) && route.indexOf('await devPinOk(') < route.indexOf('await readJson(') && route.includes("if (!ok) return send(403"))
  t('an unreachable PIN check is "try later", never a yes', route.includes("if (ok === null) return send(503") && SRV.includes("res.statusCode === 200 ? true : res.statusCode === 403 ? false : null"))
  t('what is stored has been through cleanPortfolio', route.includes('cleanPortfolio(b.portfolio)'))
  const P = fs.readFileSync('src/portfolio.js', 'utf8')
  t('the page: a visitor saving a featured portfolio keeps a copy on this device', /if \(S\.featuredId && isDev\(\)\)[\s\S]{0,300}featuredWrite\('save'[\s\S]{0,400}localSave\(\)/.test(P))
  t('dev mode is the app\'s own (hliq_dev + hliq_lb_pin), checked by the server before it is kept', P.includes("localStorage.getItem('hliq_dev') === '1' && !!devPin()") && P.includes("fetch('/api/leaderboard/verify-pin'"))
}

console.log(nl + '-- price data: Hyperliquid, exchange prices ("TradingView"), mixed --')
{
  const P = await import('../../src/pfsources.js')
  t('a TradFi market maps to its exchange symbol; non-US listings to their own exchange', P.yahooFor({ sym: 'NVDA', group: 'tradfi' }) === 'NVDA' && P.yahooFor({ sym: 'SMSN', group: 'tradfi' }) === '005930.KS' && P.yahooFor({ sym: 'CL', group: 'tradfi' }) === 'CL=F')
  t('the same ticker is not the same asset: BB the perp (BounceBit) is not BB the stock (BlackBerry)', P.yahooFor({ sym: 'BB', group: 'crypto' }) === null && P.yahooFor({ sym: 'BB', group: 'tradfi' }) === 'BB')
  t('an unverified ticker is not guessed: it stays on Hyperliquid', P.yahooFor({ sym: 'KSTR', group: 'tradfi' }) === null && P.yahooFor({ sym: 'OAI', group: 'tradfi' }) === null)
  t('the server fetches only what the maps name', P.isAllowedYahoo('NVDA') && P.isAllowedYahoo('KRW=X') && !P.isAllowedYahoo('../x') && !P.isAllowedYahoo('EVIL'))
  const yj = { chart: { result: [{ meta: { currency: 'KRW' }, timestamp: [T0 / 1000 + 3600, T0 / 1000 + 86400 + 3600, T0 / 1000 + 2 * 86400], indicators: { quote: [{ close: [70000, null, 71400] }] } }] } }
  const py = P.parseYahooDaily(yj)
  t('exchange closes: one per day, gaps skipped, currency kept', py.currency === 'KRW' && py.pts.length === 2 && py.pts[0][0] === T0 && py.pts[1][1] === 71400)
  const usd = P.toUsd(py.pts, [[T0, 1400], [T0 + 2 * D, 1428]])
  t('a won price becomes dollars at that day\'s rate', near(usd[0][1], 50) && near(usd[1][1], 50))
  t('an index is a level, not a price: ^N225 is not converted', !P.needsUsd('^N225', 'JPY') && P.needsUsd('005930.KS', 'KRW') && !P.needsUsd('NVDA', 'USD'))
  const sp = P.splice([[T0, 100], [T0 + D, 110], [T0 + 2 * D, 121], [T0 + 3 * D, 130]], [[T0 + 2 * D, 60.5], [T0 + 3 * D, 66]])
  t('mixed: outside history before the listing, scaled to meet Hyperliquid\'s first close; Hyperliquid after', sp.splicedAt === T0 + 2 * D && sp.pts.length === 4 && near(sp.pts[0][1], 50) && near(sp.pts[1][1], 55) && sp.pts[2][1] === 60.5)
  t('the scaling keeps every return the market made', near(sp.pts[1][1] / sp.pts[0][1], 1.1))
  t('nothing before the listing: Hyperliquid alone', P.splice([[T0 + 5 * D, 1]], [[T0, 2]]).splicedAt === null)
  t('CoinGecko: the last price of each day', JSON.stringify(P.parseCgChart({ prices: [[T0 + 1, 5], [T0 + 2, 6], [T0 + D, 7]] })) === JSON.stringify([[T0, 6], [T0 + D, 7]]))
  const SRV = fs.readFileSync('serve-prod.js', 'utf8')
  const r = SRV.slice(SRV.indexOf("if (url === '/pf-history')"), SRV.indexOf("if (url === '/portfolios-data' ||"))
  t('the route: exchange symbols only from the allowlist, CoinGecko ids only ones already matched', r.includes("if (src === 'yahoo' && !isAllowedYahoo(key)) return send(404") && r.includes('if (!ids.has(key)) return send(404'))
  t('CoinGecko is asked one at a time, seconds apart, and kept on disk', SRV.includes('const wait = 2600 - (Date.now() - pfhCgLast)') && SRV.includes("join(__dirname, 'data', 'cghist')"))
  t('a listing in a currency it cannot convert is refused, not shown in the wrong units', SRV.includes("if (!fxSym) throw new Error('currency ' + currency)"))
  // One rule, both sides: the source is decided from the market id alone.
  const a = P.planFor('xyz:SMSN'), z = P.planFor('ZEC'), sp7 = P.planFor('@700'), kp = P.planFor('kPEPE')
  t('planFor: a HIP-3 stock → its exchange; a coin → its quote or CoinGecko; spot and k-perps → Hyperliquid', a.tradfi && a.yahooTv === '005930.KS' && a.yahooMixed === '005930.KS' && !z.tradfi && z.yahooTv === 'ZEC-USD' && z.yahooMixed === null && z.cgSym === 'ZEC' && sp7.yahooTv === null && sp7.cgSym === null && kp.cgSym === null)
  const hlS = [[T0 + 10 * D, 50], [T0 + 11 * D, 55]], exS = [[T0, 10], [T0 + 10 * D, 20], [T0 + 11 * D, 30]]
  t('closesFor: TradingView is the exchange series, or Hyperliquid when there is none', P.closesFor('tv', hlS, exS).used === 'tv' && P.closesFor('tv', hlS, null).used === 'hl')
  t('closesFor: Mixed splices and says from which source', P.closesFor('mixed', hlS, exS, 'cg').used === 'cg' && P.closesFor('mixed', hlS, exS, 'cg').pts[0][1] === 25 && P.closesFor('hl', hlS, null).pts === hlS)
  t('CoinGecko only for a coin Hyperliquid listed within its year', P.wantsCg([[Date.now() - 100 * D, 1]]) && !P.wantsCg([[Date.now() - 500 * D, 1]]))
  t('the server prices the featured cards in every mode, from the same planFor/closesFor', SRV.includes("const PF_MODES = ['hl', 'tv', 'mixed']") && SRV.includes("return closesFor('tv', hl, ext.pts)") && SRV.includes("get('src') || 'hl'"))
  t('a market whose outside history is not cached yet leaves its cards out (the browser answers), never priced on the wrong data', /if \(!ext\) return null/.test(SRV))
  t('the outside trickle never spends Hyperliquid weight: exchange every few seconds, CoinGecko a minute apart', SRV.includes("setInterval(() => { pfxTick('y').catch(() => {}) }, 8_000)") && SRV.includes("setInterval(() => { pfxTick('cg').catch(() => {}) }, 60_000)"))
  const cr = SRV.slice(SRV.indexOf("if (url === '/pf-closes')"), SRV.indexOf("if (url === '/pf-history')"))
  t('/pf-closes serves only markets the server keeps, in the mode asked, at most 40 at once', cr.includes('kept.has(c)') && cr.includes('.slice(0, 40)') && cr.includes('pfModeSeries(c, mode)'))
  const PJ = fs.readFileSync('src/portfolio.js', 'utf8')
  t('the page asks the server first, in one request, and shares it between callers', PJ.includes('await primeCloses(need)') && PJ.includes('primeAsked.set(mode + \'|\' + c, job)'))
  t('the page asks for the cards in the mode on screen, and prices the rest with the same rule', PJ.includes("fetch('/portfolios-data?src=' + mode") && PJ.includes('const p = planFor(coin)') && PJ.includes("galPerfSrc === srcMode()"))
}

console.log(nl + '-- accuracy: the errors found in the audit, each pinned --')
{
  const P = await import('../../src/pfsources.js')
  // 1. Liquidation at the maintenance margin, not at zero. 3× long of $1,000: a 30% drop leaves
  //    $100 against 2.5% of $2,100 = $52.50 (alive); a 32% drop leaves $40 against $51 (gone).
  const run3 = (drop) => B.backtest({ candles: { A: series([100, 100 * (1 - drop), 100 * (1 - drop)]) }, items: [{ key: 'A', weight: 1 }], from: T0, to: T0 + 2 * D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, leverage: 3, mmr: 0.025 } }).runs[0]
  t('3× through -30%: equity $100 is above maintenance $52.50 — alive', run3(0.30).liquidated === null && near(run3(0.30).final, 100))
  t('3× through -32%: equity $40 is under maintenance $51 — liquidated', run3(0.32).liquidated === T0 + D && run3(0.32).final === 0)
  // A crashed book no longer re-levers its last dollars into +1,000% days.
  const crash = B.backtest({ candles: { A: series([100, 68, 100, 140, 160]) }, items: [{ key: 'A', weight: 1 }], from: T0, to: T0 + 4 * D, strategies: ['weekly', 'monthly', 'hold'], opts: { capital: 1000, feeBps: 0, leverage: 3, mmr: 0.025 } })
  t('after a liquidation nothing is re-levered: no absurd days', crash.runs.every(x => x.final === 0 && (x.best ?? 0) <= 2))
  // 2. Stock splits in Hyperliquid's closes, repaired against the exchange (KIOXIA, real numbers).
  const T = Date.UTC(2026, 8, 24)
  const kx = P.repairSplits([[T, 369], [T + D, 343], [T + 2 * D, 357], [T + 3 * D, 114.12]], [[T, 114.56], [T + D, 117.08], [T + 2 * D, 117.08], [T + 3 * D, 112.99]])
  t('KIOXIA\'s 3-for-1 is not a -68% day: the split day moves as the exchange did (-3.5%)', near(kx[3][1] / kx[2][1], 112.99 / 117.08, 1e-9) && kx[3][1] === 114.12)
  t('and a real move is left alone', P.repairSplits([[T, 100], [T + D, 80]], [[T, 10], [T + D, 8]])[0][1] === 100)
  // 3. A data seam in outside history (Yahoo's AAVE carries the old LEND token, swapped 100:1).
  t('outside history before a 100× seam is dropped, not counted as a gain', P.dropBeforeBreak([[1, 0.52], [2, 0.5], [3, 53], [4, 55]]).length === 2 && P.closesFor('tv', null, [[1, 0.52], [2, 0.5], [3, 53], [4, 55]]).pts[0][1] === 53)
  // 4. The trading strategies: an open position is marked to market, its fee counted.
  const rising = Array.from({ length: 120 }, (_, i) => { const c = 100 * (1 + 0.5 * i / 119); return { t: T0 + i * D, o: c * 0.999, h: c * 1.002, l: c * 0.998, c } })
  const daysR = Array.from({ length: 120 }, (_, i) => T0 + i * D)
  const tb = B.botRun({ A: rising }, [{ key: 'A', weight: 1 }], daysR, 'trend', { capital: 1000, leverage: 1, feeBps: 4.5 })
  t('the Trend bot, always in, is valued with its open position: it enters after its 21-day average and rides the rest (~+38%), not "no trades closed"', tb.final > 1300 && tb.open >= 1, [tb.final, tb.open])
  t('its fees are shown, from the fills (≈ the open fee of a $1,000 position)', tb.fees > 0.3 && tb.fees < 1.5 && tb.feesEstimated === true, tb.fees)
  // 5. Warm-up: history before the window is used, and the run still starts at the capital.
  const warm = B.botRun({ A: rising }, [{ key: 'A', weight: 1 }], daysR.slice(60), 'emacross', { capital: 1000, leverage: 1, feeBps: 4.5 })
  t('with warm-up history the window still starts at the capital', near(warm.equity[0], 1000, 1e-9) && warm.equity.length === 60)
}

console.log(nl + '-- account settings: leverage as Hyperliquid allows it, cross or isolated --')
{
  t('5× asked on a 3× market is 3×; Max is each market\'s own; spot is 1×; an unknown maximum is not capped',
    B.effectiveLeverage(5, 3) === 3 && B.effectiveLeverage('max', 10) === 10 && B.effectiveLeverage(20, 50, true) === 1 && B.effectiveLeverage(7, null) === 7)
  const up = { A: series([100, 110]) }
  const capped = B.backtest({ candles: up, items: [{ key: 'A', weight: 1 }], from: T0, to: T0 + D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, leverage: 5, levBy: { A: 3 } } }).runs[0]
  t('capped at 3×, a +10% move earns 30%, not the 50% that 5× would', near(capped.final, 1300), capped.final)
  // Two holdings at 5×, $2,500 each on $500 of margin each: A falls 40% (-$1,000), B is flat.
  const two = { A: series([100, 60, 60]), B: series([100, 100, 100]) }
  const items2b = [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }]
  const iso = B.backtest({ candles: two, items: items2b, from: T0, to: T0 + 2 * D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, leverage: 5, mmr: 0.025, margin: 'isolated' } }).runs[0]
  const cross = B.backtest({ candles: two, items: items2b, from: T0, to: T0 + 2 * D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, leverage: 5, mmr: 0.025, margin: 'cross' } }).runs[0]
  t('isolated: the crashed position loses its own $500 margin — not the $1,000 it fell — and the other carries on', iso.isoLiqs === 1 && iso.liquidated === null && near(iso.final, 500), [iso.final, iso.isoLiqs])
  t('cross: the same crash takes the whole account', cross.liquidated === T0 + D && cross.final === 0)
  // The trading strategies' own settings
  const p1 = B.botParams('rsi', { takeProfitPct: 8, slOff: true }, 1000)
  t('take profit and stop loss reach the five strategies that read them; Off never fires', p1.takeProfitPct === 8 && p1.stopLossPct >= 1e6 && !('slOff' in p1))
  t('and do nothing to the others (Supertrend, the Trend bot, Volatility breakout, Grid, DCA)', ['supertrend', 'trend', 'volbreak', 'grid', 'dca'].every(id => B.botParams(id, { takeProfitPct: 8 }).takeProfitPct === 8 && !B.PCT_EXITS.includes(id)))
  const d = B.botParams('dca', { dcaSoCount: 3, dcaVolScale: 2 }, 1500)
  t('DCA: the base order and all its safety orders fit the holding\'s share exactly', near(d.dcaBaseUsd + d.dcaSoUsd * (1 + 2 + 4), 1500) && d.dcaSoCount === 3)
  const g = B.botParams('grid', { gridLevels: 5 }, 1000)
  t('Grid: rungs sized to the holding\'s share', g.gridLevels === 5 && near(g.gridUsdPerLevel, 200))
}

console.log(nl + '-- funding and slippage (src/pffunding.js) --')
{
  const F = await import('../../src/pffunding.js')
  const flat = { A: series(Array(11).fill(100)) }
  const info = F.fundingInfo(Array.from({ length: 11 }, (_, i) => [T0 + i * D, 0.001]), T0)
  const run = (side, fund, extra = {}) => B.backtest({ candles: flat, items: [{ key: 'A', weight: 1, side }], from: T0, to: T0 + 10 * D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, funding: fund, ...extra } }).runs[0]
  const L = run('long', { A: info }), Sh = run('short', { A: info })
  t('a long pays funding: $1,000 at 0.1% a day for 10 days is $10', near(L.funding, 10) && near(L.final, 990), [L.funding, L.final])
  t('a short receives it', near(Sh.funding, -10) && near(Sh.final, 1010), [Sh.funding, Sh.final])
  t('every day from actual rates', L.fundDays === 10 && L.fundEstDays === 0)
  const part = F.fundingInfo([[T0, 0.001], [T0 + D, 0.001], [T0 + 2 * D, 0.004]], T0, T0 + 20 * D)
  const P2 = run('long', { A: part })
  t('days not in yet use the market\'s average, and are counted as estimated', P2.fundEstDays === 8 && near(P2.funding, (0.001 + 0.004 + 8 * 0.002) * 1000), [P2.funding, P2.fundEstDays])
  t('no funding before a market listed on Hyperliquid', F.rateOn(F.fundingInfo([[T0, 0.01]], T0 + 5 * D), T0 + D)[0] === 0)
  t('the daily sum of hourly rates', JSON.stringify(F.dailyFunding([{ time: T0 + 1, fundingRate: '0.0001' }, { time: T0 + 3600e3, fundingRate: '0.0002' }, { time: T0 + D, fundingRate: '-0.0001' }]).map(([d, r]) => [d, +r.toFixed(6)])) === JSON.stringify([[T0, 0.0003], [T0 + D, -0.0001]]))
  t('slippage: half-spread + 0.7 × σ × √(size ÷ volume): $10K into a $1M market at 3% daily vol = 26 bps = $26', near(F.slippage(10_000, { spreadBps: 5, vol: 1e6 }, 0.03), 26, 1e-9))
  t('a market with no book data still pays a modest default, never zero', near(F.slippage(1000, null, null), 1, 1e-9))
  t('and no fill pays more than 5%', F.slippage(1e9, { spreadBps: 5, vol: 1 }, 0.5) === 1e9 * 0.05)
  t('half the spread from Hyperliquid\'s impact prices', near(F.halfSpreadBps(['99.9', '100.1'], 100), 10))
  const S1 = run('long', null, { book: { A: { spreadBps: 5, vol: 1e6 } } })
  t('slippage is charged on the buy, and reported', S1.slippage > 0 && near(S1.final, 1000 - S1.slippage), S1.slippage)
  t('"BTC, held" pays neither: it is owning BTC', B.backtest({ candles: flat, items: [{ key: 'A', weight: 1 }], from: T0, to: T0 + 10 * D, strategies: ['hold'], opts: { capital: 1000, feeBps: 0, funding: { A: info }, book: { A: {} } }, bench: 'A' }).bench.funding === null)
  const rising = Array.from({ length: 120 }, (_, i) => { const c = 100 * (1 + 0.5 * i / 119); return { t: T0 + i * D, o: c * 0.999, h: c * 1.002, l: c * 0.998, c } })
  const daysR = Array.from({ length: 120 }, (_, i) => T0 + i * D)
  const fInfo = F.fundingInfo(daysR.map(d => [d, 0.0005]), T0)
  const tb0 = B.botRun({ A: rising }, [{ key: 'A', weight: 1 }], daysR, 'trend', { capital: 1000, feeBps: 4.5 })
  const tb1 = B.botRun({ A: rising }, [{ key: 'A', weight: 1 }], daysR, 'trend', { capital: 1000, feeBps: 4.5, funding: { A: fInfo }, book: { A: { spreadBps: 5, vol: 1e6 } } })
  t('the trading strategies pay funding while they hold, and slippage on their fills', tb1.funding > 0 && tb1.slippage > 0 && near(tb0.final - tb1.final, tb1.funding + tb1.slippage, 0.02), [tb0.final, tb1.final, tb1.funding, tb1.slippage])
  t('and each holding\'s row is before costs, so the rows and the costs add up to the result', near(Object.values(tb1.pnlBy).reduce((a, v) => a + v, 0) - tb1.fees - tb1.funding - tb1.slippage, tb1.final - 1000, 0.02))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
