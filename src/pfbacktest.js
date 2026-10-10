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
 *   weekly    rebalance to the weights once a week, on `weekDay` (UTC; Monday by default)
 *   monthly   rebalance once a month, on day `monthDay` (the 1st by default)
 *   band      rebalance whenever any holding drifts more than `band` (absolute) from its weight
 *   dca       the same capital, invested in equal tranches every `dcaEvery` days (7) from day one,
 *             `dcaUpfront` of it on day one as well; the rest waits as cash
 *   trend     hold each asset only while its close is above its `trendDays`-day average; its
 *             share sits in cash otherwise. Trades only when an asset switches in or out. With
 *             `trendBuffer` it switches only once the close is that far past the average.
 * Their settings and defaults: ALLOC_DEFAULTS.
 */

import { runBacktest, strategyKind } from './backtest.js'
import { rateOn, slippage, dailyVol } from './pffunding.js'

export const DAY = 86_400_000
/**
 * The leverage a market is actually run at: what was asked, capped at Hyperliquid's maximum for
 * it — 5× on a market whose maximum is 3× is 3×, because 5× cannot be opened there. 'max' is each
 * market's own maximum. Spot cannot be leveraged on Hyperliquid (1×); an unknown maximum is not
 * capped.
 */
export function effectiveLeverage(asked, maxLev, spot = false) {
  if (spot) return 1
  const cap = maxLev > 0 ? maxLev : Infinity
  if (asked === 'max') return Number.isFinite(cap) ? cap : 1
  const a = Math.max(1, Number(asked) || 1)
  return Math.min(a, cap)
}
/** Maintenance margin when a market's maximum leverage is not known: 1/(2×20). */
export const MMR_DEFAULT = 0.025

export const STRATEGIES = [
  { id: 'hold',    label: 'Buy & hold',        desc: 'Buy the weights once and never trade again. Winners grow their share.' },
  { id: 'monthly', label: 'Rebalance monthly', desc: 'Back to the target weights once a month, on the day you pick.' },
  { id: 'weekly',  label: 'Rebalance weekly',  desc: 'Back to the target weights once a week, on the weekday you pick.' },
  { id: 'band',    label: 'Rebalance on drift', desc: 'Rebalance only when a holding drifts more than the band from its weight.' },
  { id: 'dca',     label: 'DCA',               desc: 'The same capital, invested in equal buys spread over the window instead of all at once.' },
  { id: 'trend',   label: 'Trend filter',      desc: 'Hold each asset only while its price is above its moving average; cash otherwise.' },
]

/**
 * The allocation strategies' own settings and their defaults. Each is read by one strategy only.
 *   monthDay   monthly: day of the month it rebalances (1–28, so every month has one)
 *   weekDay    weekly: 0 Sunday … 6 Saturday
 *   band       band: drift from the weight that triggers a rebalance (0.05 = 5 points)
 *   dcaEvery   dca: days between buys, the first on day one
 *   dcaUpfront dca: share of the capital bought on day one; the rest is split over every buy
 *   trendDays  trend: the moving average, in days
 *   trendBuffer trend: in only above the average by this much, out only below it by this much —
 *              a price hugging its average no longer flips in and out every day
 */
export const ALLOC_DEFAULTS = { monthDay: 1, weekDay: 1, band: 0.05, dcaEvery: 7, dcaUpfront: 0, trendDays: 50, trendBuffer: 0 }
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
  const { capital = 10_000, leverage = 1, feeBps = 4.5, band = 0.05, trendDays = 50, mmr = MMR_DEFAULT, funding = null, book = null, levBy = null, margin = 'cross' } = opts
  const monthDay = Math.min(28, Math.max(1, Math.round(opts.monthDay ?? ALLOC_DEFAULTS.monthDay)))
  const weekDay = Math.min(6, Math.max(0, Math.round(opts.weekDay ?? ALLOC_DEFAULTS.weekDay)))
  const dcaEvery = Math.max(1, Math.round(opts.dcaEvery ?? ALLOC_DEFAULTS.dcaEvery))
  const dcaUpfront = Math.min(1, Math.max(0, opts.dcaUpfront ?? ALLOC_DEFAULTS.dcaUpfront))
  const trendBuffer = Math.max(0, opts.trendBuffer ?? ALLOC_DEFAULTS.trendBuffer)
  const keys = Object.keys(weights)
  // Leverage per market: what was asked, capped at what Hyperliquid allows there (`levBy`, from
  // effectiveLeverage). Without a map, the one figure for every market.
  const levOf = (k) => (levBy && levBy[k] > 0 ? levBy[k] : leverage)
  // Isolated margin: each position carries its own margin and is liquidated on its own, losing
  // only that margin; the rest of the book goes on. Cross (the default): the account is one pool
  // and is liquidated as a whole. `isoMargin` / `isoEntry` are what each position was opened with.
  const isolated = margin === 'isolated'
  const isoMargin = Object.fromEntries(keys.map(k => [k, 0])), isoEntry = Object.fromEntries(keys.map(k => [k, 0]))
  let isoLiqs = 0
  // Funding and slippage (src/pffunding.js). `funding`: { key: fundingInfo } — none for a market
  // without it (spot, or prices that are not Hyperliquid's). `book`: { key: { spreadBps, vol } }
  // turns on slippage for every fill; without it no slippage is charged.
  let fundPaid = 0, slipPaid = 0, fundDays = 0, fundEstDays = 0
  const fundBy = Object.fromEntries(keys.map(k => [k, 0])), slipBy = Object.fromEntries(keys.map(k => [k, 0]))
  // Maintenance margin as a share of each position: Hyperliquid's is half the initial margin at
  // the market's maximum leverage (1/(2×maxLev)). Per market when the caller knows it.
  const mmrOf = (k) => (typeof mmr === 'number' ? mmr : (mmr?.[k] ?? MMR_DEFAULT))
  const { days, px } = grid
  const units = Object.fromEntries(keys.map(k => [k, 0]))
  const pnlBy = Object.fromEntries(keys.map(k => [k, 0]))
  const fee = feeBps / 1e4
  let cash = id === 'dca' ? 0 : capital
  let reserve = id === 'dca' ? capital : 0
  let fees = 0, trades = 0, rebalances = 0, liquidated = null
  const equity = []
  // DCA: a buy every `dcaEvery` days, the first on day one. `dcaUpfront` of the capital goes in on
  // day one as well; the rest is split equally over every buy.
  const dcaDates = id === 'dca' ? days.slice(start).filter((t, j) => j % dcaEvery === 0) : []
  const tranche = dcaDates.length ? capital * (1 - dcaUpfront) / dcaDates.length : 0
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
      const target = on && !on[k] ? 0 : levOf(k) * eq * w[k] / px[k][i]
      const d = target - units[k]
      if (Math.abs(d * px[k][i]) < 1e-9) continue
      const notional = Math.abs(d * px[k][i])
      cash -= d * px[k][i] + notional * fee
      fees += notional * fee
      if (book) {
        const s = slippage(notional, book[k], dailyVol(px[k], i))
        cash -= s; slipPaid += s; slipBy[k] += s
      }
      units[k] = target
      // Isolated: the position is re-margined at its new size — its margin is its value ÷ leverage.
      isoMargin[k] = Math.abs(target * px[k][i]) / levOf(k); isoEntry[k] = px[k][i]
      trades++; traded = true
    }
    if (traded) rebalances++
  }

  for (let i = start; i < days.length; i++) {
    if (liquidated != null) { equity.push(0); continue }
    // Yesterday's holdings earn today's move, before anything is traded.
    if (i > start) for (const k of keys) if (units[k] && px[k][i - 1] != null) pnlBy[k] += units[k] * (px[k][i] - px[k][i - 1])
    // A day of funding on what was held through it: a long pays a positive rate, a short receives.
    if (i > start && funding) {
      let est = false, any = false
      for (const k of keys) {
        if (!units[k] || px[k][i] == null || !funding[k]) continue
        const [r, e] = rateOn(funding[k], days[i])
        if (!r) continue
        const c = units[k] * px[k][i] * r
        cash -= c; fundPaid += c; fundBy[k] += c
        any = true; est = est || e
      }
      if (any) { fundDays++; if (est) fundEstDays++ }
    }
    // Liquidated where the exchange would: equity at or below the maintenance margin of what is
    // open — not at zero. Waiting for zero let a crashed book carry on with a few dollars,
    // re-lever them at the next rebalance and print +1,000% days off a near-empty account.
    // Isolated: a position whose own equity (margin + its move since entry) is at or below its
    // maintenance is closed and its margin lost; the account carries on.
    if (i > start && isolated) {
      for (const k of keys) {
        if (!units[k] || px[k][i] == null) continue
        const own = isoMargin[k] + units[k] * (px[k][i] - isoEntry[k])
        if (own <= Math.abs(units[k] * px[k][i]) * mmrOf(k)) {
          // Sold at the close; the account loses exactly this position's margin — what was left of it
          // goes with it, and a loss past it (own < 0) is the liquidator's, not the account's.
          cash += units[k] * px[k][i] - own
          units[k] = 0; isoMargin[k] = 0; isoLiqs++
        }
      }
    }
    if (i > start) {
      const eqNow = reserve + cash + value(i)
      const maint = keys.reduce((a, k) => a + (units[k] && px[k][i] != null ? Math.abs(units[k] * px[k][i]) * mmrOf(k) : 0), 0)
      if (!(eqNow > maint)) { liquidated = days[i]; equity.push(0); continue }
    }
    const dt = new Date(days[i])
    const first = i === start
    // Something listed today: the weights widen to include it.
    const nowLive = listed(i)
    const joined = nowLive.length !== live.length
    if (joined) { live = nowLive; w = wNow(live) }
    if (id === 'dca') {
      // A buy day with nothing left to put in (all of it went in up front) is not a trading day.
      const due = dcaDates.includes(days[i]) && (tranche > 0 || first)
      const amt = tranche + (first ? capital * dcaUpfront : 0)
      if (due) { reserve -= amt; cash += amt }
      if (due || joined) rebalanceTo(i)
    } else if (id === 'trend') {
      // With a buffer, between the two lines it keeps whatever it was doing.
      const on = Object.fromEntries(keys.map(k => {
        const m = sma(px[k], i, trendDays), p = px[k][i]
        if (p == null) return [k, false]
        if (m == null) return [k, true]
        if (!trendBuffer || first || !active) return [k, p >= m]
        return [k, p >= m * (1 + trendBuffer) ? true : p < m * (1 - trendBuffer) ? false : !!active[k]]
      }))
      const changed = first || keys.some(k => on[k] !== active[k])
      active = on
      if (changed) rebalanceTo(i, on)
    } else if (first || joined
      || (id === 'weekly' && dt.getUTCDay() === weekDay)
      || (id === 'monthly' && dt.getUTCDate() === monthDay)) {
      if (id !== 'hold' || first || joined) rebalanceTo(i)
    } else if (id === 'band') {
      const eq = cash + value(i)
      const off = eq > 0 && live.some(k => Math.abs(units[k] * px[k][i] / (levOf(k) * eq) - w[k]) > band)
      if (off) rebalanceTo(i)
    }
    const eq = reserve + cash + value(i)
    if (!(eq > 0)) { liquidated = days[i]; equity.push(0); continue }
    equity.push(eq)
  }
  return { id, equity, fees, trades, rebalances, liquidated, isoLiqs, pnlBy, funding: funding ? fundPaid : null, slippage: book ? slipPaid : null, fundDays, fundEstDays, fundBy, slipBy }
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
    // Not below 0.5% annual volatility: a near-flat curve divides by almost nothing and prints
    // Sharpes of -143 that describe rounding, not a strategy.
    sharpe: sd * Math.sqrt(365) > 0.005 ? (mean / sd) * Math.sqrt(365) : null,
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
      // "BTC, held" is owning it: no leverage, no funding, no slippage — the plain reference.
      const r = simulate(g, start, { [bench]: 1 }, 'hold', { ...opts, leverage: 1, levBy: null, margin: 'cross', funding: null, book: null })
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
 * A Simulator strategy on every holding, each its own sub-account, summed. → a run like
 * simulate()'s, with trades, wins, fees and a DAILY equity curve.
 *
 * Three things this used to get wrong, each of which flattered or distorted the result:
 *
 *  1. OPEN POSITIONS WERE INVISIBLE. The curve moved only when a trade closed, so the Trend bot
 *     and Supertrend — always in a position — showed neither the drawdown of the trade they
 *     were in nor its result at the end. Every day is now marked to market: the balance after
 *     the last closed trade, plus each open position's move from its entry, less its open fee.
 *  2. COLD INDICATORS. The candles were cut at the window's start, so a 50-candle average had
 *     nothing to average for its first 50 candles inside the window. Signal and flip strategies
 *     now get the history before the window (`ohlc` should carry it); the run is valued from the
 *     window's first day, scaled so each sub-account starts with its share of the capital — as if
 *     the strategy had been running and you joined it then. Grid and DCA need no history and
 *     are given none (their ladders are set from the first price they see).
 *  3. FEES WERE "IN RESULT". They always were taken — every fill paid — but never shown. They are
 *     now summed from the trades the way the engine charged them: taker to open; to close, maker
 *     on a signal strategy's take-profit (a resting order) and taker otherwise. Grid and DCA
 *     report their own fee totals; inside a window those are pro-rated by the fills in it.
 */
/**
 * Which settings each trading strategy reads, as the Trade Simulator's own field list says
 * (src/backtest.js BT_FIELDS), and the defaults the portfolio page uses for them. A setting
 * not listed for a strategy does nothing to it — the page shows each strategy only its own.
 *
 * Take profit / stop loss as percentages belong to the five plain signal rules. The Volatility
 * breakout sets both as multiples of its rolling range; the Trend bot and Supertrend have only a
 * stop; Grid and DCA their own ladders. 'off' on a percentage exit means it never fires (the
 * trade closes on the strategy's other exits, or is held to the end).
 */
export const PCT_EXITS = ['breakout', 'rsi', 'bollinger', 'macd', 'emacross']
export const BOT_PARAM_DEFAULTS = {
  takeProfitPct: 4, stopLossPct: 2,
  gridRangePct: 10, gridLevels: 10,
  dcaSoCount: 5, dcaStepPct: 1.5, dcaStepScale: 1.2, dcaVolScale: 1.5, dcaTpPct: 1.5, dcaSlPct: 0,
}
const OFF = 1e6                      // a percentage no candle reaches
export function botParams(strategy, params = {}, bal = 1000, side = 'long', both = false) {
  const p = { ...params }
  if (PCT_EXITS.includes(strategy)) {
    p.takeProfitPct = params.tpOff ? OFF : (params.takeProfitPct ?? BOT_PARAM_DEFAULTS.takeProfitPct)
    p.stopLossPct = params.slOff ? OFF : (params.stopLossPct ?? BOT_PARAM_DEFAULTS.stopLossPct)
  }
  delete p.tpOff; delete p.slOff
  if (strategy === 'grid') {
    const n = Math.max(2, Math.round(params.gridLevels ?? BOT_PARAM_DEFAULTS.gridLevels))
    // Ladders sized to the holding's share of the capital, not the Simulator's $50 a rung.
    Object.assign(p, { gridLevels: n, gridRangePct: params.gridRangePct ?? BOT_PARAM_DEFAULTS.gridRangePct, gridUsdPerLevel: bal / n, gridShort: !both && side === 'short' })
  }
  if (strategy === 'dca') {
    const n = Math.max(0, Math.round(params.dcaSoCount ?? BOT_PARAM_DEFAULTS.dcaSoCount))
    const vs = params.dcaVolScale ?? BOT_PARAM_DEFAULTS.dcaVolScale
    // The base order and every safety order fit inside the holding's share when all are filled.
    const units = 1 + Array.from({ length: n }, (_, j) => vs ** j).reduce((a, v) => a + v, 0)
    Object.assign(p, { dcaSide: side, dcaSoCount: n, dcaVolScale: vs, dcaBaseUsd: bal / units, dcaSoUsd: bal / units,
      dcaStepPct: params.dcaStepPct ?? BOT_PARAM_DEFAULTS.dcaStepPct, dcaStepScale: params.dcaStepScale ?? BOT_PARAM_DEFAULTS.dcaStepScale,
      dcaTpPct: params.dcaTpPct ?? BOT_PARAM_DEFAULTS.dcaTpPct, dcaSlPct: params.dcaSlPct ?? BOT_PARAM_DEFAULTS.dcaSlPct })
  }
  return p
}

export function botRun(ohlc, items, days, strategy, opts = {}) {
  const { capital = 10_000, leverage = 1, feeBps = 4.5, both = false, funding = null, book = null, levBy = null, margin = 'cross', params = {} } = opts
  const w = normalizeWeights(items)
  const curves = [], pnlBy = {}
  let trades = 0, won = 0, lost = 0, open = 0, refused = 0, fees = 0
  let fundPaid = 0, slipPaid = 0, fundDays = 0, fundEstDays = 0
  const start = days[0], end = days[days.length - 1] + DAY - 1
  const kind = strategyKind(strategy)
  const ladder = kind === 'grid' || kind === 'dca'
  const takerR = feeBps / 1e4, makerR = Math.min(feeBps, 1.5) / 1e4
  for (const [k, wk] of Object.entries(w)) {
    const bal = capital * Math.abs(wk)
    const side = wk < 0 ? 'short' : 'long'
    const fees0 = fees, fund0 = fundPaid, slip0 = slipPaid
    const rows = (ohlc[k] ?? []).filter(c => c.t <= end && (!ladder || c.t >= start))
    const sp = botParams(strategy, params, bal, side, both)
    const lev = levBy && levBy[k] > 0 ? levBy[k] : leverage
    const r = runBacktest(rows, {
      ...sp,
      strategy, startBalance: bal, leverage: lev, maxLev: Math.max(1, lev), marginMode: margin, sizePct: 100,
      useFees: true, takerFeePct: feeBps / 100, makerFeePct: Math.min(feeBps / 100, 0.015), feePct: 2 * feeBps / 100,
      useCooldown: false, useDirection: !both, direction: side,
    })
    // Closes by time, for marking an open position at any moment.
    const cs = rows.map(c => [c.t, c.c]).sort((a, b) => a[0] - b[0])
    const closeAt = (T) => { let lo = 0, hi = cs.length - 1, v = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m][0] <= T) { v = cs[m][1]; lo = m + 1 } else hi = m - 1 } return v }
    const tr = r.trades ?? []
    const valueAt = (T) => {
      if (ladder && Array.isArray(r.curve) && r.curve.length) {
        let v = bal
        for (const [t, e] of r.curve) { if (t <= T) v = e; else break }
        return v
      }
      let balance = bal, lastExit = -Infinity, upnl = 0
      for (const t of tr) {
        const closed = t.outcome !== 'open' && t.exitAt != null && t.exitAt <= T
        if (closed) { if (t.exitAt >= lastExit) { lastExit = t.exitAt; balance = t.balance } continue }
        if (t.time <= T && t.q > 0) {
          const px = closeAt(T)
          if (px != null) upnl += (t.side === 'short' ? -1 : 1) * t.q * (px - t.entry) - t.q * t.entry * takerR
        }
      }
      return balance + upnl
    }
    // Valued from the window: whatever the strategy did in its warm-up only sets where it stands.
    const v0 = valueAt(start - 1)
    const scale = v0 > 0 ? bal / v0 : 1
    // Funding and slippage, which the Simulator's engine does not charge: worked out from its
    // trades and taken off this sub-account's curve as they fall due (src/pffunding.js).
    // Funding: each day a position is open at the close, side × size × that close × the day's
    // rate. Slippage: every fill in the window, by the market's spread and the order's size
    // next to its volume.
    const cost = new Array(days.length).fill(0)
    if (funding?.[k] || book) {
      const dailyCl = days.map(d => closeAt(d + DAY - 1))
      for (let i = 0; i < days.length; i++) {
        const dEnd = days[i] + DAY - 1
        let c = 0
        if (funding?.[k]) {
          const [rate, est] = rateOn(funding[k], days[i])
          if (rate && dailyCl[i] != null) {
            let held = false
            for (const t of tr) if (t.q > 0 && t.time <= dEnd && (t.outcome === 'open' || (t.exitAt ?? Infinity) > dEnd)) { c += (t.side === 'short' ? -1 : 1) * t.q * dailyCl[i] * rate; held = true }
            if (held) { fundDays++; if (est) fundEstDays++ }
          }
          fundPaid += c * scale
        }
        cost[i] = c
      }
      if (book) {
        const at = (T) => { const i = days.findIndex(d => d + DAY - 1 >= T); return i < 0 ? -1 : i }
        for (const t of tr) {
          if (!(t.q > 0)) continue
          const fills = [[t.time, t.q * t.entry]]
          if (t.outcome !== 'open' && t.exitAt != null && t.exitPx != null) fills.push([t.exitAt, t.q * t.exitPx])
          for (const [T, n] of fills) {
            const i = at(T)
            if (T < start || i < 0) continue
            const s = slippage(n, book[k], dailyVol(dailyCl, i))
            cost[i] += s; slipPaid += s * scale
          }
        }
      }
      for (let i = 1; i < cost.length; i++) cost[i] += cost[i - 1]
    }
    const eq = days.map((d, i) => Math.max(0, (valueAt(d + DAY - 1) - cost[i]) * scale))
    curves.push(eq)
    const inWin = tr.filter(t => (t.exitAt ?? Infinity) >= start || t.outcome === 'open')
    trades += inWin.length
    won += inWin.filter(t => t.outcome === 'win' || (t.outcome === 'timeout' && t.delta > 0)).length
    lost += inWin.filter(t => t.outcome === 'loss' || (t.outcome === 'timeout' && t.delta < 0)).length
    open += tr.filter(t => t.outcome === 'open').length
    refused += r.refused ?? 0
    if (ladder) {
      const total = r.grid?.fees ?? r.dca?.fees ?? 0
      fees += total                         // ladders run inside the window only, so all of it counts
    } else {
      for (const t of tr) {
        if (!(t.q > 0)) continue
        if (t.time >= start) fees += t.q * t.entry * takerR * scale
        if (t.outcome !== 'open' && t.exitPx != null && t.exitAt != null && t.exitAt >= start) {
          const maker = kind === 'signal' && t.outcome === 'win' && !t.liq
          fees += t.q * t.exitPx * (maker ? makerR : takerR) * scale
        }
      }
    }
    // What the holding did at market, before costs — the costs are their own rows, as in an
    // allocation run, so the rows add up to the result instead of counting the costs twice.
    pnlBy[k] = (curves[curves.length - 1].at(-1) ?? bal) - bal + (fees - fees0) + (fundPaid - fund0) + (slipPaid - slip0)
  }
  const equity = days.map((_, i) => curves.reduce((a, c) => a + c[i], 0))
  return { id: 'bot:' + strategy, equity, fees, feesEstimated: true, trades, won, lost, open, refused, rebalances: null, liquidated: null, pnlBy,
    funding: funding ? fundPaid : null, slippage: book ? slipPaid : null, fundDays, fundEstDays, ...metrics(equity, capital) }
}

