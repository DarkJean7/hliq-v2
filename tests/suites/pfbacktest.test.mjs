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
  t('it is the Simulator\'s own engine, not a copy', SRC.includes("import { runBacktest } from './backtest.js'"))
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
  t('the server: anyone reads; every write first asks the strategy server whether the PIN is right', /return send\(200, \{ portfolios: pfRead\(\)(, perf, asOf)? \}\)/.test(route) && route.indexOf('await devPinOk(') < route.indexOf('await readJson(') && route.includes("if (!ok) return send(403"))
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
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
