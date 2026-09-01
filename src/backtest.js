/**
 * Backtest: replay a rule over historical candles and report what it would have done.
 *
 * Pure. Candles in, result out -- no fetching, no DOM, no timers. The app hands it
 * Hyperliquid candles; the arithmetic here has no idea where they came from.
 *
 * The rule is the one from the original simulator: classify each candle by how large its
 * range is against a baseline, and take a trade when that classification is extreme
 * enough. Direction comes from the candle's colour.
 *
 * THREE THINGS THAT WOULD OTHERWISE FLATTER THE RESULT, and are handled instead of
 * inherited. A backtest exists to tell you whether something worked; one that quietly
 * cheats is worse than none, because it is believed.
 *
 *   1. LOOKAHEAD IN THE BASELINE. The original averaged the range of every candle in the
 *      dataset, including candles after the trade, and compared each candle to that. No
 *      trader has that number at the time. The baseline here is a ROLLING average of the
 *      candles BEFORE the one being judged. Whole-sample is still available, and says so
 *      loudly, because comparing the two is the clearest way to see how much the lookahead
 *      was worth.
 *
 *   2. AMBIGUOUS CANDLES. When one candle's range covers both the take-profit and the
 *      stop, the original checked the target first and booked a win. Roughly half of those
 *      were losses. Which came first is unknowable from OHLC, so the default assumes the
 *      STOP -- the conservative reading -- and it is a setting, not a silent choice.
 *
 *   3. ABSOLUTE PRICE OFFSETS. The original added 0.01 to the price for a target, which is
 *      100 pips on EUR/USD and a rounding error on BTC. Targets and stops here are a
 *      PERCENTAGE of the entry price, which is the only form that means the same thing on
 *      a $0.004 market and a $78,000 one.
 */

export const BT_DEFAULTS = {
  startBalance: 1000,
  // Take a trade when the candle is this many multiples of the baseline range or more.
  entryCategory: 3,
  takeProfitPct: 1.0,     // % of entry price
  stopLossPct: 0.5,
  winPct: 4,              // % of balance gained on a win
  lossPct: 2,             // % of balance lost on a stop
  cooldownCandles: 4,     // candles to sit out after entering
  baselineLookback: 200,  // candles of history for the baseline; 0 = whole sample
  ambiguous: 'loss',      // 'loss' | 'win' -- when one candle covers both levels
  direction: 'both',      // 'both' | 'long' | 'short'
  feePct: 0.045,          // round-trip cost, % of notional; HL taker is ~0.045% total
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
  let runningSum = 0
  for (let i = 0; i < rows.length; i++) {
    let avg
    if (whole) {
      // Every candle in the set, including ones after this trade. Kept only so the cost of
      // that assumption can be measured; it is not a baseline anyone could have had.
      avg = rows.reduce((a, r) => a + r.range, 0) / rows.length
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
 * Walk the candles once, taking every trade the rule asks for and following each to its
 * target, its stop, or the end of the data.
 *
 * A trade still open when the candles run out is UNRESOLVED. It is not a win, not a loss,
 * and not excluded -- it is counted and reported, because a rule that opens trades nothing
 * ever closes is a fact about the rule.
 */
export function runBacktest(candles, params = {}) {
  const p = { ...BT_DEFAULTS, ...params }
  const rows = normalise(candles)
  const cats = classify(rows, p)

  let balance = p.startBalance
  let peak = p.startBalance, maxDD = 0
  let won = 0, lost = 0, cooldown = 0
  const trades = []

  for (let i = 0; i < rows.length; i++) {
    if (cooldown > 0) { cooldown--; continue }
    const cat = cats[i]
    if (cat == null || Math.abs(cat) < p.entryCategory) continue
    const long = cat > 0
    if ((long && p.direction === 'short') || (!long && p.direction === 'long')) continue

    const entry = rows[i].c
    const tp = long ? entry * (1 + p.takeProfitPct / 100) : entry * (1 - p.takeProfitPct / 100)
    const sl = long ? entry * (1 - p.stopLossPct / 100)   : entry * (1 + p.stopLossPct / 100)
    cooldown = p.cooldownCandles

    let outcome = 'open', exitAt = null, exitPx = null
    for (let x = i + 1; x < rows.length; x++) {
      const hitTp = long ? rows[x].h >= tp : rows[x].l <= tp
      const hitSl = long ? rows[x].l <= sl : rows[x].h >= sl
      if (hitTp && hitSl) {
        // Both levels inside one candle. OHLC cannot say which came first.
        outcome = p.ambiguous === 'win' ? 'win' : 'loss'
      } else if (hitTp) outcome = 'win'
      else if (hitSl) outcome = 'loss'
      else continue
      exitAt = rows[x].t
      exitPx = outcome === 'win' ? tp : sl
      break
    }

    // The cost is charged on every trade taken, including one that never resolved: the
    // position was opened, so it was paid for.
    const cost = balance * (p.feePct / 100)
    let delta = -cost
    if (outcome === 'win')  { delta += balance * (p.winPct / 100);  won++ }
    if (outcome === 'loss') { delta -= balance * (p.lossPct / 100); lost++ }
    balance += delta

    peak = Math.max(peak, balance)
    if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak * 100)

    trades.push({
      i, time: rows[i].t, category: cat, side: long ? 'long' : 'short',
      entry, tp, sl, outcome, exitAt, exitPx, balance,
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
    unresolved: trades.length - resolved,
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
    // The classification spread, for judging whether the threshold is sane for this market.
    catCounts: cats.reduce((m, c) => (c == null ? m : (m[c] = (m[c] ?? 0) + 1, m)), {}),
    avgRange: rows.length ? rows.reduce((a, r) => a + r.range, 0) / rows.length : 0,
  }
}

// ── the form ──────────────────────────────────────────────────────────────────
// Field definitions rather than hand-written markup, so the form, the defaults and the
// parameters the engine reads cannot drift apart: every box here is a key of BT_DEFAULTS.

export const BT_FIELDS = [
  { key: 'startBalance', label: 'Starting balance', unit: '$', step: '1',
    hint: 'What the run begins with.',
    help: 'Every gain and loss is a percentage of the balance at the time, so this scales the money but not the shape of the result. Doubling it doubles the profit and leaves the win rate and the drawdown percentage exactly where they were.' },

  { key: 'entryCategory', label: 'Entry category', unit: '×', step: '1',
    hint: 'How unusual a candle must be. 1-6.',
    help: 'Each candle is measured by its high-to-low range, divided by the average range of the candles before it. A category of 3 means "three times the recent normal". This is the trigger: any candle at or above it opens a trade, in the direction the candle closed. Higher is rarer and trades less; if a run reports no trades at all, this is usually why.' },

  { key: 'takeProfitPct', label: 'Take profit', unit: '%', step: '0.05',
    hint: 'How far price must move your way to win.',
    help: 'Measured from the entry price, as a percentage. A long entered at $100 with 1% wins if any later candle trades at $101. Percent rather than a fixed amount so the same setting means the same thing on a $78,000 market and a $0.004 one.' },

  { key: 'stopLossPct', label: 'Stop loss', unit: '%', step: '0.05',
    hint: 'How far against you before it is a loss.',
    help: 'The mirror of the target. Whichever level the price touches FIRST ends the trade, checked candle by candle after the entry. If neither is ever touched before the data runs out, the trade is reported as unresolved: not a win, not a loss.' },

  { key: 'winPct', label: 'Gain per win', unit: '%', step: '0.5',
    hint: 'What a win adds to the balance.',
    help: 'IMPORTANT, and the thing most people miss here: this is NOT derived from the take profit. The target decides WHETHER you win; this decides HOW MUCH. They are separate numbers and it is on you to keep them consistent. The defaults are (1% target, 0.5% stop) against (4% gain, 2% loss) -- both two-to-one, so they agree. Set the target to 5% and leave this at 4% and the money stops describing the trade.' },

  { key: 'lossPct', label: 'Loss per stop', unit: '%', step: '0.5',
    hint: 'What a stop takes off the balance.',
    help: 'Same idea as the gain, in reverse, and it assumes the stop filled exactly at its price. A candle that gapped straight through it would have cost more in reality, so a run with violent markets in it reads slightly kinder than the truth.' },

  { key: 'feePct', label: 'Cost per trade', unit: '%', step: '0.005',
    hint: 'Charged on every trade taken.',
    help: 'A round-trip cost, as a percentage of the balance. Charged whether the trade won, lost, or never resolved -- the position was opened either way. Hyperliquid taker fees come to roughly 0.045% in and out together, which is the default.' },

  { key: 'cooldownCandles', label: 'Cooldown', unit: 'candles', step: '1',
    hint: 'Candles to sit out after entering.',
    help: 'After a trade opens, this many candles are skipped before another can. Without it one violent stretch opens a cluster of near-identical trades and the result becomes a report on that single hour rather than on the rule.' },

  { key: 'baselineLookback', label: 'Baseline window', unit: 'candles', step: '10',
    hint: 'How much history counts as "normal".',
    help: 'The number of PAST candles whose ranges are averaged to decide what a normal candle looks like. Shorter reacts faster and calls more candles unusual; longer is steadier. Setting it to 0 averages the whole sample INCLUDING candles from after each trade -- a number nobody could have had at the time, which flatters the result. It is offered only so you can measure how much that assumption was worth.' },
]

export const BT_CHOICES = [
  { key: 'direction', label: 'Direction', options: [['both', 'Both'], ['long', 'Long only'], ['short', 'Short only']],
    help: 'Green candles open longs and red ones open shorts. Restricting to one side is how you find out whether a rule actually has an edge or was carried by a market that only went one way. Note that "both" usually takes FEWER trades than long-only and short-only added together: a trade on one side starts the cooldown, which can block one on the other.' },

  { key: 'ambiguous', label: 'If one candle hits both levels',
    options: [['loss', 'Count the stop'], ['win', 'Count the target']],
    help: 'Sometimes a single candle is wide enough to touch the target AND the stop. Its high, low, open and close cannot say which came first, so this is a guess either way. Counting the stop is the pessimistic reading and the default; counting the target is the optimistic one. On tight levels the difference is enormous -- the same rule can go from every trade winning to every trade losing.' },
]

/**
 * How the whole thing works, for the panel above the form. Kept here beside the parameters
 * it describes, so a change to the model and a change to the explanation are one edit.
 */
export const BT_OVERVIEW = [
  ['What it does',
   'It walks through past candles one at a time and applies a rule, opening and closing trades exactly as that rule would have. Nothing is placed and no money moves; it is a report on history.'],
  ['When it opens a trade',
   'Every candle is scored by how large its high-to-low range is against the recent average. A candle at or above the entry category opens a trade in the direction it closed -- green goes long, red goes short.'],
  ['How a trade ends',
   'A target and a stop are set as percentages of the entry price. Each later candle is checked in turn; whichever level is touched first ends the trade. A trade that touches neither before the data ends is reported as unresolved.'],
  ['How the money is counted',
   'A win adds a fixed percentage of the balance, a loss subtracts one, and every trade pays a cost. The size of the price move does NOT set the size of the result -- the target and stop decide whether you won, the gain and loss settings decide by how much.'],
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
  out.entryCategory = Math.max(1, Math.min(6, Math.round(out.entryCategory)))
  out.baselineLookback = Math.max(0, Math.round(out.baselineLookback))
  out.cooldownCandles = Math.max(0, Math.round(out.cooldownCandles))
  return out
}
