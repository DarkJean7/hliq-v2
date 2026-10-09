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
  const r = B.backtest({ candles: c, items: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }], from: T0, to: T0 + 39 * D, strategies: ['hold'], opts: opts0, bench: 'A' })
  t('a window that starts before a holding listed is clipped, and says by which', r.start === T0 + 10 * D && r.clippedBy === 'B')
  t('the benchmark runs over the same days', r.bench && r.bench.equity.length === r.days.length)
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
  t('/portfolios searches the shown name anywhere in it', P.includes("const names = (r) => [r.sym, r.label ?? '', r.name ?? '']") &&P.includes('names(r).some(x => x.includes(q))'))
  t('the app reads the same list', MAIN.includes('const _MKT_DISPLAY = DISPLAY_NAMES'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
