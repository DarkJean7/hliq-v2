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
  strategy: 'range',      // 'range' | 'emacross' | 'breakout'
  entryCategory: 3,       // range: candle must be this many times the baseline
  baselineLookback: 200,  // range: candles of PAST history for the baseline; 0 = whole sample
  emaFast: 9,             // emacross
  emaSlow: 21,
  breakoutLookback: 20,   // breakout: prior candles whose high/low must be cleared

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
}

export const BT_STRATEGIES = [
  ['range',    'Range category', 'A candle whose high-to-low range is unusually large against recent history opens a trade in the direction it closed.'],
  ['emacross', 'EMA cross',      'A fast average crossing a slow one opens a trade in the direction of the cross. The same idea as the Trend bot.'],
  ['breakout', 'Breakout',       'A close beyond the highest high or lowest low of the previous N candles opens a trade that way. The same idea as the Volatility Breakout bot.'],
]

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
  if (p.strategy === 'emacross') {
    const f = ema(rows, Math.max(2, Math.round(p.emaFast)))
    const s = ema(rows, Math.max(2, Math.round(p.emaSlow)))
    for (let i = 1; i < rows.length; i++) {
      if (f[i] == null || s[i] == null || f[i - 1] == null || s[i - 1] == null) continue
      const was = f[i - 1] - s[i - 1], now = f[i] - s[i]
      out[i] = (was <= 0 && now > 0) ? 1 : (was >= 0 && now < 0) ? -1 : 0
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
export function runBacktest(candles, params = {}) {
  const p = { ...BT_DEFAULTS, ...params }
  const rows = normalise(candles)
  const sig = signals(rows, p)
  const trend = p.useTrendFilter ? sma(rows, Math.max(2, Math.round(p.trendMa))) : null

  let balance = p.startBalance
  let peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0, cooldown = 0, streak = 0, halted = false
  const trades = []

  for (let i = 0; i < rows.length && !halted; i++) {
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
    const tp = long ? entry * (1 + p.takeProfitPct / 100) : entry * (1 - p.takeProfitPct / 100)
    const sl0 = long ? entry * (1 - p.stopLossPct / 100) : entry * (1 + p.stopLossPct / 100)
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
      const rr = p.stopLossPct > 0 ? p.takeProfitPct / p.stopLossPct : 0
      if (outcome === 'win') { delta += balance * (p.riskPct / 100) * rr; won++ }
      else if (outcome === 'loss') { delta -= balance * (p.riskPct / 100); lost++ }
      else if (outcome === 'timeout' && exitPx != null) {
        // Closed where it stood, not at either level, so it is valued by how far it got.
        const moved = (long ? exitPx - entry : entry - exitPx) / entry * 100
        delta += balance * (p.riskPct / 100) * (p.stopLossPct > 0 ? moved / p.stopLossPct : 0)
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

  { key: 'emaFast', label: 'Fast EMA', unit: 'candles', step: '1', strategy: 'emacross',
    hint: 'The quicker average.',
    help: 'The shorter exponential moving average. A trade opens on the candle where it crosses the slow one: upward for a long, downward for a short. Shorter means more crosses and more noise.' },

  { key: 'emaSlow', label: 'Slow EMA', unit: 'candles', step: '1', strategy: 'emacross',
    hint: 'The slower average.',
    help: 'The longer exponential moving average, the one being crossed. It should be meaningfully longer than the fast one; two similar lengths cross constantly and produce trades with no information in them.' },

  { key: 'breakoutLookback', label: 'Breakout window', unit: 'candles', step: '1', strategy: 'breakout',
    hint: 'Candles whose extreme must be cleared.',
    help: 'A close above the highest high of this many previous candles opens a long; a close below the lowest low opens a short. Longer windows fire rarely and on bigger moves.' },

  { key: 'takeProfitPct', label: 'Take profit', unit: '%', step: '0.05',
    hint: 'How far price must move your way to win.',
    help: 'Measured from the entry price, as a percentage. A long entered at $100 with 1% wins if any later candle trades at $101. Percent rather than a fixed amount so the same setting means the same on a $78,000 market and a $0.004 one.' },

  { key: 'stopLossPct', label: 'Stop loss', unit: '%', step: '0.05',
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
  { key: 'direction', label: 'Which side', group: 'useDirection',
    options: [['both', 'Both'], ['long', 'Long only'], ['short', 'Short only']],
    help: 'Green candles open longs and red ones open shorts. Restricting to one side is how you find out whether a rule has an edge or was carried by a market that only went one way. Note that "both" usually takes FEWER trades than long-only and short-only added together: a trade on one side starts the cooldown, which can block one on the other.' },

  { key: 'ambiguous', label: 'If one candle hits both levels',
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
    const v = parseFloat(raw[f.key])
    // An empty box means "use the default", never 0 -- the distinction that turns a
    // cleared cooldown into no cooldown and a cleared baseline into whole-sample lookahead.
    if (Number.isFinite(v)) out[f.key] = v
  }
  for (const c of BT_CHOICES) {
    if (c.options.some(o => o[0] === raw[c.key])) out[c.key] = raw[c.key]
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
  return out
}
