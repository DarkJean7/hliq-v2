/**
 * Portfolio backtests for /portfolios — pure: no DOM, no fetch. tests/suites/pfbacktest.test.mjs.
 * (Not src/backtest.js: that is the Trade Simulator's engine, which this reuses below.)
 *
 * The model, stated once so every number on the page can be checked against it:
 *
 *   - One price per asset per UTC day: Hyperliquid's daily candle CLOSE. Days with no candle
 *     carry the last close forward (a market that did not trade did not move).
 *   - Weights are signed: +0.3 is 30% long, -0.1 is 10% short. They are normalised so the
 *     absolute weights add to 1, and leverage L scales the whole book: exposure_i =
 *     L × equity × w_i. Equity = cash + Σ units × price, so a short's proceeds sit in cash and
 *     a leveraged book has negative cash — the same arithmetic as a margin account.
 *   - A trade costs `feeBps` of its notional. Funding is NOT modelled (Hyperliquid's funding
 *     history is hourly per market, far too many calls for a browser to fetch), and neither is
 *     slippage. The page says so.
 *   - Equity at or below zero is a liquidation: the run stops there at zero. Daily closes see
 *     less than a real account would — an intraday wick can liquidate a position that the
 *     close says survived — so leveraged results are optimistic, and the page says that too.
 *
 * A holding listed after the window starts JOINS when it lists: until then its weight is spread
 * over the holdings that trade, and on its first day the book is rebalanced to bring it in
 * (opts.listing 'join', the default). opts.listing 'wait' starts only once every holding trades.
 *
 * Strategies (all start fully invested at the weights, except DCA):
 *   hold      buy once, never trade again; winners grow their share
 *   weekly    rebalance to the weights every Monday (UTC)
 *   monthly   rebalance on the 1st of each month
 *   band      rebalance whenever any holding drifts more than `band` (absolute) from its weight
 *   dca       the same capital, invested in equal tranches every Monday; the rest waits as cash
 *   trend     hold each asset only while its close is above its `trendDays`-day average; its
 *             share sits in cash otherwise. Trades only when an asset switches in or out.
 */

import { runBacktest } from './backtest.js'

export const DAY = 86_400_000

export const STRATEGIES = [
  { id: 'hold',    label: 'Buy & hold',        desc: 'Buy the weights once and never trade again. Winners grow their share.' },
  { id: 'monthly', label: 'Rebalance monthly', desc: 'Back to the target weights on the 1st of every month.' },
  { id: 'weekly',  label: 'Rebalance weekly',  desc: 'Back to the target weights every Monday.' },
  { id: 'band',    label: 'Rebalance on drift', desc: 'Rebalance only when a holding drifts more than the band from its weight.' },
  { id: 'dca',     label: 'DCA weekly',        desc: 'The same capital, invested in equal weekly buys instead of all at once.' },
  { id: 'trend',   label: 'Trend filter',      desc: 'Hold each asset only while its price is above its moving average; cash otherwise.' },
]
export const STRATEGY_LABEL = Object.fromEntries(STRATEGIES.map(s => [s.id, s.label]))

/** UTC midnight of a timestamp. */
export const dayOf = (t) => Math.floor(t / DAY) * DAY

/**
 * Signed weights normalised so Σ|w| = 1. Input: [{ key, weight (≥0), side: 'long'|'short' }].
 * Zero or invalid weights are dropped. Returns {} when nothing is left.
 */
export function normalizeWeights(items) {
  const live = (items ?? []).filter(i => i && Number(i.weight) > 0)
  const sum = live.reduce((a, i) => a + Number(i.weight), 0)
  if (!(sum > 0)) return {}
  return Object.fromEntries(live.map(i => [i.key, (i.side === 'short' ? -1 : 1) * Number(i.weight) / sum]))
}

/**
 * candles: { key: [[t, close], …] } (any order, any gaps) → a daily grid.
 * Returns { days, px: { key: number[] (null before the asset's first candle) }, first: { key: t } }.
 */
export function alignDaily(candles, from, to) {
  const keys = Object.keys(candles ?? {})
  const first = {}, maps = {}
  for (const k of keys) {
    const m = new Map()
    for (const [t, c] of (candles[k] ?? [])) { const v = Number(c); if (v > 0) m.set(dayOf(Number(t)), v) }
    maps[k] = m
    first[k] = m.size ? Math.min(...m.keys()) : null
  }
  const days = []
  for (let t = dayOf(from); t <= dayOf(to); t += DAY) days.push(t)
  const px = {}
  for (const k of keys) {
    let last = null
    // Carry forward from before `from`, so a grid that starts on a day with no candle still
    // has the price the asset closed at before it.
    for (const [t, v] of maps[k]) if (t < days[0] && (last == null || t > last.t)) last = { t, v }
    let lastV = last?.v ?? null
    px[k] = days.map(t => { const v = maps[k].get(t); if (v != null) lastV = v; return lastV })
  }
  return { days, px, first }
}

/** The first grid index where EVERY key has a price — a basket cannot be bought before its last listing. */
export function commonStart(px, keys) {
  const n = keys.length ? px[keys[0]].length : 0
  for (let i = 0; i < n; i++) if (keys.every(k => px[k][i] != null)) return i
  return -1
}

/** Trailing simple moving average of a price array (nulls skipped), `n` days, at index i. */
function sma(arr, i, n) {
  let s = 0, c = 0
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (arr[j] != null) { s += arr[j]; c++ }
  return c ? s / c : null
}

/**
 * Run one strategy.
 *   grid: { days, px }, start: index to begin at, weights: signed, Σ|w| = 1
 *   opts: { capital, leverage, feeBps, band (0.05), trendDays (50) }
 * → { id, equity: number[] (from start), fees, trades, rebalances, liquidated: t|null, pnlBy: { key: $ } }
 */
export function simulate(grid, start, weights, id, opts = {}) {
  const { capital = 10_000, leverage = 1, feeBps = 4.5, band = 0.05, trendDays = 50 } = opts
  const keys = Object.keys(weights)
  const { days, px } = grid
  const units = Object.fromEntries(keys.map(k => [k, 0]))
  const pnlBy = Object.fromEntries(keys.map(k => [k, 0]))
  const fee = feeBps / 1e4
  let cash = id === 'dca' ? 0 : capital
  let reserve = id === 'dca' ? capital : 0
  let fees = 0, trades = 0, rebalances = 0, liquidated = null
  const equity = []
  // DCA: one tranche per Monday in the window, the first on day one.
  const dcaDates = id === 'dca' ? days.slice(start).filter((t, j) => j === 0 || new Date(t).getUTCDay() === 1) : []
  const tranche = dcaDates.length ? capital / dcaDates.length : 0
  let active = null

  // A holding not listed yet has no price. Until it has one, the weights of those that do are
  // scaled up to fill the book — its share is spread over them — and the day it lists, every
  // strategy (even buy & hold) trades once to bring it in at its own weight. backtest() starts
  // the run on the first day ANY holding trades (listing: 'join'), or, with listing: 'wait',
  // on the first day they ALL do, in which case nothing here ever lists late.
  const listed = (i) => keys.filter(k => px[k][i] != null)
  const wNow = (live) => {
    const sum = live.reduce((a, k) => a + Math.abs(weights[k]), 0)
    return Object.fromEntries(keys.map(k => [k, sum > 0 && live.includes(k) ? weights[k] / sum : 0]))
  }
  let live = listed(start), w = wNow(live)

  const value = (i) => keys.reduce((a, k) => a + (units[k] ? units[k] * px[k][i] : 0), 0)
  const rebalanceTo = (i, on) => {
    const eq = cash + value(i)
    let traded = false
    for (const k of keys) {
      if (px[k][i] == null) continue
      const target = on && !on[k] ? 0 : leverage * eq * w[k] / px[k][i]
      const d = target - units[k]
      if (Math.abs(d * px[k][i]) < 1e-9) continue
      const notional = Math.abs(d * px[k][i])
      cash -= d * px[k][i] + notional * fee
      fees += notional * fee
      units[k] = target
      trades++; traded = true
    }
    if (traded) rebalances++
  }

  for (let i = start; i < days.length; i++) {
    if (liquidated != null) { equity.push(0); continue }
    // Yesterday's holdings earn today's move, before anything is traded.
    if (i > start) for (const k of keys) if (units[k] && px[k][i - 1] != null) pnlBy[k] += units[k] * (px[k][i] - px[k][i - 1])
    const dt = new Date(days[i])
    const first = i === start
    // Something listed today: the weights widen to include it.
    const nowLive = listed(i)
    const joined = nowLive.length !== live.length
    if (joined) { live = nowLive; w = wNow(live) }
    if (id === 'dca') {
      const due = dcaDates.includes(days[i])
      if (due) { reserve -= tranche; cash += tranche }
      if (due || joined) rebalanceTo(i)
    } else if (id === 'trend') {
      const on = Object.fromEntries(keys.map(k => { const m = sma(px[k], i, trendDays); return [k, px[k][i] != null && (m == null || px[k][i] >= m)] }))
      const changed = first || keys.some(k => on[k] !== active[k])
      active = on
      if (changed) rebalanceTo(i, on)
    } else if (first || joined
      || (id === 'weekly' && dt.getUTCDay() === 1)
      || (id === 'monthly' && dt.getUTCDate() === 1)) {
      if (id !== 'hold' || first || joined) rebalanceTo(i)
    } else if (id === 'band') {
      const eq = cash + value(i)
      const off = eq > 0 && live.some(k => Math.abs(units[k] * px[k][i] / (leverage * eq) - w[k]) > band)
      if (off) rebalanceTo(i)
    }
    const eq = reserve + cash + value(i)
    if (!(eq > 0)) { liquidated = days[i]; equity.push(0); continue }
    equity.push(eq)
  }
  return { id, equity, fees, trades, rebalances, liquidated, pnlBy }
}

/** Return, annualised return, drawdown, volatility, Sharpe, best/worst day — from an equity curve. */
export function metrics(equity, capital) {
  const n = equity.length
  const last = equity[n - 1] ?? 0
  const rets = []
  for (let i = 1; i < n; i++) if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1)
  const mean = rets.length ? rets.reduce((a, r) => a + r, 0) / rets.length : 0
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : 0
  let peak = -Infinity, maxDd = 0
  const dd = equity.map(v => { peak = Math.max(peak, v); const d = peak > 0 ? v / peak - 1 : 0; maxDd = Math.min(maxDd, d); return d })
  const years = (n - 1) / 365
  return {
    final: last,
    ret: capital > 0 ? last / capital - 1 : null,
    // Annualised only over a year or more: a 30-day run "annualised" is a number nobody earned.
    cagr: years >= 1 && capital > 0 && last > 0 ? (last / capital) ** (1 / years) - 1 : null,
    maxDd, dd,
    vol: sd * Math.sqrt(365),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
    best: rets.length ? Math.max(...rets) : null,
    worst: rets.length ? Math.min(...rets) : null,
  }
}

/**
 * Everything the page draws, for one portfolio over one window.
 *   candles: { key: [[t, close]] } (holdings and, optionally, the benchmark key)
 *   items: [{ key, weight, side }], from/to: ms, strategies: ids, opts as simulate, bench: key|null
 * → { days, start (ms), clippedBy: key|null, runs: [{ id, …simulate, …metrics }], bench: run|null, missing: [key] }
 */
export function backtest({ candles, items, from, to, strategies, opts = {}, bench = null }) {
  const weights = normalizeWeights(items)
  const keys = Object.keys(weights)
  const missing = keys.filter(k => !(candles?.[k]?.length))
  if (!keys.length || missing.length) return { days: [], runs: [], bench: null, missing, start: null, clippedBy: null, joined: [] }
  // The grid reaches back for the trend filter's average; the simulation starts at `from`.
  const lookback = (opts.trendDays ?? 50) * DAY
  const grid = alignDaily(candles, from - lookback, to)
  const want = grid.days.findIndex(t => t >= dayOf(from))
  // listing 'join' (the default): start on the first day ANY holding has a price; one listed
  // later joins on its listing day (simulate). 'wait': start when ALL of them do, the old rule —
  // which let one new listing cut a year's test down to the weeks since it appeared.
  const wait = opts.listing === 'wait'
  const anyStart = grid.days.findIndex((_, i) => keys.some(k => grid.px[k][i] != null))
  const common = wait ? commonStart(grid.px, keys) : anyStart
  if (common < 0 || want < 0) return { days: [], runs: [], bench: null, missing, start: null, clippedBy: null, joined: [] }
  const start = Math.max(want, common)
  // Which holding set the start: with 'wait', the one listed last; with 'join', the first.
  const pick = (better) => keys.reduce((a, k) => (better(grid.first[k] ?? 0, grid.first[a] ?? 0) ? k : a), keys[0])
  const clippedBy = start > want ? (wait ? pick((x, y) => x > y) : pick((x, y) => x < y)) : null
  // Holdings that had no price on the first day and came in when they listed.
  const joined = keys.filter(k => grid.px[k][start] == null && grid.first[k] != null).map(k => ({ key: k, t: grid.first[k] })).sort((a, b) => a.t - b.t)
  const capital = opts.capital ?? 10_000
  const runs = (strategies ?? []).map(id => { const r = simulate(grid, start, weights, id, opts); return { ...r, ...metrics(r.equity, capital) } })
  let benchRun = null
  if (bench && candles[bench]?.length) {
    const g = alignDaily({ [bench]: candles[bench] }, grid.days[0], grid.days[grid.days.length - 1])
    if (g.px[bench][start] != null) {
      const r = simulate(g, start, { [bench]: 1 }, 'hold', { ...opts, leverage: 1 })
      benchRun = { ...r, ...metrics(r.equity, capital) }
    }
  }
  return { days: grid.days.slice(start), start: grid.days[start], clippedBy, joined, runs, bench: benchRun, missing: [] }
}

// ── the Simulator's trading strategies, run on every holding ────────────────────────────────
//
// The app's Trade Simulator (src/backtest.js) replays one rule — RSI, MACD, a grid… — on one
// market. A portfolio runs it on EACH holding as its own sub-account, funded with the
// holding's weight of the capital and trading only in the holding's direction (a long-only
// basket is not quietly turned into a short book), then adds the sub-accounts up. That is
// runPortfolio's `absolute` model: each market keeps its own margin, refusals and
// liquidations, and its dollars are summed.
//
// A signal strategy's balance moves when a trade CLOSES, so its curve is realised P&L,
// stepped; a grid or DCA reports its own marked-to-market curve. A trade still open when the
// window ends is not scored, exactly as in the Simulator, and the page says how many.

export const BOT_STRATEGIES = [
  ['trend',      'Trend (bot)'],
  ['volbreak',   'Volatility breakout (bot)'],
  ['supertrend', 'Supertrend'],
  ['emacross',   'EMA crossover'],
  ['macd',       'MACD cross'],
  ['breakout',   'Channel breakout'],
  ['rsi',        'RSI reversal'],
  ['bollinger',  'Bollinger bands'],
  ['grid',       'Grid (bot)'],
  ['dca',        'DCA with safety orders'],
]
export const BOT_LABEL = Object.fromEntries(BOT_STRATEGIES)

/** A step curve [[t, v]] read at each day's close: the last point at or before the day ends. */
export function stepOnDays(points, days, v0) {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  let j = 0, v = v0
  return days.map(t => {
    while (j < pts.length && pts[j][0] < t + DAY) v = pts[j++][1]
    return v
  })
}

/**
 * ohlc: { key: [{ t, o, h, l, c }] } at the chosen interval, already cut to the window.
 * items: [{ key, weight, side }], days: the daily grid to report on.
 * opts: { capital, leverage, feeBps, tp, sl, both (trade both directions) }
 * → { id, equity, fees: null, trades, won, lost, open, refused, liquidated, pnlBy, …metrics }
 */
export function botRun(ohlc, items, days, strategy, opts = {}) {
  const { capital = 10_000, leverage = 1, feeBps = 4.5, tp = 4, sl = 2, both = false } = opts
  const w = normalizeWeights(items)
  const curves = [], pnlBy = {}
  let trades = 0, won = 0, lost = 0, open = 0, refused = 0
  for (const [k, wk] of Object.entries(w)) {
    const bal = capital * Math.abs(wk)
    const side = wk < 0 ? 'short' : 'long'
    const r = runBacktest(ohlc[k] ?? [], {
      strategy, startBalance: bal, leverage, sizePct: 100,
      useFees: true, takerFeePct: feeBps / 100, makerFeePct: Math.min(feeBps / 100, 0.015), feePct: 2 * feeBps / 100,
      takeProfitPct: tp, stopLossPct: sl, useCooldown: false,
      useDirection: !both, direction: side,
      // Ladders sized to the sub-account, not the Simulator's $50 a level.
      gridUsdPerLevel: bal / 10, gridLevels: 10, gridShort: !both && side === 'short',
      dcaSide: side, dcaBaseUsd: bal / 14.2, dcaSoUsd: bal / 14.2,
    })
    const pts = Array.isArray(r.curve) && r.curve.length
      ? r.curve
      : r.trades.filter(t => t.outcome !== 'open' && t.balance != null).map(t => [t.exitAt ?? t.time, t.balance])
    const eq = stepOnDays(pts, days, bal)
    curves.push(eq)
    pnlBy[k] = (eq[eq.length - 1] ?? bal) - bal
    trades += r.tradesMade ?? 0; won += r.won ?? 0; lost += r.lost ?? 0
    open += r.unresolved ?? 0; refused += r.refused ?? 0
  }
  const equity = days.map((_, i) => curves.reduce((a, c) => a + Math.max(0, c[i]), 0))
  return { id: 'bot:' + strategy, equity, fees: null, trades, won, lost, open, refused, rebalances: null, liquidated: null, pnlBy, ...metrics(equity, capital) }
}
