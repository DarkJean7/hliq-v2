/**
 * Backtest: replay a rule over historical candles and report what it would have done.
 *
 * Pure. Candles in, result out -- no fetching, no DOM, no timers. The app hands it
 * Hyperliquid candles; the arithmetic here has no idea where they came from.
 *
 * STRUCTURE. A run is one ENTRY STRATEGY plus any number of MODULES that can each be
 * switched off independently. That split is what makes the thing worth having: the useful
 * question is almost never "did this work" but "which part of this was doing the work",
 * and the only way to answer it is to turn pieces off one at a time.
 *
 * FOUR THINGS THAT WOULD OTHERWISE FLATTER THE RESULT, handled rather than inherited. A
 * backtest exists to say whether something worked; one that quietly cheats is worse than
 * none, because it gets believed.
 *
 *   1. LOOKAHEAD. Nothing reads a candle it could not have seen. Baselines and indicators
 *      come from PRIOR candles only, and a candle is never part of its own baseline.
 *      Whole-sample is selectable purely so the cost of that assumption can be measured,
 *      and the result says so when it is used.
 *   2. AMBIGUOUS CANDLES. When one candle covers both the target and the stop, which came
 *      first is unknowable from OHLC. The default counts the stop.
 *   3. PRICE-RELATIVE LEVELS. Targets and stops are percentages of entry, not fixed
 *      amounts, so a setting means the same on a $0.004 market and a $78,000 one.
 *   4. FILLS ARE ASSUMED PERFECT. Entry at the close, stop exactly at its level, no gaps
 *      and no slippage. Real fills are worse than all three, so a result is an upper bound.
 */

export const BT_DEFAULTS = {
  // ── what opens a trade ──────────────────────────────────────────────────
  strategy: 'range',      // see BT_STRATEGIES
  entryCategory: 3,       // range: candle must be this many times the baseline
  baselineLookback: 200,  // range: candles of PAST history for the baseline; 0 = whole sample

  // volbreak -- the Volatility Breakout bot's own flags, same names and defaults
  vbLookback: 20,         // candles in the rolling average
  vbThreshold: 3,         // |category| needed to fire
  vbTpMult: 2,            // take profit, multiples of the rolling average RANGE
  vbSlMult: 1,            // stop, multiples of the rolling average range

  // trend -- the Trend bot
  emaFast: 9,
  emaSlow: 21,
  trendStopPct: 2,        // it only closes a losing side when this is hit

  breakoutLookback: 20,   // breakout: prior candles whose high/low must be cleared

  // grid -- the Grid bot's own flags
  gridLower: 0,           // 0 = auto, from the first candle
  gridUpper: 0,
  gridRangePct: 10,       // auto range: first close +/- this
  gridLevels: 10,
  gridUsdPerLevel: 50,
  gridGeometric: false,   // even % gaps instead of even price gaps
  gridShort: false,       // sell first and buy back lower
  gridSameCandle: 'skip', // 'skip' | 'allow' -- a round trip inside one candle

  // ── what closes it ──────────────────────────────────────────────────────
  takeProfitPct: 1.0,
  stopLossPct: 0.5,
  ambiguous: 'loss',      // 'loss' | 'win'

  // ── the money ───────────────────────────────────────────────────────────
  startBalance: 1000,
  pnlModel: 'notional',   // 'notional' | 'fixed' | 'risk'
  winPct: 4,              // fixed: % of balance gained on a win
  lossPct: 2,             // fixed: % of balance lost on a stop
  riskPct: 1,             // risk: % of balance lost AT THE STOP; the win follows the ratio
  useFees: true,
  feePct: 0.09,           // round trip: Hyperliquid's base taker fee is 0.045% each way

  // ── modules, each independently switchable ──────────────────────────────
  useCooldown: true,
  cooldownCandles: 4,

  useDirection: false,
  direction: 'both',      // 'both' | 'long' | 'short'

  useTrendFilter: false,  // only trade with the longer trend
  trendMa: 50,

  useTimeExit: false,     // give up on a trade that goes nowhere
  timeExitCandles: 24,

  useTrailing: false,     // move the stop up behind the best price reached
  trailPct: 0.5,

  useMaxLosses: false,    // stop the whole run after a losing streak
  maxConsecLosses: 3,

  // Tokyo Partners. The defaults are ZEC's row from the portfolio table -- a real pair of
  // windows rather than placeholder hours, so a first run says something.
  tokyoLongFrom:  '07:00',
  tokyoLongTo:    '21:00',
  tokyoShortFrom: '21:00',
  tokyoShortTo:   '07:00',
  tokyoStopPct:   0,      // the deployed bot has none; 0 is off

  // Several markets on one account: divide each stake by how many, the way the deployed
  // portfolio bot does. Off answers a different question, and a much louder one.
  splitRisk: true,

  // ── the common retail bots ──────────────────────────────────────────────
  // rsi -- mean reversion on Wilder's RSI
  rsiLen: 14,
  rsiLow: 30,
  rsiHigh: 70,

  // bollinger -- bands of `bbMult` standard deviations around a `bbLen` average
  bbLen: 20,
  bbMult: 2,
  bbMode: 'revert',       // 'revert' fades a close outside the band | 'breakout' follows it

  // macd -- the MACD line crossing its signal line
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // emacross -- a crossing EVENT with a target and stop (the Trend bot holds a STATE instead)
  crossFast: 9,
  crossSlow: 21,

  // supertrend -- ATR bands that flip the side; always in a position, like the Trend bot
  stLen: 10,
  stMult: 3,
  stStopPct: 0,           // 0 = none: it is closed by the flip, not a price

  // dca -- a base order plus safety orders that average down, closed at a target
  dcaSide: 'long',
  dcaBaseUsd: 100,
  dcaSoUsd: 100,
  dcaSoCount: 5,
  dcaStepPct: 1.5,        // first safety order this far from the base price
  dcaStepScale: 1.2,      // each gap after that is this much wider
  dcaVolScale: 1.5,       // each safety order is this much larger than the one before
  dcaTpPct: 1.5,          // from the AVERAGE entry, which is the whole point of averaging
  dcaSlPct: 0,            // from the average entry; 0 = none, which is how most are run

  // One position per market at a time, the way every deployed bot runs. Off lets a new
  // signal open a second trade while the first is still running -- which, sized at the
  // whole balance, is leverage nobody set.
  useOnePos: true,

  // notional sizing -- the way an exchange actually pays: a position worth sizePct of the
  // balance times the leverage, gaining or losing exactly what the price moved.
  sizePct: 100,
  leverage: 1,

  // The Hyperliquid account around every position -- see HYPERLIQUID ACCOUNT MECHANICS.
  marginMode: 'cross',    // 'cross' | 'isolated' -- cross is Hyperliquid's own default
  sizeMode: 'pct',        // 'pct' of balance as margin | 'usd' position value | 'coin' amount
  sizeUsd: 1000,
  sizeCoin: 1,
  orderUnit: 'usd',       // grid and DCA order sizes: 'usd' | 'coin'
  makerFeePct: 0.015,     // per fill, Hyperliquid base tier
  takerFeePct: 0.045,
  // The market's max leverage. Not a setting: the app passes each market's own, because it
  // decides the maintenance margin. 20 stands in only when it is not known.
  maxLev: 20,
}

/**
 * How each strategy is shaped, which decides which parts of the form apply to it.
 *
 *   signal -- an entry rule plus a target and a stop; every module applies.
 *   flip   -- always in a position, turned over by the rule itself. Entry modules have
 *             nothing to act on in something that never sits out.
 *   grid / dca -- dollar-sized ladders with their own walk. They pay in dollars, not in a
 *             share of the balance, so the money model does not apply either.
 *
 * `bot` marks the ones that are the deployed bots' own rules rather than textbook versions.
 */
export const BT_STRATEGY_META = {
  volbreak:   { cat: 'breakout', kind: 'signal', bot: true,  tag: 'Huge candle → trade its way' },
  trend:      { cat: 'trend',    kind: 'flip',   bot: true,  tag: 'EMA state, holds losers to the stop' },
  range:      { cat: 'breakout', kind: 'signal', bot: false, tag: 'Unusual candle, % target and stop' },
  grid:       { cat: 'grid',     kind: 'grid',   bot: true,  tag: 'Ladder that earns the chop' },
  tokyo:      { cat: 'clock',    kind: 'flip',   bot: true,  tag: 'Long/short by the hour, NY time' },
  breakout:   { cat: 'breakout', kind: 'signal', bot: false, tag: 'Close beyond the N-candle channel' },
  rsi:        { cat: 'revert',   kind: 'signal', bot: false, tag: 'Buy oversold, sell overbought' },
  bollinger:  { cat: 'revert',   kind: 'signal', bot: false, tag: 'Fade or follow the bands' },
  macd:       { cat: 'trend',    kind: 'signal', bot: false, tag: 'MACD crosses its signal line' },
  emacross:   { cat: 'trend',    kind: 'signal', bot: false, tag: 'Fast EMA crosses the slow one' },
  supertrend: { cat: 'trend',    kind: 'flip',   bot: false, tag: 'ATR bands flip the side' },
  dca:        { cat: 'grid',     kind: 'dca',    bot: false, tag: 'Safety orders average the entry' },
}

export const BT_CATEGORIES = [
  ['all', 'All'], ['trend', 'Trend'], ['revert', 'Mean reversion'],
  ['breakout', 'Breakout'], ['grid', 'Grid & DCA'], ['clock', 'Clock'],
]

/** The strategy's shape, defaulting to a plain signal rule for anything unlisted. */
export function strategyKind(key) { return BT_STRATEGY_META[key]?.kind ?? 'signal' }

export const BT_STRATEGIES = [
  ['volbreak', 'Volatility Breakout (bot)',
   'The real bot. A closed candle whose range is a large multiple of the rolling average opens a trade in its direction, with the target and stop set as multiples of that same average range -- so both scale with volatility instead of being fixed percentages.'],
  ['trend', 'Trend (bot)',
   'The real bot. It is ALWAYS in a position: long while the fast EMA is above the slow one, short while it is below, flipping when that changes. It refuses to flip out of a losing position unless its stop is hit, which is the behaviour that most shapes its results.'],
  ['range', 'Range category (original script)',
   'The rule from the Python simulator this screen came from: an unusually large candle opens a trade its way, with the target and stop as percentages of the entry price.'],
  ['grid', 'Grid (bot)',
   'The real bot. A ladder of resting buys across a price range: when one fills, a sell is armed one level up, and when THAT fills the buy is re-armed. It earns the gap between levels every time price crosses back and forth, and accumulates a position when price leaves the range.'],
  ['tokyo', 'Tokyo Partners (hourly windows)',
   'Two fixed windows on the clock per market: long inside one, short inside the other, flat if they overlap. It is ALWAYS in a position outside those gaps and never looks at price to decide -- only at the hour, in New York time. The windows come from the portfolio table when the market is in it, and can be typed for anything else.'],
  ['breakout', 'Channel breakout',
   'A close beyond the highest high or lowest low of the previous N candles opens a trade that way. Not one of the deployed bots -- a plain comparison rule.'],
  ['rsi', 'RSI reversal',
   'Mean reversion on Wilder\'s RSI. A long opens when RSI climbs back ABOVE the oversold line, a short when it falls back BELOW the overbought one -- waiting for the turn rather than buying the moment it is low, which is the version that does not catch every falling knife on the way down.'],
  ['bollinger', 'Bollinger bands',
   'Bands a number of standard deviations either side of a moving average. Revert mode fades a close outside a band, betting it snaps back to the middle; breakout mode follows it, betting the stretch is the start of a move. Same bands, opposite bets -- running both is the fastest way to learn which kind of market you are in.'],
  ['macd', 'MACD cross',
   'The MACD line (fast EMA minus slow EMA) crossing its own signal line opens a trade that way. The classic momentum trigger, closed by the target and stop below rather than by the next cross.'],
  ['emacross', 'EMA crossover',
   'The fast EMA crossing the slow one opens a trade in the direction of the cross, closed by the target and stop. Unlike the Trend bot it acts on the CROSS, not the state, and sits out between signals.'],
  ['supertrend', 'Supertrend',
   'Bands an ATR multiple above and below the candle midpoint that ratchet with price. A close through the band flips the side. Always in a position, like the Trend bot, but it flips losers too -- the band is the stop.'],
  ['dca', 'DCA with safety orders',
   'The most common retail bot. A base order opens the deal; if price moves against it, safety orders buy more at wider and wider gaps, dragging the average entry toward price. The deal closes at a target measured from that AVERAGE, then a new one starts. It wins almost every deal -- until price runs past the last safety order and the whole stack sits underwater.'],
]

/**
 * Bots this engine cannot honestly simulate, and why. Listed rather than omitted: a
 * missing name reads as an oversight, and someone would reasonably assume the ones shown
 * are all there are.
 */
export const BT_UNSIMULATABLE = [
  ['Outcome Grid', 'A grid over prediction-market outcomes, which settle to 0 or 1 rather than trading continuously. The price series this reads does not describe them.'],
  ['TWAP', 'An execution algorithm -- it splits an order over time rather than deciding when to trade. There is no win or loss to measure.'],
  ['Accumulator', 'Buys spot on a schedule. Nothing here opens or closes against a target.'],
  ['Copy Trade', 'Mirrors another wallet, so its results depend on the fills of that wallet rather than on candles.'],
  ['Liq Guard / Leverage Brake', 'Risk guards. They never open a position, only reduce one.'],
]

/**
 * The Tokyo Partners portfolio: two windows per market, found by sweeping every entry and
 * exit hour over ~200 days of 1h candles and keeping the pair with the best net PnL.
 *
 * Held here so the simulator can prefill the windows for a market that is in it. The
 * numbers are the strategy; typing them by hand for the wrong market is how you simulate
 * something nobody proposed.
 *
 * `market` is the id the EXCHANGE uses, which is not the key. Nine of these live on the
 * xyz builder dex, where the bare ticker is not a market at all -- asking for candles for
 * "SMSN" is a 500 and "xyz:SMSN" is the market. The key stays bare so a row can be found
 * by ticker however it is typed; anything that goes to the API must use `market`.
 */
export const BT_TOKYO_TABLE = {
  ZEC:     { market: 'ZEC', long: ['07:00', '21:00'], short: ['21:00', '07:00'], weight: 11.06 },
  CASHCAT: { market: 'CASHCAT', long: ['02:00', '19:00'], short: ['19:00', '07:00'], weight:  9.93 },
  SMSN:    { market: 'xyz:SMSN', long: ['23:00', '18:00'], short: ['18:00', '23:00'], weight:  8.72 },
  SKHX:    { market: 'xyz:SKHX', long: ['04:00', '17:00'], short: ['17:00', '23:00'], weight:  8.27 },
  LIT:     { market: 'LIT', long: ['00:00', '18:00'], short: ['19:00', '00:00'], weight:  7.84 },
  XMR:     { market: 'XMR', long: ['16:00', '06:00'], short: ['06:00', '16:00'], weight:  7.50 },
  SNDK:    { market: 'xyz:SNDK', long: ['23:00', '21:00'], short: ['21:00', '23:00'], weight:  7.40 },
  EWY:     { market: 'xyz:EWY', long: ['23:00', '19:00'], short: ['19:00', '23:00'], weight:  6.20 },
  MU:      { market: 'xyz:MU', long: ['23:00', '21:00'], short: ['21:00', '23:00'], weight:  6.13 },
  NEAR:    { market: 'NEAR', long: ['20:00', '17:00'], short: ['17:00', '20:00'], weight:  5.76 },
  DRAM:    { market: 'xyz:DRAM', long: ['23:00', '19:00'], short: ['19:00', '23:00'], weight:  5.31 },
  PUMP:    { market: 'PUMP', long: ['20:00', '18:00'], short: ['18:00', '20:00'], weight:  4.99 },
  INTC:    { market: 'xyz:INTC', long: ['09:00', '05:00'], short: ['05:00', '09:00'], weight:  4.67 },
  SPCX:    { market: 'xyz:SPCX', long: ['23:00', '03:00'], short: ['03:00', '23:00'], weight:  3.35 },
  SOXL:    { market: 'xyz:SOXL', long: ['14:00', '03:00'], short: ['03:00', '15:00'], weight:  2.86 },
}

/** The table row for a market id, with or without its builder-dex prefix. */
/** Every market in the portfolio, as the exchange names them. */
export function tokyoMarkets() {
  return Object.values(BT_TOKYO_TABLE).map(r => r.market)
}

export function tokyoWindowsFor(coin) {
  const base = String(coin ?? '').split(':').pop().toUpperCase()
  return BT_TOKYO_TABLE[base] ?? null
}

// The windows are New York hours and the daylight-saving shift is part of them: they were
// found in that zone, so applying them at a fixed UTC offset would put them half an hour
// out for half the year. One formatter, reused -- building one per candle is the
// difference between a run that takes a moment and one that takes a minute.
export const BT_TOKYO_ZONE = 'America/New_York'
let _tzFmt = null, _tzFmtFor = null
function zoneMinute(ms, zone) {
  if (_tzFmtFor !== zone) {
    try {
      _tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
      _tzFmtFor = zone
    } catch { _tzFmt = null; _tzFmtFor = zone }
  }
  if (!_tzFmt) return null
  const parts = _tzFmt.formatToParts(new Date(ms))
  // Some engines report midnight as "24". % 24 keeps it at the start of the day.
  const hh = Number(parts.find(x => x.type === 'hour')?.value) % 24
  const mm = Number(parts.find(x => x.type === 'minute')?.value)
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : null
}

/** "07:00" -> 420. NaN for anything that is not a time. */
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return NaN
  const hh = Number(m[1]), mm = Number(m[2])
  if (hh > 23 || mm > 59) return NaN
  return hh * 60 + mm
}

/** Inside [from, to), where a `to` earlier than `from` crosses midnight. */
export function inWindow(min, from, to) {
  const a = hhmmToMinutes(from), b = hhmmToMinutes(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || min == null) return false
  if (a === b) return false                 // a zero-width window is closed, not always-open
  return b > a ? (min >= a && min < b) : (min >= a || min < b)
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN }

/** [{t,o,h,l,c}] with strings or numbers -> numeric rows, junk dropped. */
export function normalise(candles) {
  const out = []
  for (const k of candles ?? []) {
    const t = num(k.t ?? k.time), o = num(k.o), h = num(k.h), l = num(k.l), c = num(k.c)
    if (![t, o, h, l, c].every(Number.isFinite)) continue
    if (h < l) continue
    out.push({ t, o, h, l, c, range: h - l, red: c < o })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * How large each candle is against its baseline, signed by direction: +3 is a large green
 * candle, -3 a large red one. Null while there is not enough history to judge it, which is
 * different from 0 and must not be traded on.
 */
export function classify(rows, { baselineLookback = 200 } = {}) {
  const out = new Array(rows.length).fill(null)
  const whole = baselineLookback === 0
  const wholeAvg = whole && rows.length ? rows.reduce((a, r) => a + r.range, 0) / rows.length : 0
  let runningSum = 0
  for (let i = 0; i < rows.length; i++) {
    let avg
    if (whole) {
      // Every candle in the set, including ones after this trade. Kept only so the cost of
      // that assumption can be measured; it is not a baseline anyone could have had.
      avg = wholeAvg
    } else {
      runningSum += rows[i].range
      if (i > baselineLookback) runningSum -= rows[i - baselineLookback - 1].range
      const n = Math.min(i, baselineLookback)
      if (n < 10) { out[i] = null; continue }   // too little history to call anything large
      avg = (runningSum - rows[i].range) / n    // the candle itself is not in its own baseline
    }
    if (!(avg > 0)) { out[i] = null; continue }
    const mult = rows[i].range / avg
    const cat = mult >= 6 ? 6 : mult >= 5 ? 5 : mult >= 4 ? 4 : mult >= 3 ? 3 : mult >= 2 ? 2 : mult >= 1 ? 1 : 0
    out[i] = rows[i].red ? -cat : cat
  }
  return out
}

/**
 * Rolling average of the RANGE of the n candles strictly before each one. Null until there
 * are that many. The Volatility Breakout bot uses this for both jobs -- deciding a candle
 * is unusual, and setting the levels -- so it is computed once and shared, exactly as the
 * bot does it.
 */
export function avgRangeSeries(rows, n) {
  const out = new Array(rows.length).fill(null)
  let sum = 0
  for (let i = 0; i < rows.length; i++) {
    if (i >= n) {
      out[i] = sum / n
      sum -= rows[i - n].range
    }
    sum += rows[i].range
  }
  return out
}

/** EMA over closes, aligned; null until the period is filled. */
function ema(rows, n) {
  const out = new Array(rows.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null
  for (let i = 0; i < rows.length; i++) {
    prev = prev == null ? rows[i].c : rows[i].c * k + prev * (1 - k)
    if (i >= n - 1) out[i] = prev
  }
  return out
}

/** SMA over closes, aligned. */
function sma(rows, n) {
  const out = new Array(rows.length).fill(null)
  let sum = 0
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].c
    if (i >= n) sum -= rows[i - n].c
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

/**
 * Wilder's RSI over closes. Null until `n` changes have been seen -- the first value is a
 * plain average of those, every later one is smoothed, which is how every charting package
 * computes it and so the only version whose 30 and 70 mean what a trader expects.
 */
export function rsiSeries(rows, n) {
  const out = new Array(rows.length).fill(null)
  let ag = 0, al = 0
  const val = () => al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al)
  for (let i = 1; i < rows.length; i++) {
    const ch = rows[i].c - rows[i - 1].c
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0
    if (i <= n) {
      ag += g; al += l
      if (i === n) { ag /= n; al /= n; out[i] = val() }
    } else {
      ag = (ag * (n - 1) + g) / n
      al = (al * (n - 1) + l) / n
      out[i] = val()
    }
  }
  return out
}

/** EMA over an arbitrary series that may start with nulls; null until `n` values are seen. */
function emaOf(vals, n) {
  const out = new Array(vals.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null, seen = 0
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (v == null) continue
    prev = prev == null ? v : v * k + prev * (1 - k)
    if (++seen >= n) out[i] = prev
  }
  return out
}

/**
 * Supertrend direction at each candle: 1 while price is above the lower band, -1 while below
 * the upper one. The bands only ever ratchet toward price while the side holds, which is
 * what makes them a trailing stop rather than an envelope.
 */
export function supertrendSeries(rows, n, mult) {
  const out = new Array(rows.length).fill(null)
  let atr = null, trSum = 0
  let upper = null, lower = null, dir = 1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const pc = i ? rows[i - 1].c : r.c
    const tr = Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc))
    if (i < n) { trSum += tr; if (i === n - 1) atr = trSum / n; else continue }
    else atr = (atr * (n - 1) + tr) / n
    const mid = (r.h + r.l) / 2
    const bu = mid + mult * atr, bl = mid - mult * atr
    upper = (upper == null || bu < upper || pc > upper) ? bu : upper
    lower = (lower == null || bl > lower || pc < lower) ? bl : lower
    if (dir > 0 && r.c < lower) dir = -1
    else if (dir < 0 && r.c > upper) dir = 1
    out[i] = dir
  }
  return out
}

// ── HYPERLIQUID ACCOUNT MECHANICS ─────────────────────────────────────────────
//
// Asked for: "make sure the simulator simulates like the real hyperliquid market environment
// ... cross/isolated, with their proper liquidation prices depending the chosen one". So these
// are Hyperliquid's own rules, not an approximation of them:
//
//   MAINTENANCE MARGIN is half the initial margin at the market's MAX leverage: a market that
//     allows 40x liquidates when equity falls to 1/80 of the position's value. It depends on
//     the market, not on the leverage you picked -- which is why the app passes each market's
//     max leverage in, and why a 10x position on a 3x-max market is simply refused.
//   THE LIQUIDATION PRICE is where equity meets maintenance margin. What counts as equity is
//     the whole difference between the modes: ISOLATED backs the position with the margin you
//     posted for it and nothing else; CROSS backs it with the entire account. Same size, same
//     leverage, cross sits further away -- and when it is hit, it takes the account.
//   LEVERAGE sets the margin an order must post, so it decides whether an order is ACCEPTED.
//     In cross it does not move the liquidation price of a position of a given size; only in
//     isolated, where the margin posted is all there is, does it.
//   ORDERS UNDER $10 are rejected, as the exchange rejects them.
//   FEES are per fill: taker for anything that crosses the book (a market entry, a stop, a
//     liquidation), maker for a resting order that is filled (a take-profit, a grid level, a
//     safety order). Base tier: 0.045% and 0.015%.
//
// A liquidation closes the position AT the liquidation price and charges a taker fee; what is
// left of the margin stays in the account. A candle that gaps through the line is still filled
// on it, so a violent market reads a little kinder than it was.

export const HL_MIN_NOTIONAL = 10

/** The maintenance margin rate for a market: 1 / (2 x its max leverage). */
export function mmRate(p) { return 1 / (2 * Math.max(1, p.maxLev || 20)) }

/** The leverage actually used: what was asked for, capped at what the market allows. */
export function effLeverage(p) { return Math.max(1, Math.min(p.leverage || 1, p.maxLev || 50)) }

/** Fee rate for one fill, as a fraction. */
export function feeRate(p, kind) {
  if (!p.useFees) return 0
  return (kind === 'maker' ? p.makerFeePct : p.takerFeePct) / 100
}

/**
 * Where a position of `q` coins at average entry `p0`, backed by `A` dollars, is liquidated:
 * equity A + side*q*(P - p0) meets maintenance margin l*q*P. Null when it cannot happen -- a
 * long whose backing covers the whole position would have to fall below zero.
 */
export function hlLiqPrice(side, p0, q, A, l) {
  if (!(q > 0) || !(p0 > 0)) return null
  const P = (side * p0 - A / q) / (side - l)
  return Number.isFinite(P) && P > 0 ? P : null
}

/**
 * Open a position for a signal or flip strategy, or say why the exchange would refuse it.
 *
 * Sized three ways, as the order ticket allows: a share of the balance posted as margin (times
 * the leverage), a USDC amount, or an amount of the coin itself. The balance here is the whole
 * account -- one position at a time -- so in cross it is also what backs the position.
 */
export function sizePosition(balance, p, entry, side) {
  const lev = effLeverage(p)
  let q
  if (p.sizeMode === 'usd') q = p.sizeUsd / entry
  else if (p.sizeMode === 'coin') q = p.sizeCoin
  else {
    q = Math.max(0, balance) * (p.sizePct / 100) * lev / entry
    // "100%" means everything the account can open, fee included -- as the order ticket's
    // slider does. Without this, a full-size position is refused for want of its own fee.
    q = Math.min(q, Math.max(0, balance) / (entry * (1 / lev + feeRate(p, 'taker'))))
  }
  const notional = q * entry
  if (!(q > 0) || notional < HL_MIN_NOTIONAL - 1e-9) return { rejected: 'min' }
  const margin = notional / lev
  const openFee = notional * feeRate(p, 'taker')
  if (margin + openFee > balance + 1e-9) return { rejected: 'margin' }
  const A = p.marginMode === 'isolated' ? margin : balance - openFee
  return { q, notional, margin, lev, openFee, liq: hlLiqPrice(side, entry, q, A, mmRate(p)) }
}

/** What a position did to the balance when closed at `exit`, fees on both fills included. */
export function closePnl(pos, side, entry, exit, p, kind) {
  return side * pos.q * (exit - entry) - pos.openFee - pos.q * exit * feeRate(p, kind)
}
/**
 * The entry signal at each candle: 1 long, -1 short, 0 nothing, null not enough history.
 *
 * Every strategy reads only candles at or before the one it is judging. A signal on candle
 * i is acted on at the CLOSE of candle i, which is the earliest a rule reading that candle
 * could have acted at all.
 */
export function signals(rows, p) {
  const out = new Array(rows.length).fill(null)
  if (p.strategy === 'volbreak') {
    // The bot's own rule: bucket the candle range against the rolling average, fire when
    // the bucket reaches the threshold, direction from the candle colour.
    const avg = avgRangeSeries(rows, Math.max(2, Math.round(p.vbLookback)))
    for (let i = 0; i < rows.length; i++) {
      if (avg[i] == null || !(avg[i] > 0)) continue
      const cat = Math.floor(rows[i].range / avg[i])
      out[i] = cat >= Math.max(1, Math.round(p.vbThreshold)) ? (rows[i].red ? -1 : 1) : 0
    }
    return out
  }
  if (p.strategy === 'trend') {
    // A STATE, not a crossing: the bot is long whenever fast is above slow. The lifecycle
    // below is what turns that into trades.
    const f = ema(rows, Math.max(2, Math.round(p.emaFast)))
    const s = ema(rows, Math.max(2, Math.round(p.emaSlow)))
    for (let i = 0; i < rows.length; i++) {
      if (f[i] == null || s[i] == null) continue
      out[i] = f[i] > s[i] ? 1 : -1
    }
    return out
  }
  if (p.strategy === 'tokyo') {
    // A STATE from the clock alone: which side the windows say to hold at this candle.
    // Price is never consulted -- that is the whole strategy, and the reason it can be
    // simulated at all without knowing anything about the market.
    for (let i = 0; i < rows.length; i++) {
      const min = zoneMinute(rows[i].t, BT_TOKYO_ZONE)
      if (min == null) continue
      const enL = inWindow(min, p.tokyoLongFrom, p.tokyoLongTo)
      const enS = inWindow(min, p.tokyoShortFrom, p.tokyoShortTo)
      // Overlapping windows would be long and short at once, which nets to nothing while
      // paying two sets of fees and funding. The bot goes flat; so does this.
      out[i] = (enL && enS) ? 0 : enL ? 1 : enS ? -1 : 0
    }
    return out
  }
  if (p.strategy === 'rsi') {
    // The TURN, not the level: a long when RSI climbs back above oversold. Buying the moment
    // it dips below is the version that buys every candle of a crash.
    const r = rsiSeries(rows, Math.max(2, Math.round(p.rsiLen)))
    for (let i = 1; i < rows.length; i++) {
      if (r[i] == null || r[i - 1] == null) continue
      out[i] = (r[i - 1] < p.rsiLow && r[i] >= p.rsiLow) ? 1
             : (r[i - 1] > p.rsiHigh && r[i] <= p.rsiHigh) ? -1 : 0
    }
    return out
  }
  if (p.strategy === 'bollinger') {
    // The band INCLUDES the candle being judged. That is not lookahead: the signal is acted
    // on at this candle's close, which is also when its band is known.
    const n = Math.max(2, Math.round(p.bbLen))
    const mid = sma(rows, n)
    const fade = p.bbMode !== 'breakout'
    const up = new Array(rows.length).fill(null), dn = new Array(rows.length).fill(null)
    for (let i = n - 1; i < rows.length; i++) {
      let v = 0
      for (let k = i - n + 1; k <= i; k++) v += (rows[k].c - mid[i]) ** 2
      const sd = Math.sqrt(v / n)
      up[i] = mid[i] + p.bbMult * sd
      dn[i] = mid[i] - p.bbMult * sd
    }
    for (let i = n; i < rows.length; i++) {
      // Fires on the candle that crosses OUT of the band, not on every one outside it. Each
      // close is judged against ITS OWN band: the previous close against today's band would
      // call a candle that was already outside "inside", and fire twice running.
      const wasIn = rows[i - 1].c <= up[i - 1] && rows[i - 1].c >= dn[i - 1]
      const above = rows[i].c > up[i], below = rows[i].c < dn[i]
      out[i] = !wasIn ? 0 : above ? (fade ? -1 : 1) : below ? (fade ? 1 : -1) : 0
    }
    return out
  }
  if (p.strategy === 'macd' || p.strategy === 'emacross') {
    let a, b
    if (p.strategy === 'macd') {
      const f = ema(rows, Math.max(2, Math.round(p.macdFast)))
      const s = ema(rows, Math.max(2, Math.round(p.macdSlow)))
      a = f.map((v, i) => v == null || s[i] == null ? null : v - s[i])
      b = emaOf(a, Math.max(2, Math.round(p.macdSignal)))
    } else {
      a = ema(rows, Math.max(2, Math.round(p.crossFast)))
      b = ema(rows, Math.max(2, Math.round(p.crossSlow)))
    }
    for (let i = 1; i < rows.length; i++) {
      if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue
      out[i] = (a[i - 1] <= b[i - 1] && a[i] > b[i]) ? 1
             : (a[i - 1] >= b[i - 1] && a[i] < b[i]) ? -1 : 0
    }
    return out
  }
  if (p.strategy === 'supertrend') {
    // A STATE, like the Trend bot: which side the bands say to hold.
    const st = supertrendSeries(rows, Math.max(2, Math.round(p.stLen)), Math.max(0.1, p.stMult))
    for (let i = 0; i < rows.length; i++) out[i] = st[i]
    return out
  }
  if (p.strategy === 'breakout') {
    const n = Math.max(2, Math.round(p.breakoutLookback))
    for (let i = n; i < rows.length; i++) {
      let hi = -Infinity, lo = Infinity
      for (let k = i - n; k < i; k++) {
        if (rows[k].h > hi) hi = rows[k].h
        if (rows[k].l < lo) lo = rows[k].l
      }
      out[i] = rows[i].c > hi ? 1 : rows[i].c < lo ? -1 : 0
    }
    return out
  }
  const cats = classify(rows, p)
  for (let i = 0; i < rows.length; i++) {
    if (cats[i] == null) continue
    out[i] = Math.abs(cats[i]) >= p.entryCategory ? (cats[i] > 0 ? 1 : -1) : 0
  }
  return out
}

/**
 * Walk the candles once, taking every trade the rule asks for and following each to its
 * target, its stop, a time limit, or the end of the data.
 *
 * A trade still open when the candles run out is UNRESOLVED. It is not a win, not a loss,
 * and not excluded -- it is counted and reported, because a rule that opens trades nothing
 * ever closes is a fact about the rule.
 */
/**
 * The Trend bot has a different SHAPE of life to everything else here, so it gets its own
 * walk rather than being bent into the entry-and-target loop.
 *
 * It is always in a position. It is long while the fast EMA is above the slow one and
 * short while it is below, and it flips when that changes -- except that it REFUSES to
 * close a losing side unless its stop has been hit. That refusal is the single behaviour
 * that most shapes what the bot does, so modelling it as a normal signal strategy would
 * report on something the bot is not.
 */
function runTrendBot(rows, p, sig) {
  const stopFrac = Math.max(0, p.trendStopPct) / 100
  let balance = p.startBalance, peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0
  let pos = null
  const trades = []
  // Under Hyperliquid sizing a position is an order the exchange can refuse: too small, or
  // more margin than the account has. A refused entry is retried on the next candle, and
  // counted once per run of refusals rather than once per candle.
  let refused = 0, refusedNow = false
  const openAt = (side, px, i) => {
    if (p.pnlModel !== 'notional') return { side, entry: px, i, mae: 0 }
    const sz = sizePosition(balance, p, px, side)
    if (sz.rejected) { if (!refusedNow) refused++; refusedNow = true; return null }
    refusedNow = false
    return { side, entry: px, i, mae: 0, ...sz }
  }

  const book = (entry, exit, side, outcome, openedAt, closedAt, heldFor) => {
    const long = side > 0
    const moved = long ? exit - entry : entry - exit
    const slDist = entry * stopFrac
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'notional') {
      // Every exit here crosses the book -- a flip, a stop, the clock -- so it pays taker.
      delta = closePnl(pos, side, entry, exit, p, 'taker')
    } else if (p.pnlModel === 'risk' && slDist > 0) {
      delta += balance * (p.riskPct / 100) * (moved / slDist)
    } else if (outcome === 'win') delta += balance * (p.winPct / 100)
    else if (outcome === 'loss') delta -= balance * (p.lossPct / 100)
    balance += delta
    if (outcome === 'win') won++
    else if (outcome === 'loss') lost++
    peak = Math.max(peak, balance)
    if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)
    trades.push({ i: openedAt, time: rows[openedAt].t, side: long ? 'long' : 'short',
      entry, tp: null, sl: slDist > 0 ? (long ? entry - slDist : entry + slDist) : null,
      outcome, exitAt: closedAt, exitPx: exit, heldFor, balance, delta,
      q: pos?.q, liqPx: pos?.liq ?? null, mae: pos?.mae ?? null })
  }

  for (let i = 0; i < rows.length; i++) {
    const want = sig[i]
    if (want == null) continue
    const px = rows[i].c

    // The stop is checked against the candle's extreme, before anything else -- a stop that
    // was hit during the candle cannot be undone by where the candle happened to close.
    // A leveraged position can also be liquidated, which for a bot that holds losers is the
    // thing most likely to end one.
    if (pos) {
      const long = pos.side > 0
      pos.mae = Math.max(pos.mae, (long ? pos.entry - rows[i].l : rows[i].h - pos.entry) / pos.entry * 100)
      const liq = pos.liq ?? null
      let stopPx = stopFrac > 0 ? (long ? pos.entry * (1 - stopFrac) : pos.entry * (1 + stopFrac)) : null
      if (liq != null && (stopPx == null || (long ? liq > stopPx : liq < stopPx))) stopPx = liq
      if (stopPx != null && (long ? rows[i].l <= stopPx : rows[i].h >= stopPx)) {
        book(pos.entry, stopPx, pos.side, 'loss', pos.i, rows[i].t, i - pos.i)
        if (stopPx === liq) trades[trades.length - 1].liq = true
        pos = null
      }
    }

    if (pos && want !== pos.side) {
      const long = pos.side > 0
      const losing = (long ? pos.entry - px : px - pos.entry) > 0
      // Losing and not stopped: the bot holds. The signal is simply ignored this candle.
      if (losing) continue
      book(pos.entry, px, pos.side, 'win', pos.i, rows[i].t, i - pos.i)
      pos = null
    }

    if (!pos) pos = openAt(want, px, i)
  }

  // Whatever it was still holding when the data ended. Counted, never scored.
  const openTrade = pos
    ? [{ i: pos.i, time: rows[pos.i].t, side: pos.side > 0 ? 'long' : 'short', entry: pos.entry,
         tp: null, sl: null, outcome: 'open', exitAt: null, exitPx: null,
         heldFor: rows.length - 1 - pos.i, balance, q: pos.q, liqPx: pos.liq ?? null, mae: pos.mae }]
    : []

  return { trades: [...trades, ...openTrade], balance, peak, maxDD, won, lost, refused }
}

/**
 * The Tokyo Partners walk.
 *
 * Same shape of life as the Trend bot -- always in a position, flipping when the signal
 * changes -- with two differences that matter, both taken from the deployed file:
 *
 *   It has NO stop. It holds whatever the clock says to hold, so a position is closed by
 *   the window ending and never by a price level. A stop percentage is offered anyway,
 *   defaulting to off, because the risk-based money model needs a distance to size
 *   against; turning it on simulates a bot that is not quite this one, which is the point
 *   of being able to turn it on.
 *
 *   It does not refuse to close a loser. The Trend bot holds a losing side until its stop;
 *   this one closes on the clock regardless, and modelling it otherwise would report on a
 *   strategy nobody is running.
 *
 * A zero signal is FLAT, not "no opinion": it is what the bot does when both windows are
 * open at once, and skipping it would leave a position on that the bot would have closed.
 */
function runTokyoBot(rows, p, sig) {
  const stopFrac = Math.max(0, p.tokyoStopPct ?? 0) / 100
  let balance = p.startBalance, peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0
  let pos = null
  const trades = []
  // Under Hyperliquid sizing a position is an order the exchange can refuse: too small, or
  // more margin than the account has. A refused entry is retried on the next candle, and
  // counted once per run of refusals rather than once per candle.
  let refused = 0, refusedNow = false
  const openAt = (side, px, i) => {
    if (p.pnlModel !== 'notional') return { side, entry: px, i, mae: 0 }
    const sz = sizePosition(balance, p, px, side)
    if (sz.rejected) { if (!refusedNow) refused++; refusedNow = true; return null }
    refusedNow = false
    return { side, entry: px, i, mae: 0, ...sz }
  }

  const book = (entry, exit, side, openedAt, closedAt, heldFor, stopped) => {
    const long = side > 0
    const moved = long ? exit - entry : entry - exit
    const outcome = stopped ? 'loss' : moved > 0 ? 'win' : moved < 0 ? 'loss' : 'flat'
    const slDist = entry * stopFrac
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'notional') {
      // Every exit here crosses the book -- a flip, a stop, the clock -- so it pays taker.
      delta = closePnl(pos, side, entry, exit, p, 'taker')
    } else if (p.pnlModel === 'risk' && slDist > 0) {
      delta += balance * (p.riskPct / 100) * (moved / slDist)
    } else if (outcome === 'win') delta += balance * (p.winPct / 100)
    else if (outcome === 'loss') delta -= balance * (p.lossPct / 100)
    balance += delta
    if (outcome === 'win') won++
    else if (outcome === 'loss') lost++
    peak = Math.max(peak, balance)
    if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)
    trades.push({ i: openedAt, time: rows[openedAt].t, side: long ? 'long' : 'short',
      entry, tp: null, sl: slDist > 0 ? (long ? entry - slDist : entry + slDist) : null,
      outcome, exitAt: closedAt, exitPx: exit, heldFor, balance, delta,
      q: pos?.q, liqPx: pos?.liq ?? null, mae: pos?.mae ?? null })
  }

  for (let i = 0; i < rows.length; i++) {
    const want = sig[i]
    if (want == null) continue          // the clock could not be read for this candle
    const px = rows[i].c

    // Checked against the candle's extreme and before anything else: a stop touched inside
    // the candle cannot be undone by where it happened to close. Leverage adds a second
    // line that ends a position whether or not a stop was set.
    if (pos) {
      const long = pos.side > 0
      pos.mae = Math.max(pos.mae, (long ? pos.entry - rows[i].l : rows[i].h - pos.entry) / pos.entry * 100)
      const liq = pos.liq ?? null
      let stopPx = stopFrac > 0 ? (long ? pos.entry * (1 - stopFrac) : pos.entry * (1 + stopFrac)) : null
      if (liq != null && (stopPx == null || (long ? liq > stopPx : liq < stopPx))) stopPx = liq
      if (stopPx != null && (long ? rows[i].l <= stopPx : rows[i].h >= stopPx)) {
        book(pos.entry, stopPx, pos.side, pos.i, rows[i].t, i - pos.i, true)
        if (stopPx === liq) trades[trades.length - 1].liq = true
        pos = null
      }
    }

    if (pos && want !== pos.side) {
      book(pos.entry, px, pos.side, pos.i, rows[i].t, i - pos.i, false)
      pos = null
    }
    if (!pos && want !== 0) pos = openAt(want, px, i)
  }

  // Whatever was still held when the candles ran out. Counted, never scored.
  const openTrade = pos
    ? [{ i: pos.i, time: rows[pos.i].t, side: pos.side > 0 ? 'long' : 'short', entry: pos.entry,
         tp: null, sl: null, outcome: 'open', exitAt: null, exitPx: null,
         heldFor: rows.length - 1 - pos.i, balance, q: pos.q, liqPx: pos.liq ?? null, mae: pos.mae }]
    : []

  return { trades: [...trades, ...openTrade], balance, peak, maxDD, won, lost, refused }
}

/** The ladder of prices, spaced evenly in price or evenly in percent. */
export function gridLevels(lower, upper, n, geometric) {
  const k = Math.max(2, Math.round(n))
  if (!(lower > 0) || !(upper > lower)) return []
  if (geometric) {
    const ratio = Math.pow(upper / lower, 1 / (k - 1))
    return Array.from({ length: k }, (_, i) => lower * Math.pow(ratio, i))
  }
  const step = (upper - lower) / (k - 1)
  return Array.from({ length: k }, (_, i) => lower + i * step)
}

/**
 * The Grid bot.
 *
 * Its life is nothing like the other strategies here -- it holds a whole ladder of resting
 * orders at once rather than one position -- so it gets its own walk and its own numbers.
 *
 * The rule, from the bot: a buy rests at every level. When the buy at level i fills, a sell
 * is armed at level i+1. When that sell fills, the profit is the gap between the two and
 * the buy at level i is re-armed. A level is never re-bought while its sell is still open.
 *
 * TWO THINGS A GRID BACKTEST MUST NOT DO, because both turn its characteristic failure
 * into a flattering result:
 *
 *   1. COUNT A ROUND TRIP INSIDE ONE CANDLE. A candle whose range spans two levels touched
 *      both prices, but OHLC cannot say it went down then up rather than up then down.
 *      Allowing it manufactures free cycles out of volatility that may never have crossed.
 *      Default is to make the sell wait for a later candle.
 *   2. REPORT A WIN RATE. Every completed cycle is profitable BY CONSTRUCTION -- that is
 *      what a grid is -- so a win rate is always 100% and says nothing. The loss lives
 *      entirely in the inventory left behind when price leaves the range, which is why
 *      that is reported first and the win rate is not reported at all.
 */
export function runGridBacktest(rows, p) {
  const ref = rows[0]?.c ?? 0
  const lower = p.gridLower > 0 ? p.gridLower : ref * (1 - p.gridRangePct / 100)
  const upper = p.gridUpper > 0 ? p.gridUpper : ref * (1 + p.gridRangePct / 100)
  const prices = gridLevels(lower, upper, p.gridLevels, p.gridGeometric)
  const short = !!p.gridShort
  const side = short ? -1 : 1
  // Every grid fill is a resting order, so it pays maker. A liquidation is the exception.
  const mk = feeRate(p, 'maker'), tk = feeRate(p, 'taker')
  const lev = effLeverage(p), l = mmRate(p)
  const isolated = p.marginMode === 'isolated'
  // The size per level is USDC or coins, as set; in USDC it buys fewer coins at higher rungs.
  const qAt = (px) => p.orderUnit === 'coin' ? p.gridUsdPerLevel : p.gridUsdPerLevel / px

  // One slot per level that can hold a position: a long grid buys at i and sells at i+1,
  // so the top level has nothing to sell into. A short grid is the mirror.
  const slots = prices.map(() => null)
  let realized = 0, fees = 0, cycles = 0, buys = 0, sells = 0
  let inRange = 0, maxInventory = 0, maxNotional = 0, maxMargin = 0
  let refused = 0, liquidations = 0, closestLiq = null
  let mtmPeak = p.startBalance, mtmDD = 0
  const curve = []
  const trades = []

  const cash = () => p.startBalance + realized - fees
  const inv = () => {
    let q = 0, c = 0, m = 0
    for (const s of slots) if (s) { q += s.sz; c += s.px * s.sz; m += s.margin }
    return { q, avg: q ? c / q : 0, margin: m }
  }
  const unrealAt = (px) => { const { q, avg } = inv(); return q ? side * q * (px - avg) : 0 }
  const liqOf = () => {
    const { q, avg, margin } = inv()
    return q ? hlLiqPrice(side, avg, q, isolated ? margin : cash(), l) : null
  }

  for (const row of rows) {
    if (row.h >= lower && row.l <= upper) inRange++

    // The inventory carried INTO the candle is tested against its adverse extreme first. The
    // candle may also have filled more rungs on the way down, but those would only have moved
    // the line closer -- testing before them is the kinder reading, and it is stated.
    const lq = liqOf()
    if (lq != null && (side > 0 ? row.l <= lq : row.h >= lq)) {
      const { q, avg } = inv()
      const pnl = side * q * (lq - avg), fee = q * lq * tk
      const before = cash()
      realized += pnl; fees += fee; liquidations++
      trades.push({ i: -1, time: row.t, side: short ? 'short' : 'long', entry: avg, tp: null, sl: null,
        outcome: 'loss', exitAt: row.t, exitPx: lq, heldFor: 0, balance: cash(), delta: pnl - fee,
        liq: true, q, liqPx: lq, sized: true, ret: before > 0 ? (pnl - fee) / before : 0 })
      slots.fill(null)
    } else {
      for (let i = 0; i < prices.length - 1; i++) {
        const openPx = short ? prices[i + 1] : prices[i]
        const closePx = short ? prices[i] : prices[i + 1]
        // Long: buy when the candle trades down to the level. Short: sell into a rise.
        const openTouched = short ? row.h >= openPx : row.l <= openPx
        const closeTouched = short ? row.l <= closePx : row.h >= closePx

        if (slots[i] == null && openTouched) {
          const sz = qAt(openPx), notional = sz * openPx
          const margin = notional / lev, fee = notional * mk
          // The exchange refuses an order it cannot margin, or one under its minimum. The
          // rung simply does not fill, and is tried again the next time price comes to it.
          const used = inv().margin
          const avail = cash() + (isolated ? 0 : unrealAt(openPx)) - used
          if (notional < HL_MIN_NOTIONAL - 1e-9 || margin + fee > avail) { refused++; continue }
          slots[i] = { px: openPx, sz, at: row.t, openedOn: row, margin, fee }
          fees += fee
          buys++
          // Same candle: the close level was touched too, but OHLC cannot order the two.
          if (closeTouched && p.gridSameCandle !== 'allow') continue
        }

        if (slots[i] != null && closeTouched) {
          // A slot opened on THIS candle can only close now if same-candle trips are allowed.
          if (slots[i].openedOn === row && p.gridSameCandle !== 'allow') continue
          const { px, sz } = slots[i]
          const gain = side * (closePx - px) * sz
          const fee = closePx * sz * mk
          const before = cash() + slots[i].fee
          realized += gain
          fees += fee
          cycles++
          sells++
          const delta = gain - fee - slots[i].fee
          trades.push({ i, time: slots[i].at, side: short ? 'short' : 'long', entry: px,
            tp: closePx, sl: null, outcome: 'win', exitAt: row.t, exitPx: closePx, heldFor: 0,
            balance: cash(), delta, q: sz,
            // Dollar-sized: a portfolio re-books it by what it returned, not by a win percentage.
            sized: true, ret: before > 0 ? delta / before : 0 })
          slots[i] = null
        }
      }
    }
    const { q, margin } = inv()
    if (q > maxInventory) maxInventory = q
    if (q * row.c > maxNotional) maxNotional = q * row.c
    if (margin > maxMargin) maxMargin = margin
    const lqNow = liqOf()
    if (lqNow != null) {
      const d = Math.abs(row.c - lqNow) / row.c * 100
      if (closestLiq == null || d < closestLiq) closestLiq = d
    }
    // Marked to the close every candle. The grid's losing lives in the inventory it holds,
    // so a drawdown from realised cycles alone -- which only ever go up -- was always zero.
    const eq = cash() + unrealAt(row.c)
    if (eq > mtmPeak) mtmPeak = eq
    if (mtmPeak > 0) mtmDD = Math.max(mtmDD, (mtmPeak - eq) / mtmPeak * 100)
    curve.push([row.t, eq])
  }

  // What the grid was still holding when the data ended, valued at the last price. This is
  // where a grid loses, and it is the first number reported for that reason.
  const last = rows[rows.length - 1]?.c ?? 0
  const open = slots.filter(Boolean)
  const invSz = open.reduce((a, s) => a + s.sz, 0)
  const invCost = open.reduce((a, s) => a + s.px * s.sz, 0)
  const unrealized = invSz > 0 ? (short ? invCost - invSz * last : invSz * last - invCost) : 0

  const balance = cash() + unrealized
  return {
    grid: {
      lower, upper, levels: prices.length, prices,
      cycles, buys, sells,
      realized, fees, unrealized,
      inventorySize: invSz, inventoryCost: invCost, inventoryValue: invSz * last,
      maxInventory, maxNotional, maxMargin, refused, liquidations, closestLiq,
      liqNow: liqOf(), lev,
      inRangePct: rows.length ? (inRange / rows.length) * 100 : null,
      openSlots: open.length,
    },
    trades, balance, curve,
    peak: Math.max(mtmPeak, balance),
    maxDD: mtmDD,
    won: cycles, lost: liquidations,
  }
}

/** Where safety order k (1-based) rests, as a percentage away from the base price. */
export function dcaDeviations(p) {
  const out = []
  let dev = 0, gap = p.dcaStepPct
  for (let k = 1; k <= Math.max(0, Math.round(p.dcaSoCount)); k++) {
    dev += gap
    out.push(dev)
    gap *= Math.max(0.1, p.dcaStepScale)
  }
  return out
}

/**
 * What a whole DCA deal comes to if every safety order fills, starting from `basePx`: the
 * position's value and the margin it needs. In USDC the orders are the amounts; in coins they
 * are worth what the coin costs at each order's price.
 */
export function dcaFullDeal(p, basePx) {
  const devs = dcaDeviations(p)
  const long = p.dcaSide !== 'short'
  const coin = p.orderUnit === 'coin'
  let notional = coin ? p.dcaBaseUsd * basePx : p.dcaBaseUsd
  devs.forEach((d, k) => {
    const amt = p.dcaSoUsd * Math.pow(Math.max(0.1, p.dcaVolScale), k)
    const px = long ? basePx * (1 - d / 100) : basePx * (1 + d / 100)
    notional += coin ? amt * px : amt
  })
  return { notional, margin: notional / effLeverage(p), lastDev: devs[devs.length - 1] ?? 0 }
}

/**
 * The DCA bot.
 *
 * A base order opens a deal at a candle's close. Safety orders rest below it (above it for a
 * short) at gaps that widen by `dcaStepScale`, each larger than the last by `dcaVolScale`.
 * The target is measured from the AVERAGE entry, so every safety order that fills pulls the
 * exit closer -- which is the entire mechanism. When the target fills the deal is done and
 * the next one opens at that candle's close.
 *
 * On Hyperliquid it is a leveraged position like any other: each order posts margin, an
 * order the account cannot margin is refused -- and a deal that has run out of safety orders
 * keeps falling toward a liquidation price that every fill moved closer. That line is checked
 * between the orders, in the order price reaches them.
 *
 * Two readings kept honest, for the same reasons as the grid:
 *
 *   A SAFETY ORDER AND THE TARGET IN ONE CANDLE. The low filled the safety order and the high
 *     reached the new, closer target -- but OHLC cannot say the low came first. The target
 *     waits for a later candle whenever a safety order filled in this one.
 *   THE WIN RATE. Without a stop every closed deal is a win by construction. The loss is the
 *     deal still open when the data ends, or the one that was liquidated.
 *
 * Paid in dollars, not a share of the balance: the order sizes ARE the bot's settings.
 * Equity is marked to every close, so the drawdown includes the stack sitting underwater.
 */
export function runDcaBacktest(rows, p) {
  const long = p.dcaSide !== 'short'
  const side = long ? 1 : -1
  const mk = feeRate(p, 'maker'), tk = feeRate(p, 'taker')
  const lev = effLeverage(p), l = mmRate(p)
  const isolated = p.marginMode === 'isolated'
  const devs = dcaDeviations(p)
  const tpF = Math.max(0.01, p.dcaTpPct) / 100
  const slF = Math.max(0, p.dcaSlPct) / 100
  const qOf = (amount, px) => p.orderUnit === 'coin' ? amount : amount / px
  let realized = 0, fees = 0
  let peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0, maxSo = 0, maxDeployed = 0, maxMargin = 0
  let refused = 0, refusedNow = false, liquidations = 0, soRefused = 0, closestLiq = null
  const soHist = new Array(devs.length + 1).fill(0)
  const trades = [], curve = []
  let deal = null

  const cash = () => p.startBalance + realized - fees
  const avg = () => deal.cost / deal.qty
  const liqOf = () => deal ? hlLiqPrice(side, avg(), deal.qty, isolated ? deal.margin : cash(), l) : null
  // What the account can still margin: cash, plus unrealised profit in cross, less what is posted.
  const avail = (px) => cash() + (!deal || isolated ? 0 : side * deal.qty * (px - avg())) - (deal?.margin ?? 0)

  const open = (i) => {
    const px = rows[i].c
    const q = qOf(p.dcaBaseUsd, px), notional = q * px
    const margin = notional / lev, fee = notional * tk      // the base order is a market order
    if (notional < HL_MIN_NOTIONAL - 1e-9 || margin + fee > avail(px)) {
      if (!refusedNow) refused++
      refusedNow = true
      return
    }
    refusedNow = false
    fees += fee
    deal = { i, base: px, qty: q, cost: notional, so: 0, feeAcc: fee, margin, mae: 0, stopped: false }
  }

  const close = (i, exitPx, kind, outcome, isLiq) => {
    const a = avg()
    const gross = side * deal.qty * (exitPx - a)
    const outFee = deal.qty * exitPx * (kind === 'maker' ? mk : tk)
    fees += outFee
    const before = p.startBalance + realized - (fees - deal.feeAcc - outFee)
    realized += gross
    const delta = gross - deal.feeAcc - outFee
    if (delta >= 0) won++; else lost++
    soHist[deal.so]++
    trades.push({ i: deal.i, time: rows[deal.i].t, side: long ? 'long' : 'short', entry: a,
      tp: a * (1 + side * tpF), sl: slF > 0 ? a * (1 - side * slF) : null, outcome,
      exitAt: rows[i].t, exitPx, heldFor: i - deal.i,
      balance: cash(), delta, so: deal.so, cost: deal.cost, q: deal.qty, margin: deal.margin,
      liqPx: liqOf(), mae: deal.mae, ...(isLiq ? { liq: true } : {}),
      sized: true, ret: before > 0 ? delta / before : 0 })
    deal = null
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!deal) { open(i); curve.push([r.t, cash()]); continue }

    // Safety orders first -- they are the adverse move, and several can fill in one candle --
    // but in the order price reaches them, with the liquidation line between them: a deal
    // whose line sits above the next safety order is liquidated before that order can fill.
    let filled = false, liquidated = false
    while (deal.so < devs.length && !deal.stopped) {
      const d = devs[deal.so] / 100
      const soPx = long ? deal.base * (1 - d) : deal.base * (1 + d)
      if (long ? r.l > soPx : r.h < soPx) break
      const lq = liqOf()
      if (lq != null && (long ? lq >= soPx : lq <= soPx)) break      // the line comes first
      const amt = p.dcaSoUsd * Math.pow(Math.max(0.1, p.dcaVolScale), deal.so)
      const q = qOf(amt, soPx), notional = q * soPx
      const margin = notional / lev, fee = notional * mk
      if (notional < HL_MIN_NOTIONAL - 1e-9 || margin + fee > avail(soPx)) {
        // Refused for margin: the bot has nothing left to average with. It keeps the deal.
        deal.stopped = true
        soRefused++
        break
      }
      deal.qty += q
      deal.cost += notional
      deal.margin += margin
      deal.feeAcc += fee
      fees += fee
      deal.so++
      filled = true
    }
    if (deal.so > maxSo) maxSo = deal.so
    if (deal.cost > maxDeployed) maxDeployed = deal.cost
    if (deal.margin > maxMargin) maxMargin = deal.margin
    const a = avg()
    deal.mae = Math.max(deal.mae, (long ? a - r.l : r.h - a) / a * 100)

    const lq = liqOf()
    if (lq != null && (long ? r.l <= lq : r.h >= lq)) {
      close(i, lq, 'taker', 'loss', true)
      liquidations++
      liquidated = true
    }

    if (!liquidated) {
      const tpPx = long ? a * (1 + tpF) : a * (1 - tpF)
      const slPx = slF > 0 ? (long ? a * (1 - slF) : a * (1 + slF)) : null
      const hitSl = slPx != null && (long ? r.l <= slPx : r.h >= slPx)
      const hitTp = !filled && (long ? r.h >= tpPx : r.l <= tpPx)
      // Both inside one candle: the stop, for the same reason the signal rules count it.
      if (hitSl) close(i, slPx, 'taker', 'loss', false)
      else if (hitTp) close(i, tpPx, 'maker', 'win', false)
      // The next deal opens at this candle's close, after the exit inside it.
      if (!deal) open(i)
    }
    const lqNow = liqOf()
    if (lqNow != null) {
      const dist = Math.abs(r.c - lqNow) / r.c * 100
      if (closestLiq == null || dist < closestLiq) closestLiq = dist
    }
    const unreal = deal ? side * deal.qty * (r.c - avg()) : 0
    const eq = cash() + unreal
    if (eq > peak) peak = eq
    if (peak > 0) maxDD = Math.max(maxDD, (peak - eq) / peak * 100)
    curve.push([r.t, eq])
  }

  const last = rows[rows.length - 1]?.c ?? 0
  const unrealized = deal ? side * deal.qty * (last - avg()) : 0
  const openTrade = deal ? [{ i: deal.i, time: rows[deal.i].t, side: long ? 'long' : 'short',
    entry: avg(), tp: null, sl: null, outcome: 'open', exitAt: null, exitPx: null,
    heldFor: rows.length - 1 - deal.i, balance: cash(), so: deal.so, cost: deal.cost,
    q: deal.qty, margin: deal.margin, liqPx: liqOf(), mae: deal.mae }] : []
  const balance = cash() + unrealized
  const full = dcaFullDeal(p, rows[0]?.c ?? 0)
  return {
    dca: {
      deals: trades.length, realized, fees, unrealized,
      openCost: deal?.cost ?? 0, openSo: deal?.so ?? 0, openAvg: deal ? avg() : null,
      openLiq: liqOf(), openMargin: deal?.margin ?? 0,
      maxSo, soCount: devs.length, maxDeployed, maxMargin, soHist,
      refused, soRefused, liquidations, closestLiq, lev,
      // What a deal can grow to if every safety order fills. The number that matters.
      maxPossible: full.notional, maxPossibleMargin: full.margin,
      lastDev: devs[devs.length - 1] ?? 0,
    },
    trades: [...trades, ...openTrade], balance, curve,
    peak: Math.max(peak, balance), maxDD, won, lost,
  }
}

export function runBacktest(candles, params = {}) {
  const p = { ...BT_DEFAULTS, ...params }
  const rows = normalise(candles)
  const sig = signals(rows, p)
  const trend = p.useTrendFilter ? sma(rows, Math.max(2, Math.round(p.trendMa))) : null
  const avgRange = p.strategy === 'volbreak' ? avgRangeSeries(rows, Math.max(2, Math.round(p.vbLookback))) : null

  let balance = p.startBalance
  let peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0, cooldown = 0, streak = 0, halted = false, refused = 0
  let trades = []

  // The Trend bot is always in a position, so it runs its own walk and rejoins here for
  // the reporting. Modules that describe entries -- cooldown, side, trend filter -- have
  // nothing to act on in a strategy that never sits out, and are simply not applied.
  if (p.strategy === 'grid' || p.strategy === 'dca') {
    const g = p.strategy === 'grid' ? runGridBacktest(rows, p) : runDcaBacktest(rows, p)
    const netG = g.balance - p.startBalance
    const closed = g.trades.filter(t => t.outcome !== 'open')
    return {
      params: p, candles: rows.length,
      from: rows[0]?.t ?? null, to: rows[rows.length - 1]?.t ?? null,
      trades: g.trades, tradesMade: g.trades.length,
      won: g.won, lost: g.lost,
      unresolved: g.grid ? g.grid.openSlots : g.trades.length - closed.length,
      timedOut: 0, halted: false,
      refused: (g.grid ?? g.dca)?.refused ?? 0,
      // Deliberately null for a grid, and for a DCA with no stop. Every completed cycle or
      // deal profits by construction, so a win rate there is always 100% and would read as
      // a perfect strategy.
      winRate: (g.grid || !(p.dcaSlPct > 0)) ? null : (g.won + g.lost ? (g.won / (g.won + g.lost)) * 100 : null),
      startBalance: p.startBalance, balance: g.balance, netPnl: netG,
      roe: p.startBalance > 0 ? (netG / p.startBalance) * 100 : null,
      peak: g.peak, maxDrawdown: g.maxDD,
      avgPerTrade: g.trades.length ? netG / g.trades.length : 0,
      avgHeld: closed.length ? closed.reduce((a, t) => a + (t.heldFor ?? 0), 0) / closed.length : 0,
      signalsSeen: g.grid ? g.grid.buys : closed.length,
      grid: g.grid, dca: g.dca, curve: g.curve,
    }
  }

  if (p.strategy === 'trend') {
    const t = runTrendBot(rows, p, sig)
    trades = t.trades
    balance = t.balance; peak = t.peak; maxDD = t.maxDD; won = t.won; lost = t.lost; refused = t.refused ?? 0
  }

  if (p.strategy === 'tokyo' || p.strategy === 'supertrend') {
    // Supertrend has the same shape of life as Tokyo -- always in, turned over by its own
    // rule, never refusing to close a loser -- so it shares the walk. Its optional stop goes
    // in the slot Tokyo's occupies.
    const t = runTokyoBot(rows, p.strategy === 'supertrend' ? { ...p, tokyoStopPct: p.stStopPct } : p, sig)
    trades = t.trades
    balance = t.balance; peak = t.peak; maxDD = t.maxDD; won = t.won; lost = t.lost; refused = t.refused ?? 0
  }

  const ownWalk = strategyKind(p.strategy) !== 'signal'
  for (let i = 0; i < rows.length && !halted && !ownWalk; i++) {
    if (cooldown > 0) { cooldown--; continue }
    const s = sig[i]
    if (!s) continue
    const long = s > 0

    if (p.useDirection && ((long && p.direction === 'short') || (!long && p.direction === 'long'))) continue
    // Only trade with the longer trend. A null average means it has no value yet, which is
    // not permission -- an unknown trend is not an uptrend.
    if (trend) {
      const ma = trend[i]
      if (ma == null) continue
      if (long ? rows[i].c < ma : rows[i].c > ma) continue
    }

    const entry = rows[i].c
    // The bot sets both levels as multiples of the rolling average RANGE, so they widen
    // and narrow with volatility instead of being a fixed percentage of price. Using
    // percentages here would be a different strategy wearing its name.
    const vbAvg = p.strategy === 'volbreak' ? avgRange?.[i] : null
    const tpDist = vbAvg != null ? vbAvg * p.vbTpMult : entry * (p.takeProfitPct / 100)
    const slDist = vbAvg != null ? vbAvg * p.vbSlMult : entry * (p.stopLossPct / 100)
    const tp = long ? entry + tpDist : entry - tpDist
    const sl0 = long ? entry - slDist : entry + slDist
    // Under Hyperliquid sizing the entry is an order the exchange can refuse -- too small, or
    // more margin than the account has left. A refused signal is a trade that did not happen.
    let pos = null
    if (p.pnlModel === 'notional') {
      pos = sizePosition(balance, p, entry, long ? 1 : -1)
      if (pos.rejected) { refused++; continue }
    }
    // Leverage puts a second line under the trade. It only matters when it sits CLOSER than
    // the stop -- a 5% stop at 20x never gets the chance to fire.
    const liq = pos?.liq ?? null
    if (p.useCooldown) cooldown = p.cooldownCandles

    let stop = sl0, best = entry
    let outcome = 'open', exitAt = null, exitPx = null, heldFor = 0, exitIdx = rows.length, liquidated = false
    let mae = 0
    for (let x = i + 1; x < rows.length; x++) {
      heldFor = x - i
      // The worst it went against the trade, which is what decides whether a looser stop or
      // more leverage would have survived it.
      mae = Math.max(mae, (long ? entry - rows[x].l : rows[x].h - entry) / entry * 100)
      const eff = liq == null ? stop : (long ? Math.max(stop, liq) : Math.min(stop, liq))
      const hitTp = long ? rows[x].h >= tp : rows[x].l <= tp
      const hitSl = long ? rows[x].l <= eff : rows[x].h >= eff
      if (hitTp && hitSl) {
        // Both levels inside one candle. OHLC cannot say which came first.
        outcome = p.ambiguous === 'win' ? 'win' : 'loss'
      } else if (hitTp) outcome = 'win'
      else if (hitSl) outcome = 'loss'
      else {
        // The trail is extended only AFTER this candle failed to stop the trade, so the
        // stop can never be moved out of the way of a hit that already happened.
        if (p.useTrailing) {
          best = long ? Math.max(best, rows[x].h) : Math.min(best, rows[x].l)
          const trailed = long ? best * (1 - p.trailPct / 100) : best * (1 + p.trailPct / 100)
          stop = long ? Math.max(stop, trailed) : Math.min(stop, trailed)
        }
        if (p.useTimeExit && heldFor >= p.timeExitCandles) {
          outcome = 'timeout'
          exitAt = rows[x].t
          exitPx = rows[x].c
          exitIdx = x
          break
        }
        continue
      }
      exitAt = rows[x].t
      exitPx = outcome === 'win' ? tp : eff
      liquidated = outcome === 'loss' && eff === liq
      exitIdx = x
      break
    }

    // ── the money ─────────────────────────────────────────────────────────
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'notional') {
      // What the position actually made: its size times the move, each fill charged as the
      // exchange charges it. The target is a resting order (maker); the stop, a timeout and a
      // liquidation all cross the book (taker).
      if (exitPx != null) {
        delta = closePnl(pos, long ? 1 : -1, entry, exitPx, p, outcome === 'win' && !liquidated ? 'maker' : 'taker')
        const moved = long ? exitPx - entry : entry - exitPx
        if (outcome === 'timeout') { if (moved > 0) won++; else if (moved < 0) lost++ }
        else if (outcome === 'win') won++
        else if (outcome === 'loss') lost++
      } else {
        // Never closed, so never scored -- but it was opened, and opening paid its fee.
        delta = -pos.openFee
      }
    } else if (p.pnlModel === 'risk') {
      // Sized from the actual distance to the stop: risking `riskPct` of the balance, a
      // win pays that times the reward-to-risk the levels imply. Change the target and the
      // payout follows, which the fixed model cannot do.
      // From the distances actually used, so a volatility-scaled pair is priced by its own
      // ratio rather than by percentage boxes the strategy ignored.
      const rr = slDist > 0 ? tpDist / slDist : 0
      if (outcome === 'win') { delta += balance * (p.riskPct / 100) * rr; won++ }
      else if (outcome === 'loss') { delta -= balance * (p.riskPct / 100); lost++ }
      else if (outcome === 'timeout' && exitPx != null) {
        // Closed where it stood, not at either level, so it is valued by how far it got.
        const moved = long ? exitPx - entry : entry - exitPx
        delta += balance * (p.riskPct / 100) * (slDist > 0 ? moved / slDist : 0)
        if (moved > 0) won++
        else if (moved < 0) lost++
      }
    } else {
      if (outcome === 'win') { delta += balance * (p.winPct / 100); won++ }
      else if (outcome === 'loss') { delta -= balance * (p.lossPct / 100); lost++ }
      else if (outcome === 'timeout' && exitPx != null) {
        // A fixed model has no way to price a partial move, so a timeout scores as the
        // direction it ended in, at the same flat size. Stated rather than hidden.
        const up = long ? exitPx > entry : exitPx < entry
        if (up) { delta += balance * (p.winPct / 100); won++ }
        else { delta -= balance * (p.lossPct / 100); lost++ }
      }
    }
    balance += delta

    if (outcome === 'loss') streak++
    else if (outcome === 'win') streak = 0
    if (p.useMaxLosses && streak >= Math.max(1, Math.round(p.maxConsecLosses))) halted = true

    peak = Math.max(peak, balance)
    if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)

    trades.push({
      i, time: rows[i].t, side: long ? 'long' : 'short', entry, tp, sl: sl0,
      outcome, exitAt, exitPx, heldFor, balance, delta, ...(liquidated ? { liq: true } : {}),
      mae, ...(pos ? { q: pos.q, margin: pos.margin, liqPx: pos.liq ?? null } : {}),
    })

    // One position at a time: the next entry is looked for from the candle this one closed
    // on. That candle's close comes after the exit inside it, so acting on it is fair. A
    // trade that never closed holds the market to the end.
    if (p.useOnePos) i = exitIdx - 1
  }

  const resolved = won + lost
  const netPnl = balance - p.startBalance
  return {
    params: p,
    candles: rows.length,
    from: rows[0]?.t ?? null,
    to: rows[rows.length - 1]?.t ?? null,
    trades,
    tradesMade: trades.length,
    won,
    lost,
    unresolved: trades.filter(t => t.outcome === 'open').length,
    timedOut: trades.filter(t => t.outcome === 'timeout').length,
    halted,
    // Entries the exchange would have refused: under its $10 minimum, or not enough margin.
    refused,
    // Null, not 0, when nothing resolved: a rate with no denominator is unknown, and 0%
    // reads as "it lost every time".
    winRate: resolved ? (won / resolved) * 100 : null,
    startBalance: p.startBalance,
    balance,
    netPnl,
    roe: p.startBalance > 0 ? (netPnl / p.startBalance) * 100 : null,
    peak,
    maxDrawdown: maxDD,
    avgPerTrade: trades.length ? netPnl / trades.length : 0,
    avgHeld: trades.length ? trades.reduce((a, t) => a + t.heldFor, 0) / trades.length : 0,
    // How many entry signals the strategy produced before any module filtered them. The
    // gap between this and tradesMade is what the modules removed.
    signalsSeen: sig.filter(v => v).length,
  }
}

// ── the form ──────────────────────────────────────────────────────────────────
// Field definitions rather than hand-written markup, so the form, the defaults and the
// parameters the engine reads cannot drift apart: every box here is a key of BT_DEFAULTS.
//
// `strategy` shows a field only for that entry rule; `group` hides it behind a module
// switch or a money model.

export const BT_FIELDS = [
  { key: 'startBalance', label: 'Starting balance', unit: '$', step: '1',
    hint: 'What the run begins with.',
    help: 'Every gain and loss is a percentage of the balance at the time, so this scales the money but not the shape of the result. Doubling it doubles the profit and leaves the win rate and the drawdown percentage exactly where they were.' },

  { key: 'entryCategory', label: 'Entry category', unit: 'x', step: '1', strategy: 'range',
    hint: 'How unusual a candle must be. 1-6.',
    help: 'Each candle is measured by its high-to-low range, divided by the average range of the candles before it. A category of 3 means "three times the recent normal". Any candle at or above it opens a trade in the direction it closed. Higher is rarer and trades less; if a run reports no trades, this is usually why.' },

  { key: 'baselineLookback', label: 'Baseline window', unit: 'candles', step: '10', strategy: 'range',
    hint: 'How much history counts as "normal".',
    help: 'The number of PAST candles whose ranges are averaged to decide what a normal candle looks like. Shorter reacts faster and calls more candles unusual; longer is steadier. Setting it to 0 averages the whole sample INCLUDING candles from after each trade -- a number nobody could have had at the time, which flatters the result. It is offered only so you can measure what that assumption was worth.' },

  { key: 'breakoutLookback', label: 'Breakout window', unit: 'candles', step: '1', strategy: 'breakout',
    hint: 'Candles whose extreme must be cleared.',
    help: 'A close above the highest high of this many previous candles opens a long; a close below the lowest low opens a short. Longer windows fire rarely and on bigger moves.' },

  { key: 'vbLookback', label: 'Rolling window', unit: 'candles', step: '1', strategy: 'volbreak',
    hint: 'Candles in the average the bot compares against.',
    help: 'The bot averages the range of this many candles STRICTLY BEFORE the one it is judging, and that average does two jobs: it decides whether a candle is unusual, and it sets how far the target and stop sit. This is the bot default of 20.' },

  { key: 'vbThreshold', label: 'Threshold', unit: 'x', step: '1', strategy: 'volbreak',
    hint: 'Range multiple needed to fire. 1-6.',
    help: 'How many times the rolling average a candle range must reach before the bot acts. Its default is 3. Raising it trades less and on bigger candles; the result also reports how many signals existed before the modules filtered them, so you can see what the threshold cost.' },

  { key: 'vbTpMult', label: 'Target', unit: 'x avg range', step: '0.25', strategy: 'volbreak',
    hint: 'Multiples of the rolling average range.',
    help: 'The distinctive part of this bot: the target is a multiple of the SAME rolling average range, not a percentage of price. It widens when the market is moving and tightens when it is quiet, which a fixed percentage cannot do. The percentage boxes elsewhere on this form are ignored while this strategy is selected.' },

  { key: 'vbSlMult', label: 'Stop', unit: 'x avg range', step: '0.25', strategy: 'volbreak',
    hint: 'Multiples of the rolling average range.',
    help: 'The stop, on the same scale as the target. Target over stop is the reward-to-risk, so the bot defaults of 2 and 1 are two-to-one, and the win rate needed to break even is stop / (target + stop) -- one third at those settings.' },

  { key: 'emaFast', label: 'Fast EMA', unit: 'candles', step: '1', strategy: 'trend',
    hint: 'The quicker average.',
    help: 'The bot is long whenever this average is above the slow one. Note it is a STATE, not a crossing event: the bot does not wait for a cross, it simply holds whichever side the two averages currently imply.' },

  { key: 'emaSlow', label: 'Slow EMA', unit: 'candles', step: '1', strategy: 'trend',
    hint: 'The slower average.',
    help: 'The longer average. It must be meaningfully longer than the fast one, or the two swap constantly and the bot flips on noise.' },

  { key: 'tokyoLongFrom', label: 'Long window opens', unit: 'NY', type: 'time', strategy: 'tokyo',
    hint: 'When the long side starts.',
    help: 'New York time, because that is the zone the windows were found in -- daylight saving moves them with it, which is deliberate. A window whose close is EARLIER than its open crosses midnight and the position is carried into the next day.' },

  { key: 'tokyoLongTo', label: 'Long window closes', unit: 'NY', type: 'time', strategy: 'tokyo',
    hint: 'When the long side ends.',
    help: 'The candle at this time is already outside the window, so the position is closed at its close. Set the open and the close to the same time to switch the long side off entirely.' },

  { key: 'tokyoShortFrom', label: 'Short window opens', unit: 'NY', type: 'time', strategy: 'tokyo',
    hint: 'When the short side starts.',
    help: 'Independent of the long window. If the two overlap the bot goes FLAT for the overlap rather than holding both, since a long and a short of the same size net to nothing while paying two sets of fees and funding.' },

  { key: 'tokyoShortTo', label: 'Short window closes', unit: 'NY', type: 'time', strategy: 'tokyo',
    hint: 'When the short side ends.',
    help: 'Set the open and the close to the same time to switch the short side off and simulate a long-only version of the same table.' },

  { key: 'tokyoStopPct', label: 'Stop loss', unit: '%', step: '0.25', strategy: 'tokyo',
    hint: '0 = none, which is the real bot.',
    help: 'The deployed bot has NO stop: it holds whatever the clock says to hold and closes when the window ends, at whatever price that is. Leave this at 0 to simulate that. Setting it simulates a different bot -- which is worth doing, because the answer to "what would a stop have cost or saved here" is one of the few things this screen can settle. Note the risk-based money model needs a stop distance to size against, so with 0 it falls back to the fixed percentages.' },

  { key: 'trendStopPct', label: 'Stop loss', unit: '%', step: '0.25', strategy: 'trend',
    hint: 'The only thing that closes a losing side.',
    help: 'This bot refuses to close a position that is underwater. When the averages flip against an open trade it HOLDS, and the only thing that gets it out at a loss is this stop. That single rule shapes its results more than the averages do -- set it to 0 and the bot will hold a loser indefinitely, which the run will show as very few, very long trades.' },

  { key: 'gridRangePct', label: 'Range', unit: '% either side', step: '1', strategy: 'grid',
    hint: 'Used when lower and upper are left at 0.',
    help: 'The ladder is built this far above and below the first candle of the run. The bot does the same from the mark price when you do not give it a range, defaulting to 10% each way. Set an explicit lower and upper below to override it.' },

  { key: 'gridLower', label: 'Lower price', unit: '0 = auto', step: '1', strategy: 'grid',
    hint: 'Bottom of the ladder.',
    help: 'The lowest level. Price below this means every buy has filled and the grid is fully loaded with nothing left to catch a further fall -- which is where a grid does its losing.' },

  { key: 'gridUpper', label: 'Upper price', unit: '0 = auto', step: '1', strategy: 'grid',
    hint: 'Top of the ladder.',
    help: 'The highest level. Price above this means every position has been sold and the grid sits idle in cash, earning nothing until price comes back.' },

  { key: 'gridLevels', label: 'Levels', unit: 'rungs', step: '1', strategy: 'grid',
    hint: 'How many rungs the ladder has.',
    help: 'More rungs means smaller gaps: more cycles, each worth less, and more fees. Fewer means rarer but larger cycles. The profit per cycle is the gap between two rungs, so this and the range together decide what a cycle is worth.' },

  { key: 'gridUsdPerLevel', label: 'Size per level', unit: '$', step: '10', strategy: 'grid',
    hint: 'Bought at each rung.',
    help: 'The dollars committed at each rung. Multiply it by the number of rungs to see what the grid can end up holding if price leaves the bottom of the range -- that total, not the size per level, is what is actually at risk.' },

  { key: 'rsiLen', label: 'RSI length', unit: 'candles', step: '1', strategy: 'rsi',
    hint: 'Changes averaged. 14 is the standard.',
    help: 'How many candles of gains and losses the RSI averages, Wilder-smoothed the way every charting package does it -- so 30 and 70 here mean what they mean on a chart. Shorter swings to the extremes more often and fires more; longer rarely reaches them at all.' },

  { key: 'rsiLow', label: 'Oversold', unit: 'RSI', step: '1', strategy: 'rsi',
    hint: 'A long fires when RSI climbs back above this.',
    help: 'The long signal is the TURN: RSI was below this line and has just closed back above it. Buying the moment it dips under is the other common version, and it is the one that buys every candle of a crash -- this one waits for the selling to pause. Lower is rarer and deeper.' },

  { key: 'rsiHigh', label: 'Overbought', unit: 'RSI', step: '1', strategy: 'rsi',
    hint: 'A short fires when RSI falls back below this.',
    help: 'The mirror: RSI was above this and has just closed back under it. Use Restrict side under Modules to run the long half alone -- mean reversion shorts in a market that only went up are usually where this strategy bleeds.' },

  { key: 'bbLen', label: 'Band length', unit: 'candles', step: '1', strategy: 'bollinger',
    hint: 'The moving average in the middle. 20 is standard.',
    help: 'The middle line is a simple average of this many closes, and the bands are measured from it in standard deviations of the same closes. A signal fires only on the candle that closes OUTSIDE a band after closing inside it, so a long stretch outside counts once, not every candle.' },

  { key: 'bbMult', label: 'Band width', unit: 'std devs', step: '0.1', strategy: 'bollinger',
    hint: 'How far out the bands sit. 2 is standard.',
    help: 'At 2 standard deviations a normal market closes outside a band roughly one candle in twenty. Wider bands fire rarely and on more extreme stretches; narrower ones fire constantly and mostly on noise.' },

  { key: 'macdFast', label: 'Fast EMA', unit: 'candles', step: '1', strategy: 'macd',
    hint: 'MACD line = fast EMA minus slow EMA.',
    help: 'The standard is 12, 26 and 9. The MACD line is this average minus the slow one; when it crosses above its own signal line momentum is turning up, and a long opens.' },

  { key: 'macdSlow', label: 'Slow EMA', unit: 'candles', step: '1', strategy: 'macd',
    hint: 'Must be longer than the fast one.',
    help: 'The longer average the fast one is measured against. Kept at least one candle longer than the fast EMA -- if they were equal the MACD line would be flat at zero and nothing would ever cross.' },

  { key: 'macdSignal', label: 'Signal line', unit: 'candles', step: '1', strategy: 'macd',
    hint: 'EMA of the MACD line itself.',
    help: 'An average of the MACD line. The trade fires on the MACD line crossing THIS, which is earlier than waiting for the two EMAs themselves to cross and noisier for the same reason.' },

  { key: 'crossFast', label: 'Fast EMA', unit: 'candles', step: '1', strategy: 'emacross',
    hint: 'The quicker average.',
    help: 'A long opens on the candle where this average crosses ABOVE the slow one, a short where it crosses below. Only the crossing candle fires; between crosses the strategy sits out, which is the difference from the Trend bot.' },

  { key: 'crossSlow', label: 'Slow EMA', unit: 'candles', step: '1', strategy: 'emacross',
    hint: 'The slower average.',
    help: 'Kept longer than the fast one. 9 and 21 is a common short-term pair; 50 and 200 is the famous "golden cross", which on hourly candles fires only a handful of times a year.' },

  { key: 'stLen', label: 'ATR length', unit: 'candles', step: '1', strategy: 'supertrend',
    hint: 'Candles in the average true range.',
    help: 'The Average True Range measures how far price typically travels in a candle, gaps included. The bands sit a multiple of it away from each candle\'s midpoint. 10 is the common default.' },

  { key: 'stMult', label: 'Multiplier', unit: 'x ATR', step: '0.25', strategy: 'supertrend',
    hint: 'How far the bands sit. 3 is common.',
    help: 'Wider bands flip less often and give a trend more room, at the cost of giving back more before they flip. Narrower bands flip on every wobble and pay the fees for it -- check the trade count against the net.' },

  { key: 'stStopPct', label: 'Stop loss', unit: '%', step: '0.25', strategy: 'supertrend',
    hint: '0 = none; the band is the stop.',
    help: 'Supertrend closes a position when price closes through the opposite band, so it already has an exit. A percentage stop here is an extra, tighter line that can end a trade before the band does.' },

  { key: 'dcaBaseUsd', label: 'Base order', unit: '$', step: '10', strategy: 'dca',
    hint: 'What opens each deal.',
    help: 'Bought at the close of the candle a deal starts on. A deal starts at the beginning of the run and again straight after every target is hit.' },

  { key: 'dcaSoUsd', label: 'Safety order', unit: '$', step: '10', strategy: 'dca',
    hint: 'The first one; later ones scale.',
    help: 'The size of the first safety order. Each after it is multiplied by the volume scale, so with 1.5 the fifth is five times the first. The panel shows what a deal can grow to if every one fills -- that total, not the base order, is what the bot really risks.' },

  { key: 'dcaSoCount', label: 'Safety orders', unit: 'max', step: '1', strategy: 'dca',
    hint: 'How many times it can average down.',
    help: 'More safety orders let a deal survive a deeper move, and make the deal that finally does not survive much larger. The result says how many were ever used and how often.' },

  { key: 'dcaStepPct', label: 'First step', unit: '%', step: '0.1', strategy: 'dca',
    hint: 'Distance from the base price to the first.',
    help: 'The first safety order rests this far against the base price. Later gaps widen by the step scale, and the panel shows the deviation the last one sits at -- a move past that is a move the bot has nothing left for.' },

  { key: 'dcaStepScale', label: 'Step scale', unit: 'x', step: '0.1', strategy: 'dca',
    hint: 'Each gap is this much wider than the last.',
    help: 'At 1 the orders are evenly spaced. Above 1 they spread out, covering a deeper move with the same count. 1.2 to 1.5 is typical.' },

  { key: 'dcaVolScale', label: 'Volume scale', unit: 'x', step: '0.1', strategy: 'dca',
    hint: 'Each order is this much larger than the last.',
    help: 'Larger later orders pull the average entry toward price faster, so a smaller bounce closes the deal. They also grow the total geometrically -- 1.5 over ten orders is more than a hundred times the first.' },

  { key: 'dcaTpPct', label: 'Take profit', unit: '% from avg', step: '0.1', strategy: 'dca',
    hint: 'Measured from the average entry.',
    help: 'The deal closes when price reaches this far past the AVERAGE entry, not the first one. That is the whole trick: every safety order drags the target closer to where price is.' },

  { key: 'dcaSlPct', label: 'Stop loss', unit: '% from avg', step: '0.5', strategy: 'dca',
    hint: '0 = none, which is how most are run.',
    help: 'Most DCA bots are run with no stop, which is why they win nearly every deal and why the one they lose is so large. Set one to see what cutting the stack would have cost or saved; the win rate is only shown when a stop exists, because without one it is 100% by construction.' },

  { key: 'sizePct', label: 'Position size', unit: '% of balance', step: '5', group: 'notionalModel',
    hint: 'Margin posted per trade.',
    help: 'Each trade posts this share of the balance as margin. With several markets and "split the risk" on, it is divided between them. 100% at 1x is the plain "all in, no leverage" case, directly comparable to holding the coin.' },

  { key: 'leverage', label: 'Leverage', unit: 'x', step: '1', group: 'notionalModel',
    hint: 'Margin = position ÷ leverage. Capped at the market max.',
    help: 'Sets the margin each order must post: a $1,000 position at 10x posts $100. Sized as a share of the balance, it also sets how big the position is. It is capped at each market\'s own maximum, as Hyperliquid caps it. In ISOLATED the posted margin is all that backs the position, so more leverage pulls the liquidation price closer; in CROSS the whole account backs it, and leverage only decides how much margin an order needs -- for the same size, the line does not move. The preview below shows both lines for the first market.' },

  { key: 'sizeUsd', label: 'Position size', unit: 'USDC', step: '10', group: 'notionalModel',
    hint: 'The position\'s value, as on the order ticket.',
    help: 'The value of each position in USDC -- what you type into Hyperliquid\'s order ticket. The margin it posts is this divided by the leverage. Orders under $10 are refused, as the exchange refuses them, and so is one the account cannot margin.' },

  { key: 'sizeCoin', label: 'Position size', unit: 'coins', step: '0.001', group: 'notionalModel',
    hint: 'An amount of the coin itself.',
    help: 'Each position is this many of the coin -- 0.01 BTC, 50 HYPE. The dollar value follows the price, so the same setting risks more after a rally. With several markets it is the same amount of EACH coin, which is rarely what you want across very different prices.' },

  { key: 'makerFeePct', label: 'Maker fee', unit: '% per fill', step: '0.001', group: 'useFees',
    hint: 'Resting orders: targets, grid rungs, safety orders.',
    help: 'Charged on the value of every fill from an order that was resting on the book. Hyperliquid\'s base tier is 0.015%; volume tiers and referral discounts lower it.' },

  { key: 'takerFeePct', label: 'Taker fee', unit: '% per fill', step: '0.001', group: 'useFees',
    hint: 'Market entries, stops, liquidations.',
    help: 'Charged on the value of every fill that crossed the book: a market entry, a stop, a flip, a timeout and a liquidation. Hyperliquid\'s base tier is 0.045%.' },

  { key: 'takeProfitPct', notFor: ['volbreak', 'trend', 'grid', 'tokyo', 'supertrend', 'dca'], label: 'Take profit', unit: '%', step: '0.05',
    hint: 'How far price must move your way to win.',
    help: 'Measured from the entry price, as a percentage. A long entered at $100 with 1% wins if any later candle trades at $101. Percent rather than a fixed amount so the same setting means the same on a $78,000 market and a $0.004 one.' },

  { key: 'stopLossPct', notFor: ['volbreak', 'trend', 'grid', 'tokyo', 'supertrend', 'dca'], label: 'Stop loss', unit: '%', step: '0.05',
    hint: 'How far against you before it is a loss.',
    help: 'The mirror of the target. Whichever level the price touches FIRST ends the trade, checked candle by candle after entry. If neither is ever touched before the data runs out, the trade is reported as unresolved: not a win, not a loss.' },

  { key: 'riskPct', label: 'Risk per trade', unit: '%', step: '0.25', group: 'riskModel',
    hint: 'Lost at the stop. The win follows the ratio.',
    help: 'The percentage of the balance a stop costs. A win pays that multiplied by the reward-to-risk the levels imply, so a 2% target against a 0.5% stop pays four times the risk. This is the model where changing the target changes the payout by itself.' },

  { key: 'winPct', label: 'Gain per win', unit: '%', step: '0.5', group: 'fixedModel',
    hint: 'What a win adds to the balance.',
    help: 'A flat percentage, NOT derived from the take profit. The target decides WHETHER you win; this decides HOW MUCH, and keeping the two consistent is on you. The defaults agree -- 1% against 0.5% is two-to-one, and so is 4% against 2%. Set a 5% target and leave this at 4% and the money stops describing the trade. Switch the model to risk-based if you would rather that followed automatically.' },

  { key: 'lossPct', label: 'Loss per stop', unit: '%', step: '0.5', group: 'fixedModel',
    hint: 'What a stop takes off the balance.',
    help: 'The same idea in reverse, and it assumes the stop filled exactly at its price. A candle that gapped straight through it would have cost more in reality, so a run over violent markets reads kinder than the truth.' },

  { key: 'feePct', label: 'Cost per trade', unit: '%', step: '0.005', group: 'useFees',
    hint: 'Charged on every trade taken.',
    help: 'A round-trip cost, charged whether the trade won, lost, or never resolved -- the position was opened either way. Under position sizing it is a percentage of the POSITION, which is how Hyperliquid charges: the base taker fee is 0.045% each way, so 0.09% for a trade opened and closed at market, less for resting orders. Under the fixed and risk models it is a percentage of the balance. Grid and DCA pay half of it on every fill. Turning fees off is a way to see how much of a result they were eating, not a realistic setting.' },

  { key: 'cooldownCandles', label: 'Cooldown', unit: 'candles', step: '1', group: 'useCooldown',
    hint: 'Candles to sit out after entering.',
    help: 'After a trade opens, this many candles are skipped before another can. Without it one violent stretch opens a cluster of near-identical trades and the result becomes a report on that single hour rather than on the rule. Turning it off is the fastest way to see how much of a result came from one moment.' },

  { key: 'trendMa', label: 'Trend average', unit: 'candles', step: '5', group: 'useTrendFilter',
    hint: 'Longs only above it, shorts only below.',
    help: 'A simple moving average of the close. With the filter on, a long is only taken when price is above it and a short only when below, so the rule is refused when it points against the larger move. An average with no value yet refuses the trade: an unknown trend is not an uptrend.' },

  { key: 'timeExitCandles', label: 'Give up after', unit: 'candles', step: '1', group: 'useTimeExit',
    hint: 'Close a trade that goes nowhere.',
    help: 'A trade still open after this many candles is closed at that candle price, whatever it is. It turns unresolved trades into real outcomes and stops one dead position sitting open for the rest of the run. Under the fixed money model a timeout scores as a full win or loss by which side of entry it ended on; the risk-based model can price the partial move properly.' },

  { key: 'trailPct', label: 'Trail distance', unit: '%', step: '0.05', group: 'useTrailing',
    hint: 'Stop follows this far behind the best price.',
    help: 'Once on, the stop moves up behind the best price the trade has reached and never moves back. It is extended only after a candle has failed to stop the trade, so the stop can never be moved out of the way of a hit that already happened. A tight trail turns winners into small wins; a loose one barely does anything.' },

  { key: 'maxConsecLosses', label: 'Stop after losses', unit: 'in a row', step: '1', group: 'useMaxLosses',
    hint: 'Halt the whole run on a losing streak.',
    help: 'The run stops entirely after this many consecutive losses, and the result says that it halted. It answers "would I have kept going", which a backtest that trades mechanically to the last candle never asks.' },
]

export const BT_CHOICES = [
  { key: 'gridSameCandle', label: 'Round trip inside one candle', strategy: 'grid',
    options: [['skip', 'Make the sell wait'], ['allow', 'Allow it']],
    help: 'A candle wide enough to touch two levels touched both prices, but its high, low, open and close cannot say it went down and then up rather than up and then down. Allowing the pair manufactures cycles out of volatility that may never have crossed -- on a volatile market it is the difference between 263 completed cycles and 400. Making the sell wait for a later candle is the honest reading and the default.' },

  { key: 'gridShort', label: 'Direction', strategy: 'grid',
    options: [['false', 'Long grid'], ['true', 'Short grid']],
    help: 'A long grid buys the dips and sells the rallies, ending up holding coins if price falls out of the range. A short grid does the mirror, ending up short if price rises out of it.' },

  { key: 'gridGeometric', label: 'Level spacing', strategy: 'grid',
    options: [['false', 'Even price gaps'], ['true', 'Even percent gaps']],
    help: 'Even price gaps put the rungs the same number of dollars apart. Even percent gaps put them the same percentage apart, so the lower rungs sit closer together -- which keeps the profit per cycle proportional across a wide range instead of shrinking at the bottom.' },

  { key: 'marginMode', label: 'Margin mode', group: 'hl',
    options: [['cross', 'Cross'], ['isolated', 'Isolated']],
    help: 'Cross backs the position with the WHOLE account: its liquidation price sits further away, and when it is hit it takes the account with it. Isolated backs it only with the margin posted for it: the line is closer, but a liquidation costs that margin and nothing else. For the same size, leverage moves the liquidation price only in isolated -- in cross it only decides how much margin the order needs.' },

  { key: 'sizeMode', label: 'Size each position by', group: 'hl',
    options: [['pct', '% of balance'], ['usd', 'USDC'], ['coin', 'Coin']],
    help: 'A share of the balance posted as margin (so the position grows and shrinks with the account), a fixed USDC value, or a fixed amount of the coin -- the three ways an order ticket takes a size.' },

  { key: 'orderUnit', label: 'Order sizes in', group: 'hl',
    options: [['usd', 'USDC'], ['coin', 'Coin']],
    help: 'Whether the order sizes above are USDC or an amount of the coin. In USDC every order is worth the same and buys more coins lower down; in coins every order is the same size and costs less lower down.' },

  { key: 'bbMode', label: 'Trade the band', strategy: 'bollinger',
    options: [['revert', 'Fade it (mean reversion)'], ['breakout', 'Follow it (breakout)']],
    help: 'A close outside the upper band can mean "stretched, due to snap back" or "breaking out, about to run". Fading shorts it; following buys it. They are opposite bets on the same candle, so on the same market one of them is usually the answer and the other the lesson.' },

  { key: 'dcaSide', label: 'Deal direction', strategy: 'dca',
    options: [['long', 'Long (buy the dips)'], ['short', 'Short (sell the rips)']],
    help: 'A long DCA buys more as price falls and closes on a bounce. A short DCA sells more as price rises and closes on a pullback -- the same machine pointed the other way, and in a market that trends up it is the one that gets carried off.' },

  { key: 'direction', label: 'Which side', group: 'useDirection',
    options: [['both', 'Both'], ['long', 'Long only'], ['short', 'Short only']],
    help: 'Green candles open longs and red ones open shorts. Restricting to one side is how you find out whether a rule has an edge or was carried by a market that only went one way. Note that "both" usually takes FEWER trades than long-only and short-only added together: a trade on one side starts the cooldown, which can block one on the other.' },

  { key: 'splitRisk', label: 'With several markets',
    options: [['true', 'Split the risk between them'], ['false', 'Each at full risk']],
    help: 'Several markets share ONE account here, so this decides what adding a market means. Splitting divides each stake by how many markets are running, which is what the deployed portfolio bot does: adding markets spreads the account rather than multiplying what it can lose. Full risk gives every market the whole stake, which answers a different question -- what each would have done with the account to itself -- and produces a much louder number. It has no effect on a single market.' },

  { key: 'ambiguous', notFor: ['trend', 'grid', 'tokyo', 'supertrend', 'dca'], label: 'If one candle hits both levels',
    options: [['loss', 'Count the stop'], ['win', 'Count the target']],
    help: 'Sometimes a single candle is wide enough to touch the target AND the stop. Its high, low, open and close cannot say which came first, so this is a guess either way. Counting the stop is the pessimistic reading and the default. On tight levels the difference is enormous -- the same rule can go from every trade winning to every trade losing.' },
]

/** Modules: a switch, what it turns on, and why you would. */
export const BT_MODULES = [
  { key: 'useOnePos',      label: 'One at a time',    blurb: 'Wait for a trade to close first.' },
  { key: 'useCooldown',    label: 'Cooldown',         blurb: 'Skip candles after entering.' },
  { key: 'useDirection',   label: 'Restrict side',    blurb: 'Longs only, or shorts only.' },
  { key: 'useTrendFilter', label: 'Trend filter',     blurb: 'Only trade with the longer trend.' },
  { key: 'useTimeExit',    label: 'Time exit',        blurb: 'Close a trade that goes nowhere.' },
  { key: 'useTrailing',    label: 'Trailing stop',    blurb: 'Move the stop up behind price.' },
  { key: 'useMaxLosses',   label: 'Stop on a streak', blurb: 'Halt the run after N losses.' },
  { key: 'useFees',        label: 'Trading costs',    blurb: 'Charge a fee on every trade.' },
]

export const BT_OVERVIEW = [
  ['What it does',
   'It walks through past candles one at a time and applies a rule, opening and closing trades exactly as that rule would have. Nothing is placed and no money moves; it is a report on history.'],
  ['One strategy, plus modules',
   'The strategy decides when a trade opens. Everything else is a module you can switch off. The useful question is rarely "did this work" but "which part was doing the work", and the only way to answer it is to turn pieces off one at a time.'],
  ['How a trade ends',
   'A target and a stop are set as percentages of the entry price. Each later candle is checked in turn and whichever level is touched first ends the trade. With the time exit on, a trade that reaches neither is closed at the price it had. A trade still open when the data ends is reported as unresolved.'],
  ['How the money is counted',
   'Position sizing is the default and the realistic one: each trade posts a share of the balance as margin, at a leverage, and gains or loses exactly what the price moved -- liquidated if the move takes the margin. Fixed mode instead adds or subtracts a flat percentage of the balance, so the size of the price move does not affect the result -- the levels decide whether you won, the gain and loss settings decide by how much. Risk-based mode sizes from the distance to the stop, so changing the target changes the payout on its own. Grid and DCA are paid in dollars by their own order sizes.'],
  ['The Hyperliquid account',
   'Under Hyperliquid sizing every position is what the exchange would open: a size in USDC, coins or a share of the balance; margin posted at a leverage capped at the market maximum; cross or isolated; maker and taker fees per fill; the $10 minimum. It is liquidated where equity meets maintenance margin -- half the initial margin at the market max leverage -- with cross counting the whole account and isolated only the margin posted. Orders the account could not margin are refused, and counted.'],
  ['What it cannot tell you',
   'It assumes you were filled at the closing price, that a stop or a liquidation filled exactly at its level, and that nothing gapped past it. Real fills are worse than all three. Funding payments are not included, and neither are the tiered margin requirements for very large positions. Treat a result as an upper bound, not a forecast.'],
]

/** Merge user input over the defaults, dropping anything that is not a number. */
/**
 * Several markets, one account.
 *
 * Running a rule on ZEC and then on XMR gives two results that cannot be added: each was
 * measured against its own starting balance, so their percentages overlap in time and
 * their drawdowns are not the drawdown of holding both. A portfolio is one balance, so the
 * trades have to be replayed against it IN THE ORDER THEY CLOSED.
 *
 * That is what this does. It takes the per-market runs for their trade lifecycles -- when
 * each opened, when it closed, whether it won and by how much relative to its stop -- and
 * re-books every one of them against a single running balance.
 *
 * `splitRisk` divides each trade's stake by the number of markets, which is what the
 * deployed portfolio bot does: adding markets should spread one account's risk, not
 * multiply it. Turning it off answers the other question -- what each market would have
 * done with the whole account behind it -- and the two are very different numbers.
 *
 * A trade still open when its market's candles ran out is skipped, exactly as it is in a
 * single-market run: counted there, never scored.
 */
export function runPortfolio(runs, params = {}) {
  const p = { ...BT_DEFAULTS, ...params }
  const live = (runs ?? []).filter(r => r && r.result && Array.isArray(r.result.trades))
  const split = p.splitRisk === false ? 1 : Math.max(1, live.length)

  const all = []
  for (const { coin, result } of live) {
    for (const t of result.trades) {
      if (t.outcome === 'open') continue
      // A trade acts on the balance when it CLOSES, not when it opened -- that is the
      // ordering that makes a shared balance mean anything.
      all.push({ ...t, coin, closedAt: t.exitAt ?? t.time })
    }
  }
  all.sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))

  let balance = p.startBalance, peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0
  const trades = []
  for (const t of all) {
    const long = t.side === 'long'
    const moved = t.exitPx != null ? (long ? t.exitPx - t.entry : t.entry - t.exitPx) : 0
    const slDist = t.sl != null ? Math.abs(t.entry - t.sl) : 0
    const cost = p.useFees ? balance * (p.feePct / 100) / split : 0
    let delta = -cost
    if (p.absolute) {
      // Each market ran as its own sub-account, with its own margin, refusals and
      // liquidations -- the only way those can be real. Its trades are dollars, summed.
      delta = t.delta
    } else if (t.sized || p.pnlModel === 'notional') {
      // Paid in dollars by the market's own run. Carried over as what it RETURNED on the
      // balance it had, shared out like every other stake.
      const ret = t.sized ? (t.ret ?? 0) : (t.balance - t.delta > 0 ? t.delta / (t.balance - t.delta) : 0)
      delta = balance * ret / split
    } else if (p.pnlModel === 'risk' && slDist > 0) {
      delta += balance * (p.riskPct / 100 / split) * (moved / slDist)
    } else if (t.outcome === 'win') delta += balance * (p.winPct / 100 / split)
    else if (t.outcome === 'loss') delta -= balance * (p.lossPct / 100 / split)
    balance += delta
    if (t.outcome === 'win') won++
    else if (t.outcome === 'loss') lost++
    peak = Math.max(peak, balance)
    if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)
    trades.push({ ...t, delta, balance })
  }

  // Per market, from the SHARED run rather than from its own -- so the rows add up to the
  // total instead of each describing a different hypothetical account.
  const byMarket = live.map(({ coin, result }) => {
    const mine = trades.filter(t => t.coin === coin)
    const open = (result.grid?.unrealized ?? result.dca?.unrealized ?? 0) / (p.absolute ? 1 : split)
    const net = mine.reduce((a, t) => a + t.delta, 0) + open
    const w = mine.filter(t => t.outcome === 'win').length
    const l = mine.filter(t => t.outcome === 'loss').length
    return {
      coin, trades: mine.length, won: w, lost: l,
      winRate: (w + l) > 0 ? (w / (w + l)) * 100 : null,
      netPnl: net,
      candles: result.candles,
      unresolved: result.trades.filter(t => t.outcome === 'open').length,
    }
  }).sort((a, b) => b.netPnl - a.netPnl)

  // A grid's inventory and a DCA's open deal are where those strategies lose, and neither
  // ever closes into a trade. Left out, a portfolio of them reported only the winning cycles.
  const openPnl = live.reduce((a, r) => a + (r.result.grid?.unrealized ?? r.result.dca?.unrealized ?? 0), 0) / (p.absolute ? 1 : split)
  balance += openPnl
  if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)
  const net = balance - p.startBalance
  const resolved = won + lost
  // Every closed grid cycle, and every DCA deal without a stop, wins by construction.
  const byConstruction = p.strategy === 'grid' || (p.strategy === 'dca' && !(p.dcaSlPct > 0))
  return {
    params: p, markets: live.map(r => r.coin), splitRisk: split > 1, openPnl,
    from: all.length ? Math.min(...all.map(t => t.time)) : null,
    to: all.length ? Math.max(...all.map(t => t.closedAt)) : null,
    candles: live.reduce((a, r) => a + (r.result.candles ?? 0), 0),
    trades, tradesMade: trades.length, won, lost,
    unresolved: live.reduce((a, r) => a + r.result.trades.filter(t => t.outcome === 'open').length, 0),
    timedOut: 0, halted: false,
    winRate: byConstruction ? null : resolved > 0 ? (won / resolved) * 100 : null,
    startBalance: p.startBalance, balance, netPnl: net,
    roe: p.startBalance > 0 ? (net / p.startBalance) * 100 : null,
    peak, maxDrawdown: maxDD,
    avgPerTrade: trades.length ? net / trades.length : 0,
    avgHeld: trades.length ? trades.reduce((a, t) => a + (t.heldFor ?? 0), 0) / trades.length : 0,
    byMarket,
    dca: _dcaAcross(live.map(r => r.result.dca).filter(Boolean), p.absolute ? 1 : split),
    refused: live.reduce((a, r) => a + (r.result.refused ?? 0), 0),
  }
}

/**
 * The DCA numbers across several markets. Counts add up; dollars are shared out the same way
 * the trades were; the deepest a deal ever went is the deepest on any market.
 */
function _dcaAcross(ds, split) {
  if (!ds.length) return undefined
  const sum = (k) => ds.reduce((a, d) => a + (d[k] ?? 0), 0)
  const max = (k) => Math.max(...ds.map(d => d[k] ?? 0))
  const hist = ds[0].soHist.map((_, k) => ds.reduce((a, d) => a + (d.soHist[k] ?? 0), 0))
  return {
    deals: sum('deals'), realized: sum('realized') / split, fees: sum('fees') / split,
    unrealized: sum('unrealized') / split, openCost: sum('openCost'), openSo: max('openSo'),
    openAvg: null, maxSo: max('maxSo'), soCount: ds[0].soCount, maxDeployed: max('maxDeployed'),
    soHist: hist, maxPossible: ds[0].maxPossible, maxPossibleMargin: ds[0].maxPossibleMargin,
    lastDev: ds[0].lastDev, markets: ds.length, lev: ds[0].lev, maxMargin: max('maxMargin'),
    refused: sum('refused'), soRefused: sum('soRefused'), liquidations: sum('liquidations'),
    closestLiq: ds.some(d => d.closestLiq != null) ? Math.min(...ds.filter(d => d.closestLiq != null).map(d => d.closestLiq)) : null,
  }
}

export function coerceParams(raw = {}) {
  const out = { ...BT_DEFAULTS }
  for (const f of BT_FIELDS) {
    // A time is not a number, and parseFloat is happy to say '07:00' is 7 and '99:99' is
    // 99 -- a silently different window instead of a rejected one. Handled below.
    if (f.type === 'time') continue
    const v = parseFloat(raw[f.key])
    // An empty box means "use the default", never 0 -- the distinction that turns a
    // cleared cooldown into no cooldown and a cleared baseline into whole-sample lookahead.
    if (Number.isFinite(v)) out[f.key] = v
  }
  for (const c of BT_CHOICES) {
    if (!c.options.some(o => o[0] === raw[c.key])) continue
    // A select carries strings; two of these are flags the engine reads as booleans.
    out[c.key] = (c.key === 'gridShort' || c.key === 'gridGeometric' || c.key === 'splitRisk')
      ? raw[c.key] === 'true' : raw[c.key]
  }
  // The window fields are times, not numbers: parseFloat('07:00') is 7, which would be a
  // silently different window rather than a rejected one.
  for (const k of ['tokyoLongFrom', 'tokyoLongTo', 'tokyoShortFrom', 'tokyoShortTo']) {
    if (Number.isFinite(hhmmToMinutes(raw[k]))) out[k] = String(raw[k]).trim()
  }
  if (BT_STRATEGIES.some(s => s[0] === raw.strategy)) out.strategy = raw.strategy
  if (raw.pnlModel === 'risk' || raw.pnlModel === 'fixed' || raw.pnlModel === 'notional') out.pnlModel = raw.pnlModel
  if (typeof raw.splitRisk === 'boolean') out.splitRisk = raw.splitRisk
  for (const m of BT_MODULES) {
    if (typeof raw[m.key] === 'boolean') out[m.key] = raw[m.key]
  }
  out.entryCategory = Math.max(1, Math.min(6, Math.round(out.entryCategory)))
  out.baselineLookback = Math.max(0, Math.round(out.baselineLookback))
  out.cooldownCandles = Math.max(0, Math.round(out.cooldownCandles))
  out.emaFast = Math.max(2, Math.round(out.emaFast))
  out.emaSlow = Math.max(2, Math.round(out.emaSlow))
  out.breakoutLookback = Math.max(2, Math.round(out.breakoutLookback))
  out.trendMa = Math.max(2, Math.round(out.trendMa))
  out.timeExitCandles = Math.max(1, Math.round(out.timeExitCandles))
  out.maxConsecLosses = Math.max(1, Math.round(out.maxConsecLosses))
  out.tokyoStopPct = Math.max(0, out.tokyoStopPct)
  out.rsiLen = Math.max(2, Math.round(out.rsiLen))
  out.rsiLow = Math.max(1, Math.min(99, out.rsiLow))
  out.rsiHigh = Math.max(out.rsiLow + 1, Math.min(99, out.rsiHigh))
  out.bbLen = Math.max(2, Math.round(out.bbLen))
  out.bbMult = Math.max(0.1, out.bbMult)
  out.macdFast = Math.max(2, Math.round(out.macdFast))
  out.macdSlow = Math.max(out.macdFast + 1, Math.round(out.macdSlow))
  out.macdSignal = Math.max(2, Math.round(out.macdSignal))
  out.crossFast = Math.max(2, Math.round(out.crossFast))
  out.crossSlow = Math.max(out.crossFast + 1, Math.round(out.crossSlow))
  out.stLen = Math.max(2, Math.round(out.stLen))
  out.stMult = Math.max(0.1, out.stMult)
  out.stStopPct = Math.max(0, out.stStopPct)
  out.dcaBaseUsd = Math.max(1, out.dcaBaseUsd)
  out.dcaSoUsd = Math.max(0, out.dcaSoUsd)
  out.dcaSoCount = Math.max(0, Math.min(25, Math.round(out.dcaSoCount)))
  out.dcaStepPct = Math.max(0.05, out.dcaStepPct)
  out.dcaStepScale = Math.max(0.5, Math.min(3, out.dcaStepScale))
  out.dcaVolScale = Math.max(0.5, Math.min(3, out.dcaVolScale))
  out.dcaTpPct = Math.max(0.05, out.dcaTpPct)
  out.dcaSlPct = Math.max(0, out.dcaSlPct)
  out.sizePct = Math.max(1, Math.min(100, out.sizePct))
  out.sizeUsd = Math.max(0, out.sizeUsd)
  out.sizeCoin = Math.max(0, out.sizeCoin)
  out.makerFeePct = Math.max(0, out.makerFeePct)
  out.takerFeePct = Math.max(0, out.takerFeePct)
  if (Number.isFinite(+raw.maxLev) && +raw.maxLev >= 1) out.maxLev = +raw.maxLev
  // Hyperliquid's own ceiling. Anything higher is a number, not a position anyone can open.
  out.leverage = Math.max(1, Math.min(50, out.leverage))
  return out
}
