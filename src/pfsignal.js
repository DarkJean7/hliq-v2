/**
 * A portfolio traded live with one of the Trade Simulator's strategies — decisions only.
 *
 * The rule: the bot does what the backtest does. Rather than a second implementation of RSI,
 * MACD, Supertrend and the rest that would drift from the one the page tests, the bot REPLAYS
 * the backtest's own engine (src/backtest.js runBacktest, given exactly what botRun gives it —
 * simParams) on each holding's latest closed candles, and copies the trade the replay is in:
 *
 *   the replay opens a trade on a candle after the bot started  → open it, with its stop and target
 *   the replay no longer holds the trade the bot holds          → close it (a flip, a signal exit)
 *   the exchange closed it first (its stop or target filled)    → done; wait for the next one
 *
 * Stops and targets rest ON THE EXCHANGE as trigger orders, so they fill inside a candle the way
 * the backtest assumes, and keep protecting the position if the bot is stopped.
 *
 * Each holding is its own sub-account, funded with its weight of the budget — botRun's model —
 * and trades only in the holding's direction unless "both directions" is on.
 *
 * Trades the replay was already in when the bot started are NOT joined: entering late, at a
 * different price, against the strategy's own stop and target, is not the strategy. The bot
 * waits for the next entry. Grid and DCA are ladders of resting orders, not one trade at a time,
 * and are not run here.
 */
import { runBacktest, BT_DEFAULTS } from './backtest.js'
import { simParams } from './pfbacktest.js'

export const SIGNAL_STRATEGIES = ['trend', 'volbreak', 'supertrend', 'emacross', 'macd', 'breakout', 'rsi', 'bollinger']
export const TF_MS = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
export const WARMUP = 300                     // closed candles replayed: enough for every indicator to settle

/** Candles the replay may read: those already closed at `now`, oldest first, at most WARMUP. */
export function closedCandles(candles, tf, now) {
  const ms = TF_MS[tf] ?? TF_MS['4h']
  return (candles ?? []).filter(c => Number(c.t) + ms <= now).sort((a, b) => a.t - b.t).slice(-WARMUP)
}

/** A level that means something: a price, not the 1e6% that switches a target or stop off. */
const sane = (lvl, entry) => (Number.isFinite(lvl) && lvl > 0 && lvl < entry * 50 && lvl > entry / 50 ? lvl : null)

/**
 * The trade the backtest is in at the end of `candles`, or null.
 *   ctx: { bal, side, both, lev, margin, feeBps } — the holding's sub-account, as botRun builds it
 * → { time (entry candle's open), side, entry, tp, sl }
 */
export function simOpenTrade(candles, strategy, params, ctx) {
  const sp = simParams(strategy, params, ctx)
  const r = runBacktest(candles, sp)
  const t = [...(r.trades ?? [])].reverse().find(x => x.outcome === 'open')
  if (!t) return null
  const p = { ...BT_DEFAULTS, ...sp }
  const long = t.side === 'long'
  // The Trend bot and Supertrend report their percentage stop only on closed trades; the level
  // is the same arithmetic.
  const pct = strategy === 'trend' ? p.trendStopPct : strategy === 'supertrend' ? p.stStopPct : 0
  const sl = t.sl ?? (pct > 0 ? t.entry * (long ? 1 - pct / 100 : 1 + pct / 100) : null)
  return { time: t.time, side: t.side, entry: t.entry, tp: sane(t.tp, t.entry), sl: sane(sl, t.entry) }
}

/**
 * What to do for one holding. Pure.
 *   sim: simOpenTrade's answer for the latest candles, or undefined when not read this time
 *   cur: { trade: { time, side, … } | null, lastTime: entry time of the last trade it took or skipped }
 *   startedAt: when the bot started; tf: the candle
 * → [{ do: 'close' } | { do: 'open', trade }]
 */
export function decideHolding({ sim, cur, startedAt, tf, now }) {
  if (sim === undefined) return []
  const ms = TF_MS[tf] ?? TF_MS['4h']
  const acts = []
  const held = cur?.trade ?? null
  if (held && (!sim || sim.time !== held.time || sim.side !== held.side)) acts.push({ do: 'close' })
  const enteredAt = sim ? sim.time + ms : 0                          // the entry candle's close
  const fresh = sim && enteredAt > startedAt                           // after the bot started
    && sim.time > (cur?.lastTime ?? -Infinity)                         // not one it already took
    && (!held || held.time !== sim.time)
    && now < enteredAt + ms                                            // and not a candle late
  if (fresh) acts.push({ do: 'open', trade: sim })
  return acts
}

/** Units for a sub-account of `bal` at `lev`, floored to the market's size decimals. */
export function openSize(bal, lev, px, szDec = 4) {
  if (!(bal > 0 && px > 0)) return 0
  const f = 10 ** szDec
  return Math.floor(bal * Math.max(1, lev) / px * f) / f
}

/** The sub-accounts a basket starts with: each holding's weight of the budget. */
export function freshSubs(weights, budget) {
  return Object.fromEntries(Object.entries(weights).map(([c, w]) => [c, { cash: budget * Math.abs(w), trade: null, lastTime: null }]))
}

/** A fill on one sub-account: cash moves by the price paid, less the fee. */
export function subFill(sub, signedSz, px, feeRate = 0.00045) {
  return { ...sub, cash: sub.cash - signedSz * px - Math.abs(signedSz * px) * feeRate }
}
