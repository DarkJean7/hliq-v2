/**
 * Replay: watch a market, or an account, play forward with the trades landing as they
 * happened.
 *
 * Pure. It is handed candles and fills and returns, for every step, what was true at that
 * moment -- position, average entry, realised and unrealised. No DOM, no timers, no
 * fetching: the player in main.js owns the clock, this owns the arithmetic.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a replay must never show the future. Every figure
 * here is computed from fills at or before the step being asked about, and nothing reads
 * ahead. That sounds obvious and is easy to lose -- a y-axis scaled to the whole range
 * gives away that a big move is coming, and a "total PnL" taken from the last fill spoils
 * the ending on the first frame. The chart scales to what has been revealed for the same
 * reason.
 */

/** BUY is the side that increases a long. HL says 'B'; the parsed fills say 'BUY'. */
function isBuy(f) {
  if (f?.rawSide) return f.rawSide === 'B'
  return String(f?.side ?? '').toUpperCase() === 'BUY'
}

/**
 * Walk the fills once and record the running state after each one.
 *
 * Realised is net of fees, matching every other realised figure in the app -- Hyperliquid
 * charges on the way in as well as out, so counting only closedPnl overstates what was
 * kept.
 *
 * Average entry follows the position: adding to it blends, reducing it leaves it alone,
 * and flipping through zero starts a new one at the fill price. Getting that wrong makes
 * unrealised PnL drift for the rest of the replay.
 */
export function walkFills(fills) {
  const out = []
  let szi = 0, entry = 0, realized = 0, fees = 0, volume = 0
  for (const f of [...(fills ?? [])].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))) {
    const px = +f.px, sz = Math.abs(+f.sz)
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue
    const signed = isBuy(f) ? sz : -sz
    const next = szi + signed
    const fee = +(f.fee ?? 0) || 0

    if (szi === 0 || Math.sign(signed) === Math.sign(szi)) {
      // Opening, or adding to what is already there: blend the entry by size.
      entry = szi === 0 ? px : (entry * Math.abs(szi) + px * sz) / (Math.abs(szi) + sz)
    } else if (Math.sign(next) !== Math.sign(szi) && next !== 0) {
      // Flipped clean through zero -- the old entry describes a position that no longer
      // exists, so the remainder starts fresh at this price.
      entry = px
    }
    // Reducing without flipping keeps the entry it was opened at.

    szi = Math.abs(next) < 1e-12 ? 0 : next
    if (szi === 0) entry = 0
    realized += (+(f.closedPnl ?? 0) || 0) - fee
    fees += fee
    volume += px * sz
    out.push({
      time: +f.time, px, sz, buy: isBuy(f), coin: f.coin, dir: f.dir ?? '',
      closedPnl: +(f.closedPnl ?? 0) || 0, fee,
      szi, entry, realized, fees, volume, trades: out.length + 1,
    })
  }
  return out
}

/**
 * What was true at `t`. `steps` comes from walkFills. Returns the state after the last
 * fill at or before `t` -- never the next one.
 */
export function stateAt(steps, t, mark = null) {
  const base = { szi: 0, entry: 0, realized: 0, fees: 0, volume: 0, trades: 0, unrealized: 0, last: null }
  if (!steps?.length) return base
  let lo = 0, hi = steps.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (steps[mid].time <= t) { found = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (found < 0) return base
  const s = steps[found]
  const unreal = (s.szi !== 0 && Number.isFinite(+mark)) ? s.szi * (+mark - s.entry) : 0
  return { ...base, ...s, unrealized: unreal, last: s }
}

/** The fills that have landed by `t`, as chart markers. */
export function markersUpto(steps, t) {
  const out = []
  for (const s of steps ?? []) {
    if (s.time > t) break
    out.push({ t: s.time, px: s.px, buy: s.buy, sz: s.sz, closedPnl: s.closedPnl })
  }
  return out
}

/**
 * Turn a step count into a timestamp, and back. The replay advances over the CANDLE
 * series, not over the fills: a market that did nothing for six hours should take six
 * hours of replay, and stepping fill-to-fill would skip exactly the waiting that makes a
 * position worth watching.
 */
export function frameCount(points) { return Math.max(0, (points?.length ?? 0)) }

export function frameTime(points, i) {
  if (!points?.length) return 0
  const k = Math.max(0, Math.min(points.length - 1, Math.round(i)))
  return +points[k][0]
}

/**
 * A summary of the whole replay, for the panel under the player. Everything here is
 * "so far", never the final total.
 */
export function summarise(steps, t, mark) {
  const s = stateAt(steps, t, mark)
  const seen = (steps ?? []).filter(x => x.time <= t)
  const closes = seen.filter(x => x.closedPnl !== 0)
  const wins = closes.filter(x => x.closedPnl - x.fee > 0).length
  // What was spent and what came back, in dollars at the prices actually paid. Both are
  // running totals, so they read the way a ledger does rather than as a net figure that
  // hides how much was put at risk to get it.
  let bought = 0, sold = 0
  for (const x of seen) {
    const notional = x.px * x.sz
    if (x.buy) bought += notional; else sold += notional
  }
  return {
    ...s,
    net: s.realized + s.unrealized,
    closes: closes.length,
    wins,
    winRate: closes.length ? (wins / closes.length) * 100 : null,
    bought,
    sold,
    // What the open position is worth at the price on screen. Zero when flat, and null
    // would be wrong here -- flat is a known state, not an unknown one.
    holding: (s.szi !== 0 && Number.isFinite(+mark)) ? Math.abs(s.szi) * +mark : 0,
  }
}
