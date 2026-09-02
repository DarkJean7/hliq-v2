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
  pnlModel: 'fixed',      // 'fixed' | 'risk'
  winPct: 4,              // fixed: % of balance gained on a win
  lossPct: 2,             // fixed: % of balance lost on a stop
  riskPct: 1,             // risk: % of balance lost AT THE STOP; the win follows the ratio
  useFees: true,
  feePct: 0.045,

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
}

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
]

/**
 * Bots this engine cannot honestly simulate, and why. Listed rather than omitted: a
 * missing name reads as an oversight, and someone would reasonably assume the ones shown
 * are all there are.
 */
export const BT_UNSIMULATABLE = [
  ['Outcome Grid', 'A grid over prediction-market outcomes, which settle to 0 or 1 rather than trading continuously. The price series this reads does not describe them.'],
  ['DCA', 'Averages into a position over several entries with no per-entry stop. The trade lifecycle here is one entry, one exit.'],
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
 */
export const BT_TOKYO_TABLE = {
  ZEC:     { long: ['07:00', '21:00'], short: ['21:00', '07:00'], weight: 11.06 },
  CASHCAT: { long: ['02:00', '19:00'], short: ['19:00', '07:00'], weight:  9.93 },
  SMSN:    { long: ['23:00', '18:00'], short: ['18:00', '23:00'], weight:  8.72 },
  SKHX:    { long: ['04:00', '17:00'], short: ['17:00', '23:00'], weight:  8.27 },
  LIT:     { long: ['00:00', '18:00'], short: ['19:00', '00:00'], weight:  7.84 },
  XMR:     { long: ['16:00', '06:00'], short: ['06:00', '16:00'], weight:  7.50 },
  SNDK:    { long: ['23:00', '21:00'], short: ['21:00', '23:00'], weight:  7.40 },
  EWY:     { long: ['23:00', '19:00'], short: ['19:00', '23:00'], weight:  6.20 },
  MU:      { long: ['23:00', '21:00'], short: ['21:00', '23:00'], weight:  6.13 },
  NEAR:    { long: ['20:00', '17:00'], short: ['17:00', '20:00'], weight:  5.76 },
  DRAM:    { long: ['23:00', '19:00'], short: ['19:00', '23:00'], weight:  5.31 },
  PUMP:    { long: ['20:00', '18:00'], short: ['18:00', '20:00'], weight:  4.99 },
  INTC:    { long: ['09:00', '05:00'], short: ['05:00', '09:00'], weight:  4.67 },
  SPCX:    { long: ['23:00', '03:00'], short: ['03:00', '23:00'], weight:  3.35 },
  SOXL:    { long: ['14:00', '03:00'], short: ['03:00', '15:00'], weight:  2.86 },
}

/** The table row for a market id, with or without its builder-dex prefix. */
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

  const book = (entry, exit, side, outcome, openedAt, closedAt, heldFor) => {
    const long = side > 0
    const moved = long ? exit - entry : entry - exit
    const slDist = entry * stopFrac
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'risk' && slDist > 0) {
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
      outcome, exitAt: closedAt, exitPx: exit, heldFor, balance })
  }

  for (let i = 0; i < rows.length; i++) {
    const want = sig[i]
    if (want == null) continue
    const px = rows[i].c

    // The stop is checked against the candle's extreme, before anything else -- a stop that
    // was hit during the candle cannot be undone by where the candle happened to close.
    if (pos && stopFrac > 0) {
      const long = pos.side > 0
      const stopPx = long ? pos.entry * (1 - stopFrac) : pos.entry * (1 + stopFrac)
      if (long ? rows[i].l <= stopPx : rows[i].h >= stopPx) {
        book(pos.entry, stopPx, pos.side, 'loss', pos.i, rows[i].t, i - pos.i)
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

    if (!pos) pos = { side: want, entry: px, i }
  }

  // Whatever it was still holding when the data ended. Counted, never scored.
  const openTrade = pos
    ? [{ i: pos.i, time: rows[pos.i].t, side: pos.side > 0 ? 'long' : 'short', entry: pos.entry,
         tp: null, sl: null, outcome: 'open', exitAt: null, exitPx: null,
         heldFor: rows.length - 1 - pos.i, balance }]
    : []

  return { trades: [...trades, ...openTrade], balance, peak, maxDD, won, lost }
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

  const book = (entry, exit, side, openedAt, closedAt, heldFor, stopped) => {
    const long = side > 0
    const moved = long ? exit - entry : entry - exit
    const outcome = stopped ? 'loss' : moved > 0 ? 'win' : moved < 0 ? 'loss' : 'flat'
    const slDist = entry * stopFrac
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'risk' && slDist > 0) {
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
      outcome, exitAt: closedAt, exitPx: exit, heldFor, balance })
  }

  for (let i = 0; i < rows.length; i++) {
    const want = sig[i]
    if (want == null) continue          // the clock could not be read for this candle
    const px = rows[i].c

    // Checked against the candle's extreme and before anything else: a stop touched inside
    // the candle cannot be undone by where it happened to close.
    if (pos && stopFrac > 0) {
      const long = pos.side > 0
      const stopPx = long ? pos.entry * (1 - stopFrac) : pos.entry * (1 + stopFrac)
      if (long ? rows[i].l <= stopPx : rows[i].h >= stopPx) {
        book(pos.entry, stopPx, pos.side, pos.i, rows[i].t, i - pos.i, true)
        pos = null
      }
    }

    if (pos && want !== pos.side) {
      book(pos.entry, px, pos.side, pos.i, rows[i].t, i - pos.i, false)
      pos = null
    }
    if (!pos && want !== 0) pos = { side: want, entry: px, i }
  }

  // Whatever was still held when the candles ran out. Counted, never scored.
  const openTrade = pos
    ? [{ i: pos.i, time: rows[pos.i].t, side: pos.side > 0 ? 'long' : 'short', entry: pos.entry,
         tp: null, sl: null, outcome: 'open', exitAt: null, exitPx: null,
         heldFor: rows.length - 1 - pos.i, balance }]
    : []

  return { trades: [...trades, ...openTrade], balance, peak, maxDD, won, lost }
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
  const fee = p.useFees ? p.feePct / 100 / 2 : 0   // the flag is a round trip; each fill pays half

  // One slot per level that can hold a position: a long grid buys at i and sells at i+1,
  // so the top level has nothing to sell into. A short grid is the mirror.
  const slots = prices.map(() => null)
  let realized = 0, fees = 0, cycles = 0, buys = 0, sells = 0
  let inRange = 0, maxInventory = 0
  const trades = []

  for (const row of rows) {
    if (row.h >= lower && row.l <= upper) inRange++

    for (let i = 0; i < prices.length - 1; i++) {
      const openPx = short ? prices[i + 1] : prices[i]
      const closePx = short ? prices[i] : prices[i + 1]
      // Long: buy when the candle trades down to the level. Short: sell into a rise.
      const openTouched = short ? row.h >= openPx : row.l <= openPx
      const closeTouched = short ? row.l <= closePx : row.h >= closePx

      if (slots[i] == null && openTouched) {
        const sz = p.gridUsdPerLevel / openPx
        slots[i] = { px: openPx, sz, at: row.t, openedOn: row }
        fees += openPx * sz * fee
        buys++
        // Same candle: the close level was touched too, but OHLC cannot order the two.
        if (closeTouched && p.gridSameCandle !== 'allow') continue
      }

      if (slots[i] != null && closeTouched) {
        // A slot opened on THIS candle can only close now if same-candle trips are allowed.
        if (slots[i].openedOn === row && p.gridSameCandle !== 'allow') continue
        const { px, sz } = slots[i]
        const gain = short ? (px - closePx) * sz : (closePx - px) * sz
        realized += gain
        fees += closePx * sz * fee
        cycles++
        sells++
        trades.push({ i, time: slots[i].at, side: short ? 'short' : 'long', entry: px,
          tp: closePx, sl: null, outcome: 'win', exitAt: row.t, exitPx: closePx, heldFor: 0,
          balance: p.startBalance + realized - fees })
        slots[i] = null
      }
    }
    const held = slots.reduce((a, s) => a + (s ? s.sz : 0), 0)
    if (held > maxInventory) maxInventory = held
  }

  // What the grid was still holding when the data ended, valued at the last price. This is
  // where a grid loses, and it is the first number reported for that reason.
  const last = rows[rows.length - 1]?.c ?? 0
  const open = slots.filter(Boolean)
  const invSz = open.reduce((a, s) => a + s.sz, 0)
  const invCost = open.reduce((a, s) => a + s.px * s.sz, 0)
  const unrealized = invSz > 0
    ? (short ? invCost - invSz * last : invSz * last - invCost)
    : 0

  const balance = p.startBalance + realized - fees + unrealized
  return {
    grid: {
      lower, upper, levels: prices.length, prices,
      cycles, buys, sells,
      realized, fees, unrealized,
      inventorySize: invSz, inventoryCost: invCost, inventoryValue: invSz * last,
      maxInventory,
      inRangePct: rows.length ? (inRange / rows.length) * 100 : null,
      openSlots: open.length,
    },
    trades, balance,
    peak: Math.max(p.startBalance, balance),
    maxDD: 0,
    won: cycles, lost: 0,
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
  let won = 0, lost = 0, cooldown = 0, streak = 0, halted = false
  let trades = []

  // The Trend bot is always in a position, so it runs its own walk and rejoins here for
  // the reporting. Modules that describe entries -- cooldown, side, trend filter -- have
  // nothing to act on in a strategy that never sits out, and are simply not applied.
  if (p.strategy === 'grid') {
    const g = runGridBacktest(rows, p)
    const netG = g.balance - p.startBalance
    return {
      params: p, candles: rows.length,
      from: rows[0]?.t ?? null, to: rows[rows.length - 1]?.t ?? null,
      trades: g.trades, tradesMade: g.trades.length,
      won: g.won, lost: 0, unresolved: g.grid.openSlots, timedOut: 0, halted: false,
      // Deliberately null. Every completed cycle profits by construction, so a win rate
      // here is always 100% and would read as a perfect strategy.
      winRate: null,
      startBalance: p.startBalance, balance: g.balance, netPnl: netG,
      roe: p.startBalance > 0 ? (netG / p.startBalance) * 100 : null,
      peak: g.peak, maxDrawdown: g.maxDD,
      avgPerTrade: g.trades.length ? netG / g.trades.length : 0,
      avgHeld: 0, signalsSeen: g.grid.buys,
      grid: g.grid,
    }
  }

  if (p.strategy === 'trend') {
    const t = runTrendBot(rows, p, sig)
    trades = t.trades
    balance = t.balance; peak = t.peak; maxDD = t.maxDD; won = t.won; lost = t.lost
  }

  if (p.strategy === 'tokyo') {
    const t = runTokyoBot(rows, p, sig)
    trades = t.trades
    balance = t.balance; peak = t.peak; maxDD = t.maxDD; won = t.won; lost = t.lost
  }

  const ownWalk = p.strategy === 'trend' || p.strategy === 'tokyo'
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
    if (p.useCooldown) cooldown = p.cooldownCandles

    let stop = sl0, best = entry
    let outcome = 'open', exitAt = null, exitPx = null, heldFor = 0
    for (let x = i + 1; x < rows.length; x++) {
      heldFor = x - i
      const hitTp = long ? rows[x].h >= tp : rows[x].l <= tp
      const hitSl = long ? rows[x].l <= stop : rows[x].h >= stop
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
          break
        }
        continue
      }
      exitAt = rows[x].t
      exitPx = outcome === 'win' ? tp : stop
      break
    }

    // ── the money ─────────────────────────────────────────────────────────
    const cost = p.useFees ? balance * (p.feePct / 100) : 0
    let delta = -cost
    if (p.pnlModel === 'risk') {
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
      outcome, exitAt, exitPx, heldFor, balance,
    })
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

  { key: 'takeProfitPct', notFor: ['volbreak', 'trend', 'grid', 'tokyo'], label: 'Take profit', unit: '%', step: '0.05',
    hint: 'How far price must move your way to win.',
    help: 'Measured from the entry price, as a percentage. A long entered at $100 with 1% wins if any later candle trades at $101. Percent rather than a fixed amount so the same setting means the same on a $78,000 market and a $0.004 one.' },

  { key: 'stopLossPct', notFor: ['volbreak', 'trend', 'grid', 'tokyo'], label: 'Stop loss', unit: '%', step: '0.05',
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
    help: 'A round-trip cost as a percentage of the balance, charged whether the trade won, lost, or never resolved -- the position was opened either way. Hyperliquid taker fees come to roughly 0.045% in and out together. Turning fees off is a way to see how much of a result they were eating, not a realistic setting.' },

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

  { key: 'direction', label: 'Which side', group: 'useDirection',
    options: [['both', 'Both'], ['long', 'Long only'], ['short', 'Short only']],
    help: 'Green candles open longs and red ones open shorts. Restricting to one side is how you find out whether a rule has an edge or was carried by a market that only went one way. Note that "both" usually takes FEWER trades than long-only and short-only added together: a trade on one side starts the cooldown, which can block one on the other.' },

  { key: 'ambiguous', notFor: ['trend', 'grid', 'tokyo'], label: 'If one candle hits both levels',
    options: [['loss', 'Count the stop'], ['win', 'Count the target']],
    help: 'Sometimes a single candle is wide enough to touch the target AND the stop. Its high, low, open and close cannot say which came first, so this is a guess either way. Counting the stop is the pessimistic reading and the default. On tight levels the difference is enormous -- the same rule can go from every trade winning to every trade losing.' },
]

/** Modules: a switch, what it turns on, and why you would. */
export const BT_MODULES = [
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
   'Fixed mode adds or subtracts a flat percentage of the balance, so the size of the price move does not affect the result: the levels decide whether you won, the gain and loss settings decide by how much. Risk-based mode sizes from the actual distance to the stop, so changing the target changes the payout on its own.'],
  ['What it cannot tell you',
   'It assumes you were filled at the closing price, that the stop filled exactly at its level, and that nothing gapped past it. Real fills are worse than all three. Treat a result as an upper bound, not a forecast.'],
]

/** Merge user input over the defaults, dropping anything that is not a number. */
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
    out[c.key] = (c.key === 'gridShort' || c.key === 'gridGeometric') ? raw[c.key] === 'true' : raw[c.key]
  }
  // The window fields are times, not numbers: parseFloat('07:00') is 7, which would be a
  // silently different window rather than a rejected one.
  for (const k of ['tokyoLongFrom', 'tokyoLongTo', 'tokyoShortFrom', 'tokyoShortTo']) {
    if (Number.isFinite(hhmmToMinutes(raw[k]))) out[k] = String(raw[k]).trim()
  }
  if (BT_STRATEGIES.some(s => s[0] === raw.strategy)) out.strategy = raw.strategy
  if (raw.pnlModel === 'risk' || raw.pnlModel === 'fixed') out.pnlModel = raw.pnlModel
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
  return out
}
