// The common retail bots in the Trade Simulator, and the report that reads them.
//
// Each new strategy is a textbook rule, so each is asserted against the textbook: an RSI that
// agrees with Wilder's, a band that fires on the candle that leaves it, a DCA whose target is
// measured from the AVERAGE entry. And the money: a position pays what the price moved, and a
// leveraged one that moves too far is liquidated rather than forgiven.
import fs from 'fs'
import { runBacktest, runPortfolio, signals, normalise, coerceParams, rsiSeries, supertrendSeries,
         dcaDeviations, runDcaBacktest, runGridBacktest, dcaFullDeal,
         mmRate, hlLiqPrice, sizePosition, closePnl, effLeverage,
         BT_DEFAULTS, BT_STRATEGIES, BT_STRATEGY_META, BT_FIELDS, BT_CHOICES, BT_MODULES, strategyKind }
  from '../../src/backtest.js'
import { equityCurve, drawdownCurve, riskStats, tradeStats, monthlyReturns, buyHold, summarize,
         downsample, score } from '../../src/btstats.js'

const sim = fs.readFileSync('src/simulator.js', 'utf8').replace(/\r\n/g, '\n')
const main = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

// A market that swings: a slow sine with noise, so every kind of rule has something to do.
const H = 3600e3, T0 = Date.UTC(2026, 0, 1)
let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const wave = (() => {
  const out = []; let px = 100
  for (let i = 0; i < 2400; i++) {
    const o = px
    px = 100 * (1 + 0.12 * Math.sin(i / 60)) * (1 + (rnd() - 0.5) * 0.01)
    out.push({ t: T0 + i * H, o, h: Math.max(o, px) * (1 + rnd() * 0.004), l: Math.min(o, px) * (1 - rnd() * 0.004), c: px })
  }
  return out
})()
const rows = normalise(wave)

console.log(nl + '-- the list --')
const want = ['rsi', 'bollinger', 'macd', 'emacross', 'supertrend', 'dca']
t('the common bots are offered', want.every(k => BT_STRATEGIES.some(s => s[0] === k)))
t('every strategy has a shape and a category', BT_STRATEGIES.every(([k]) => BT_STRATEGY_META[k]?.kind && BT_STRATEGY_META[k]?.cat))
t('and a description long enough to say what it does', BT_STRATEGIES.every(s => s[2].length > 100))
t('the deployed bots are marked as such', ['volbreak', 'trend', 'grid', 'tokyo'].every(k => BT_STRATEGY_META[k].bot) &&
  want.every(k => !BT_STRATEGY_META[k].bot))
for (const k of want) {
  const r = runBacktest(wave, { strategy: k })
  t(`${k} trades on a market that swings`, r.tradesMade > 0, r.tradesMade)
  t(`${k}: every closed trade carries its delta`, r.trades.filter(x => x.outcome !== 'open').every(x => Number.isFinite(x.delta)))
}
t('every new setting has a box, with help', want.every(k => BT_FIELDS.some(f => f.strategy === k)) &&
  BT_FIELDS.filter(f => want.includes(f.strategy)).every(f => (f.help ?? '').length > 60))

console.log(nl + '-- RSI is Wilder\'s --')
// Fourteen straight gains and nothing else: no losses at all, so RSI is pinned at 100.
const up = normalise(Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * H, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i })))
const r1 = rsiSeries(up, 14)
t('nothing before n changes have been seen', r1.slice(0, 14).every(v => v === null))
t('only gains is 100', near(r1[14], 100) && near(r1[29], 100))
const flat = normalise(Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * H, o: 100, h: 100, l: 100, c: 100 })))
t('no movement at all is 50, not 100', near(rsiSeries(flat, 14)[20], 50))
// The classic worked example: alternating +1 / -1 settles at 50.
const alt = normalise(Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H, o: 100, h: 102, l: 98, c: 100 + (i % 2) })))
t('equal gains and losses sit near 50', Math.abs(rsiSeries(alt, 14)[59] - 50) < 5, rsiSeries(alt, 14)[59])
const rs = signals(rows, coerceParams({ strategy: 'rsi' }))
const rv = rsiSeries(rows, 14)
t('a long fires on the TURN back above oversold, never while still below it',
  rs.every((s, i) => s !== 1 || (rv[i - 1] < 30 && rv[i] >= 30)))
t('a short fires on the turn back below overbought',
  rs.every((s, i) => s !== -1 || (rv[i - 1] > 70 && rv[i] <= 70)))

console.log(nl + '-- Bollinger fires on the candle that leaves the band --')
const bb = signals(rows, coerceParams({ strategy: 'bollinger' }))
const bbx = signals(rows, coerceParams({ strategy: 'bollinger', bbMode: 'breakout' }))
t('it fires', bb.some(v => v))
t('breakout is revert with the sign flipped', bb.every((v, i) => (v ?? 0) === -(bbx[i] ?? 0)))
t('never two candles in a row', bb.every((v, i) => !(v && bb[i - 1])))
t('the mode is a choice with help', BT_CHOICES.some(c => c.key === 'bbMode' && c.strategy === 'bollinger' && c.help.length > 60))

console.log(nl + '-- crossings are events, not states --')
for (const k of ['macd', 'emacross']) {
  const s = signals(rows, coerceParams({ strategy: k }))
  t(`${k} fires on single candles`, s.filter(Boolean).length > 2 && s.every((v, i) => !(v && s[i - 1] === v)))
  t(`${k} alternates long and short`, (() => { const f = s.filter(Boolean); return f.every((v, i) => !i || v !== f[i - 1]) })())
}
t('the slow average is kept longer than the fast', coerceParams({ macdFast: 20, macdSlow: 10 }).macdSlow > 20 &&
  coerceParams({ crossFast: 30, crossSlow: 5 }).crossSlow > 30)

console.log(nl + '-- Supertrend is a state, always in --')
const st = supertrendSeries(rows, 10, 3)
t('it has a side on every candle after the warm-up', st.slice(20).every(v => v === 1 || v === -1))
t('and changes side sometimes, not constantly', (() => { let n = 0; for (let i = 21; i < st.length; i++) if (st[i] !== st[i - 1]) n++; return n > 2 && n < 200 })())
const sr = runBacktest(wave, { strategy: 'supertrend' })
t('it is a flip strategy', strategyKind('supertrend') === 'flip')
t('so each close is followed by the opposite side', sr.trades.every((x, i) => !i || x.side !== sr.trades[i - 1].side))
t('its optional stop changes the result', runBacktest(wave, { strategy: 'supertrend', stStopPct: 0.3 }).netPnl !== sr.netPnl)

console.log(nl + '-- DCA averages down and targets the average --')
const p0 = coerceParams({ strategy: 'dca' })
t('the safety orders spread out by the step scale', (() => {
  const d = dcaDeviations({ ...p0, dcaStepPct: 1, dcaStepScale: 2, dcaSoCount: 3 })
  return near(d[0], 1) && near(d[1], 3) && near(d[2], 7)
})())
// Down 1%, down 2%, then up: the base at 100 and one safety order at 99 average to ~99.5,
// so a 1% target is ~100.5 -- reachable without ever getting back to... well, 100.5.
const dip = normalise([
  { t: T0, o: 100, h: 100, l: 100, c: 100 },
  { t: T0 + H, o: 100, h: 100, l: 98.9, c: 99 },
  { t: T0 + 2 * H, o: 99, h: 100.6, l: 99, c: 100.6 },
])
const d1 = runDcaBacktest(dip, { ...p0, dcaBaseUsd: 100, dcaSoUsd: 100, dcaSoCount: 3, dcaStepPct: 1, dcaVolScale: 1, dcaTpPct: 1, useFees: false })
const closed = d1.trades.filter(x => x.outcome !== 'open')
t('the safety order filled and the deal closed', closed.length === 1 && closed[0].so === 1, d1.trades)
t('the target was measured from the average entry', closed[0] && near(closed[0].tp, closed[0].entry * 1.01, 1e-9) && closed[0].entry < 100)
t('and it paid what the stack made', closed[0] && near(closed[0].delta, (100 / 100 + 100 / 99) * (closed[0].tp - closed[0].entry), 1e-9))
// A safety order and the target inside the same candle cannot be ordered, so the target waits.
const same = normalise([
  { t: T0, o: 100, h: 100, l: 100, c: 100 },
  { t: T0 + H, o: 100, h: 101, l: 98.9, c: 100 },
])
t('a safety order and the target in one candle: the target waits',
  runDcaBacktest(same, { ...p0, dcaSoCount: 3, dcaStepPct: 1, dcaTpPct: 0.5, useFees: false }).trades.every(x => x.outcome === 'open'))
const dr = runBacktest(wave, { strategy: 'dca' })
t('without a stop there is no win rate -- it is 100% by construction', dr.winRate === null)
t('with one there is', runBacktest(wave, { strategy: 'dca', dcaSlPct: 3 }).winRate !== null)
t('the drawdown includes the stack underwater, not just closed deals', dr.maxDrawdown > 0 && Array.isArray(dr.curve))
t('the full deal size is reported', dr.dca.maxPossible > p0.dcaBaseUsd)
t('DCA is no longer listed as impossible', !fs.readFileSync('src/backtest.js', 'utf8').includes("['DCA', 'Averages into"))

console.log(nl + '-- the grid drawdown is real now --')
const gr = runBacktest(wave, { strategy: 'grid', gridRangePct: 5 })
t('marked to market every candle, so it is not always zero', gr.maxDrawdown > 0, gr.maxDrawdown)
t('grid cycles are dollar-sized for a portfolio', gr.trades.every(x => x.sized && Number.isFinite(x.ret)))

console.log(nl + '-- Hyperliquid margin: cross, isolated, and where each is liquidated --')
// Asked for: "cross/isolated, with their proper liquidation prices depending the chosen one".
// Hyperliquid: maintenance margin is half the initial margin at the market's MAX leverage, and a
// position is liquidated where equity meets it. Cross counts the whole account as equity;
// isolated counts only the margin posted for the position.
const HLP = { ...BT_DEFAULTS, maxLev: 50, useFees: false }
t('maintenance is half the initial margin at max leverage', near(mmRate({ maxLev: 50 }), 0.01) && near(mmRate({ maxLev: 3 }), 1 / 6))
// A long of 1 coin at 100, backed by $10: equity 10 + (P - 100) meets 0.01 * P at P = 90/0.99.
t('the long line is where equity meets maintenance', near(hlLiqPrice(1, 100, 1, 10, 0.01), 90 / 0.99, 1e-9))
t('and the short line is its mirror', near(hlLiqPrice(-1, 100, 1, 10, 0.01), 110 / 1.01, 1e-9))
t('a long backed by its whole value cannot be liquidated', hlLiqPrice(1, 100, 1, 100, 0.01) === null)
const iso = sizePosition(1000, { ...HLP, marginMode: 'isolated', sizeMode: 'usd', sizeUsd: 1000, leverage: 10 }, 100, 1)
const crs = sizePosition(1000, { ...HLP, marginMode: 'cross', sizeMode: 'usd', sizeUsd: 1000, leverage: 10 }, 100, 1)
t('a $1,000 position at 10x posts $100 of margin', near(iso.margin, 100) && near(iso.q, 10))
t('isolated: liquidated about 9% away, when its $100 is nearly gone', near(iso.liq, (100 - 10) / 0.99, 1e-9))
t('cross: the same position is backed by the whole $1,000 -- it cannot be liquidated at all', crs.liq === null)
const crs5 = sizePosition(1000, { ...HLP, marginMode: 'cross', sizeMode: 'usd', sizeUsd: 5000, leverage: 10 }, 100, 1)
t('a bigger cross position sits closer, backed by the same account', crs5.liq != null && crs5.liq > 79 && crs5.liq < 81, crs5.liq)
const crs5b = sizePosition(1000, { ...HLP, marginMode: 'cross', sizeMode: 'usd', sizeUsd: 5000, leverage: 20 }, 100, 1)
t('in cross, leverage does not move the line -- only the margin it asks for', near(crs5b.liq, crs5.liq) && crs5b.margin < crs5.margin)
const iso20 = sizePosition(1000, { ...HLP, marginMode: 'isolated', sizeMode: 'usd', sizeUsd: 1000, leverage: 20 }, 100, 1)
t('in isolated, more leverage pulls it closer', iso20.liq > iso.liq)
t('an order under $10 is refused', sizePosition(1000, { ...HLP, sizeMode: 'usd', sizeUsd: 9 }, 100, 1).rejected === 'min')
t('so is one the account cannot margin', sizePosition(100, { ...HLP, sizeMode: 'usd', sizeUsd: 5000, leverage: 10 }, 100, 1).rejected === 'margin')
t('leverage is capped at the market\'s maximum', effLeverage({ leverage: 40, maxLev: 3 }) === 3)
t('100% of the balance leaves room for the fee, as the order slider does',
  !sizePosition(1000, { ...BT_DEFAULTS, maxLev: 50, sizePct: 100, leverage: 1 }, 100, 1).rejected)
t('sizes can be coins', near(sizePosition(1000, { ...HLP, sizeMode: 'coin', sizeCoin: 2.5 }, 100, 1).q, 2.5))

console.log(nl + '-- fees are per fill: maker for resting orders, taker for the rest --')
const FP = { ...BT_DEFAULTS, useFees: true, makerFeePct: 0.015, takerFeePct: 0.045 }
const fp = sizePosition(20000, { ...FP, sizeMode: 'usd', sizeUsd: 10000 }, 100, 1)
t('the entry is a market order and pays taker', near(fp.openFee, 4.5))
t('a target that fills pays maker on the way out', near(closePnl(fp, 1, 100, 100, FP, 'maker'), -4.5 - 1.5))
t('a stop pays taker', near(closePnl(fp, 1, 100, 100, FP, 'taker'), -9))

console.log(nl + '-- liquidation in a run --')
// A long entered on a candle before a crash, with a stop far below the liquidation line.
const crash = normalise([
  ...Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * H, o: 100, h: 100.5, l: 99.5, c: 100 })),
  { t: T0 + 40 * H, o: 100, h: 104, l: 99, c: 103.5 },
  { t: T0 + 41 * H, o: 103.5, h: 103.5, l: 80, c: 82 },
  ...Array.from({ length: 10 }, (_, i) => ({ t: T0 + (42 + i) * H, o: 82, h: 83, l: 81, c: 82 })),
])
const run = (extra) => runBacktest(crash, { strategy: 'breakout', breakoutLookback: 20, stopLossPct: 15, takeProfitPct: 50,
  useCooldown: false, maxLev: 50, ...extra })
const lqI = run({ marginMode: 'isolated', sizeMode: 'usd', sizeUsd: 5000, leverage: 20 })
const lqT = lqI.trades.find(x => x.liq)
t('an isolated 20x long is liquidated in the crash, before its stop', !!lqT && lqT.exitPx > lqT.sl, lqI.trades)
t('it closes at its own liquidation price', lqT && near(lqT.exitPx, lqT.liqPx, 1e-9))
t('and loses about its margin, not the account', lqT && lqT.delta < -200 && lqT.delta > -260, lqT?.delta)
const lqC = run({ marginMode: 'cross', sizeMode: 'usd', sizeUsd: 5000, leverage: 20 })
t('the same position in cross survives -- the account stands behind it', !lqC.trades.some(x => x.liq))
t('and takes the stop instead, a much bigger loss', lqC.trades[0]?.outcome === 'loss' && lqC.trades[0].delta < lqT.delta)
const big = run({ marginMode: 'cross', sizeMode: 'pct', sizePct: 100, leverage: 20 })
// At 20x on a 50x market, cross is liquidated when the account is down to maintenance -- 1% of
// a position twenty times its size, so about a fifth of it is left.
t('a full-size cross 20x long is liquidated, and takes most of the account', big.trades.some(x => x.liq) && big.balance < 300, big.balance)
t('every trade records how far it went against it', lqI.trades.every(x => x.mae != null))

console.log(nl + '-- grid and DCA are leveraged positions too --')
const dcaCrash = normalise([
  { t: T0, o: 100, h: 100, l: 100, c: 100 },
  ...Array.from({ length: 30 }, (_, i) => ({ t: T0 + (i + 1) * H, o: 100 - i * 2, h: 100 - i * 2, l: 98 - i * 2, c: 98 - i * 2 })),
])
const dcaP = { strategy: 'dca', maxLev: 50, dcaBaseUsd: 1000, dcaSoUsd: 1000, dcaSoCount: 3, dcaStepPct: 2, dcaVolScale: 1, dcaTpPct: 1 }
const dI = runBacktest(dcaCrash, { ...dcaP, marginMode: 'isolated', leverage: 10 })
t('an isolated DCA stack is liquidated when price runs past its safety orders', dI.dca.liquidations >= 1, dI.dca)
t('the liquidation is on the ledger', dI.trades.some(x => x.liq && x.outcome === 'loss'))
const dC = runBacktest(dcaCrash, { ...dcaP, marginMode: 'cross', leverage: 10 })
const firstLiq = (r) => r.trades.find(x => x.liq)?.exitPx
t('the same stack in cross is liquidated later -- the account stands behind it', firstLiq(dC) < firstLiq(dI), [firstLiq(dI), firstLiq(dC)])
t('and when it goes, it takes the account; isolated lost only what each deal posted', dC.balance < dI.balance, [dI.balance, dC.balance])
const dSmall = runBacktest(dcaCrash, { ...dcaP, startBalance: 1500, leverage: 1, dcaSoCount: 5 })
t('a safety order the account cannot margin is refused, not filled', dSmall.dca.soRefused >= 1, dSmall.dca)
const dCoin = runDcaBacktest(normalise([{ t: T0, o: 100, h: 100, l: 100, c: 100 }, { t: T0 + H, o: 100, h: 100, l: 100, c: 100 }]),
  { ...BT_DEFAULTS, ...dcaP, orderUnit: 'coin', dcaBaseUsd: 3 })
t('DCA orders can be sized in coins', near(dCoin.trades[0].q, 3))
t('a full deal says what margin it needs at this leverage', near(dcaFullDeal({ ...BT_DEFAULTS, ...dcaP, leverage: 4 }, 100).margin, 4000 / 4))
const gl = runBacktest(dcaCrash, { strategy: 'grid', maxLev: 50, gridRangePct: 20, gridLevels: 10, gridUsdPerLevel: 2000, leverage: 10, marginMode: 'isolated' })
t('a leveraged grid holding a falling inventory is liquidated', gl.grid.liquidations >= 1, gl.grid)
t('a grid rung pays maker, not taker', (() => {
  // One candle, so only buys fill: each is a $1,000 resting order at the maker rate.
  const f = runGridBacktest(normalise([{ t: T0, o: 100, h: 100, l: 95, c: 96 }]),
    { ...BT_DEFAULTS, startBalance: 10000, gridLower: 90, gridUpper: 110, gridLevels: 5, gridUsdPerLevel: 1000, maxLev: 50 })
  return f.grid.buys >= 1 && near(f.grid.fees, f.grid.buys * 1000 * 0.00015)
})())

console.log(nl + '-- one position at a time --')
const many = runBacktest(wave, { strategy: 'bollinger', useCooldown: false, useOnePos: false })
const one = runBacktest(wave, { strategy: 'bollinger', useCooldown: false, useOnePos: true })
t('it is on by default', BT_DEFAULTS.useOnePos === true && BT_MODULES[0].key === 'useOnePos')
t('it takes fewer trades than letting them overlap', one.tradesMade <= many.tradesMade, [one.tradesMade, many.tradesMade])
t('and no trade opens before the previous one closed',
  one.trades.every((x, i) => !i || one.trades[i - 1].exitAt == null || x.time >= one.trades[i - 1].exitAt))

console.log(nl + '-- a portfolio re-books dollar-sized trades by what they returned --')
const port = runPortfolio([{ coin: 'A', result: dr }, { coin: 'B', result: runBacktest(wave, { strategy: 'rsi' }) }], BT_DEFAULTS)
t('it runs', port.tradesMade > 0)
t('the deltas plus what is still open add up to the total',
  near(port.trades.reduce((a, x) => a + x.delta, 0) + port.openPnl, port.netPnl, 1e-6))
t('the open DCA deal is counted, not dropped', port.openPnl === dr.dca.unrealized / 2)
const gp = runPortfolio([{ coin: 'A', result: gr }, { coin: 'B', result: gr }], { ...BT_DEFAULTS, strategy: 'grid' })
t('a grid portfolio has no win rate either', gp.winRate === null)

console.log(nl + '-- the report --')
const r = runBacktest(wave, { strategy: 'emacross' })
const curve = equityCurve(r)
t('the curve starts at the starting balance', curve[0][1] === r.startBalance)
t('and ends at the ending balance', near(curve[curve.length - 1][1], r.balance))
t('it is in time order', curve.every((p, i) => !i || p[0] >= curve[i - 1][0]))
t('a drawdown is never above zero', drawdownCurve(curve).every(p => p[1] <= 0))
const ts = tradeStats(r)
t('profit factor is gross wins over gross losses', ts.profitFactor == null || near(ts.profitFactor, ts.grossWin / -ts.grossLoss))
t('no losing trade is no profit factor, not infinity', tradeStats({ trades: [{ outcome: 'win', delta: 5 }] }).profitFactor === null)
t('streaks are counted', ts.maxConsecWins >= 1 && ts.maxConsecLosses >= 0)
const short = riskStats([[T0, 1000], [T0 + 3 * 86400e3, 1100]])
t('nothing is annualised from three days', short.cagr === null && short.sharpe === null)
const year = Array.from({ length: 400 }, (_, i) => [T0 + i * 86400e3, 1000 * (1 + i * 0.001 + 0.01 * Math.sin(i))])
const ry = riskStats(year)
t('a year of data has a Sharpe and an annual rate', ry.sharpe != null && ry.cagr != null && ry.calmar != null)
t('months are cut at the calendar', monthlyReturns(year).length >= 13 && monthlyReturns(year)[0].month === 0)
const bh = buyHold({ A: [{ t: 1, c: 100 }, { t: 2, c: 150 }], B: [{ t: 1, c: 10 }, { t: 2, c: 5 }] }, ['A', 'B'], 1000)
t('buy and hold is equal weight', near(bh.retPct, 0) && near(bh.curve[1][1], 1000))
t('a market with no candles is no benchmark, not zero', buyHold({}, ['A'], 1000) === null)
const s = summarize(r, { X: rows }, ['X'])
t('the summary carries the edge over holding', s.edge != null && near(s.edge, r.roe - s.bench.retPct))
t('downsampling keeps the ends and the lows', (() => {
  const pts = Array.from({ length: 5000 }, (_, i) => [i, i === 2500 ? -99 : i])
  const d = downsample(pts, 100)
  return d.length <= 100 && d[0][0] === 0 && d[d.length - 1][0] === 4999 && d.some(p => p[1] === -99)
})())
t('ranking divides by the drawdown', near(score(20, 10), 2) && score(null, 5) === null)

console.log(nl + '-- the screen --')
t('it is its own module, not part of main.js', !main.includes('function _simRender(') && main.includes("from './simulator.js'"))
t('main.js keeps only the helper the bot cards share', main.includes('function _resolveMarketId(name)'))
t('it cannot see state', !/\bstate\./.test(sim))
t('it is solid over a wallpaper', /\.sim-root \{ background: var\(--bg\)/.test(css) && /\.sim-card \{ background: var\(--panel\)/.test(css))
t('and says why', css.includes('make it non-transparent'))
t('the layout follows the width it is given, not the screen', css.includes('container-name: simroot') && css.includes('@container simroot (min-width: 980px)'))
t('every strategy can be compared in one go', sim.includes('window.__simCompare = async function') && sim.includes('for (const [key] of BT_STRATEGIES)'))
t('against buying and holding', sim.includes("_T('Buy & hold', 'Comprar y mantener')") && sim.includes('buyHold(bars, loaded'))
t('a comparison row opens as a full result without fetching again', !/window\.__simCmpPick = function[\s\S]{0,1200}fetchCandles/.test(sim))
t('a sweep warns when the best value is a spike', sim.includes('The best value is a spike'))
t('horizontal strips can be reached by drag', (sim.match(/data-dragscroll/g) || []).length >= 3)
t('a hidden strategy\'s settings survive collecting the form', sim.includes('for (const f of BT_FIELDS) if (raw[f.key] == null) raw[f.key] = _simParams[f.key]'))
// Reported: "instead of popular is sorted alphabetically". Volumes are only loaded when a screen
// asks; with none, every market tied at zero and the list was the exchange's A-Z order.
t('the most-traded list asks for volumes itself', sim.includes('ctx.loadMarkets()') && main.includes('loadMarkets: () => _ensureMarketData()'))
t('and shows nothing rather than an unranked list', sim.includes('const list = _simMarkets().list.filter(m => (m.vol ?? 0) > 0)') &&
  sim.includes('if (!list.length) { _simLoadVolumes(); return [] }'))
t('old saves move to position sizing only if they never chose a model', sim.includes("if (!s.modelV && _simParams.pnlModel === 'fixed')"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
