/**
 * INSOLVENT TERMINAL — watching a simulated run happen, instead of reading its total.
 *
 * The Trade Simulator answers "what would this rule have made" with a number and a table of
 * trades. Asked for: the same thing played back — "a replay mode similar as the one we have in
 * portfolio tab, but instead this replay would simulate where we would have buy/sell in the
 * assets charts". The Portfolio replay walks your real fills over your account curve; this
 * walks a backtest's imagined fills over the market's own candles.
 *
 * Pure, like backtest.js: trades and candles in, frames out. No DOM, no timers, no fetching —
 * which is what makes "does the marker land on the candle the trade actually happened on"
 * answerable without a browser.
 *
 * THE ONE RULE THAT MATTERS: nothing may appear before it happened. A replay whose chart
 * already shows a trade that is still in the future is not a replay, it is a spoiler, and the
 * entire point of watching one is to see the rule decide with only what it had. Every function
 * here takes the playhead and answers for that instant only.
 */

/**
 * Every fill a run would have made, as chart markers.
 *
 * Two per trade, not one: the entry AND the exit. A backtest trade is a round turn, and a
 * replay that only marks entries never shows you the losses being taken — which is the half
 * people most need to watch.
 *
 * `buy` is the direction of the FILL, not of the trade: a long's exit is a sell, and a short's
 * exit is a buy. Marking both ends of a short as sells would draw two red triangles for one
 * round turn and read as two entries.
 */
export function replayMarks(trades = []) {
  const out = []
  for (const t of trades ?? []) {
    if (!t || !Number.isFinite(+t.time)) continue
    const long = t.side === 'long'
    out.push({
      t: +t.time, v: +t.entry, buy: long, kind: 'entry',
      side: t.side, outcome: t.outcome ?? 'open',
    })
    // An unresolved trade has no exit yet — it was still open when the data ran out. Inventing
    // one at the last candle would report a close the rule never made.
    if (t.outcome !== 'open' && Number.isFinite(+t.exitAt) && Number.isFinite(+t.exitPx)) {
      out.push({
        t: +t.exitAt, v: +t.exitPx, buy: !long, kind: 'exit',
        side: t.side, outcome: t.outcome, delta: +t.delta,
      })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The markers that have happened by `tMax`. Everything later is still the future. */
export function marksUpto(marks = [], tMax = Infinity) {
  return (marks ?? []).filter(m => +m.t <= +tMax)
}

/**
 * The balance at the playhead: the starting balance plus every trade CLOSED by then.
 *
 * An open trade contributes nothing. Its profit is not real yet — it is a price on a screen
 * that can still go the other way — and counting it would make the balance jump at the moment
 * a trade opens, which is the one moment nothing has been earned.
 */
export function balanceAt(trades = [], tMax = Infinity, startBalance = 0) {
  let bal = +startBalance || 0
  for (const t of trades ?? []) {
    if (t?.outcome === 'open') continue
    if (!Number.isFinite(+t?.exitAt) || +t.exitAt > +tMax) continue
    bal += +t.delta || 0
  }
  return bal
}

/** The trade in flight at `tMax`, or null. Opened at or before it, not yet closed by it. */
export function openAt(trades = [], tMax = Infinity) {
  for (const t of trades ?? []) {
    if (!t || +t.time > +tMax) continue
    const closed = t.outcome !== 'open' && Number.isFinite(+t.exitAt) && +t.exitAt <= +tMax
    if (!closed) return t
  }
  return null
}

/**
 * How a run stands at the playhead: what is closed, what is open, what it is worth.
 *
 * Wins and losses are counted from CLOSED trades only, for the same reason the balance is.
 */
export function stateAt(trades = [], tMax = Infinity, startBalance = 0) {
  let won = 0, lost = 0, closed = 0
  for (const t of trades ?? []) {
    if (t?.outcome === 'open') continue
    if (!Number.isFinite(+t?.exitAt) || +t.exitAt > +tMax) continue
    closed++
    if (t.outcome === 'win') won++
    else if (t.outcome === 'loss') lost++
  }
  const balance = balanceAt(trades, tMax, startBalance)
  const resolved = won + lost
  return {
    balance,
    netPnl: balance - (+startBalance || 0),
    closed, won, lost,
    // Null, not 0, before anything has resolved: 0% reads as "it lost every time", which at
    // frame one is a claim about a rule that has not traded yet.
    winRate: resolved > 0 ? (won / resolved) * 100 : null,
    open: openAt(trades, tMax),
  }
}

/**
 * What an entry marker is worth at the playhead, for the open trade's running line.
 *
 * Marked to the candle's close, which is the only price the replay has revealed. Null when
 * nothing is open, so a caller shows a dash rather than a zero.
 */
export function openPnlAt(trade, price, startBalance, riskFrac) {
  if (!trade || !Number.isFinite(+price) || !Number.isFinite(+trade.entry) || +trade.entry === 0) return null
  const dir = trade.side === 'long' ? 1 : -1
  const move = ((+price - +trade.entry) / +trade.entry) * dir
  const stake = (+startBalance || 0) * (Number.isFinite(+riskFrac) ? +riskFrac : 0)
  return stake ? move * stake : move * 100   // a percentage when there is no stake to scale by
}

/** Frame count and the timestamp of a frame, so the caller need not know the row shape. */
export function frameCount(rows) { return Array.isArray(rows) ? rows.length : 0 }
export function frameTime(rows, i) {
  const r = (rows ?? [])[Math.max(0, Math.min((rows?.length ?? 1) - 1, i | 0))]
  return r ? +r.t : null
}
