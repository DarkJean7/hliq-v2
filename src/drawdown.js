/**
 * INSOLVENT TERMINAL — per-trade drawdown (maximum adverse excursion)
 *
 * "How far did this trade go against me before it ended." The realised PnL says where a
 * trade finished; this says where it was at its worst. A +$40 trade that was -$300 on the
 * way is not the same trade as a +$40 that never went red, and the fill history cannot tell
 * them apart -- fills record the moments you acted, never the ground between them.
 *
 * Two halves, deliberately separate:
 *
 *   pairTrades(fills)  — turns a stream of fills into round trips. Pure, testable, no
 *                        network. This is the part that is easy to get quietly wrong.
 *   maxAdverse(trip, candles) — walks a price path and returns the worst point.
 *
 * The candles are the caller's problem, because fetching them is the expensive part:
 * Hyperliquid rate-limits by IP across the whole app, so this must never fan out over a
 * page of history on its own. `drawdownFor` fetches ONE trade's window, on demand, and
 * caches the answer.
 */

/**
 * Round trips, from a coin's fills in time order.
 *
 * Netting, not FIFO lot matching. A position is open while its signed size is non-zero, and
 * the trip ends the moment it returns to zero -- which is how the exchange itself accounts
 * for a perp position, and what `closedPnl` on the closing fill is measured against. Trying
 * to match individual lots would invent trades the account never had.
 *
 * A flip (long 2, then sell 5) closes the long and opens a short in one fill. The close is
 * recorded at that fill and the new leg starts there with the remainder.
 *
 * Entry price is size-weighted across every fill that ADDED to the position, so a scaled-in
 * position is measured against what it actually cost, not against its first tick.
 */
export function pairTrades(fills) {
  const byCoin = new Map()
  for (const f of (fills ?? [])) {
    if (!f?.coin || !Number.isFinite(f.px) || !Number.isFinite(f.sz) || f.sz <= 0) continue
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, [])
    byCoin.get(f.coin).push(f)
  }

  const trips = []
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time || (a.tid ?? 0) - (b.tid ?? 0))
    let pos = 0            // signed size held
    let cost = 0           // size-weighted entry cost of the open leg
    let open = null        // the trip being built

    for (const f of list) {
      const signed = f.side === 'BUY' ? f.sz : -f.sz
      const before = pos
      const adding = before === 0 || Math.sign(signed) === Math.sign(before)

      if (adding) {
        if (!open) open = { coin, side: signed > 0 ? 'LONG' : 'SHORT', entryTime: f.time, fills: 0, closedPnl: 0, fee: 0 }
        cost += Math.abs(signed) * f.px
        pos  += signed
        open.size = Math.abs(pos)
      } else {
        // Reducing, closing, or flipping. Counted here, before the leg can be closed and
        // set to null below -- otherwise the fill that ENDS a trade is missing from it.
        if (open) { open.fills++; open.fee += (f.fee || 0) }
        const closing = Math.min(Math.abs(signed), Math.abs(before))
        if (open) {
          open.closedPnl += (f.closedPnl || 0)
          open.exitTime   = f.time
          open.exitPx     = f.px
        }
        cost -= closing * (Math.abs(before) > 0 ? cost / Math.abs(before) : 0)
        pos  += signed

        if (Math.abs(pos) < 1e-12) pos = 0
        if (pos === 0 && open) {
          open.entryPx = open.size > 0 ? (open.entryCost ?? 0) / open.size : f.px
          trips.push(finish(open, f))
          open = null; cost = 0
        } else if (open && Math.sign(pos) !== Math.sign(before) && pos !== 0) {
          // Flipped through zero: close the old leg here, start the new one at this fill.
          trips.push(finish(open, f))
          open = { coin, side: pos > 0 ? 'LONG' : 'SHORT', entryTime: f.time, fills: 0, closedPnl: 0, fee: 0, size: Math.abs(pos) }
          cost = Math.abs(pos) * f.px
        }
      }
      // Adding legs are counted here; a reducing fill was already counted above.
      if (open && adding) { open.fills++; open.fee += (f.fee || 0) }
      if (open) open.entryCost = cost
    }
    // Whatever is still open is a position, not a trade. It has no exit, so it has no
    // completed drawdown -- reporting one would be reporting an unfinished number.
    if (open) trips.push(finish(open, null, true))
  }

  function finish(t, f, stillOpen = false) {
    const size = t.size || 0
    return {
      coin: t.coin,
      side: t.side,
      size,
      entryTime: t.entryTime,
      entryPx: size > 0 && Number.isFinite(t.entryCost) ? Math.abs(t.entryCost) / size : (t.entryPx ?? 0),
      exitTime: stillOpen ? null : (t.exitTime ?? f?.time ?? null),
      exitPx:   stillOpen ? null : (t.exitPx ?? f?.px ?? null),
      closedPnl: t.closedPnl,
      fee: t.fee,
      fills: t.fills,
      open: stillOpen,
    }
  }

  return trips.sort((a, b) => (b.exitTime ?? b.entryTime) - (a.exitTime ?? a.entryTime))
}

/**
 * The worst the trade ever looked, from a price path covering its life.
 *
 * Adverse means against the side held: the lowest low for a long, the highest high for a
 * short. Returns null when there is no path to read -- an empty candle list means "we did
 * not look", and answering 0 to that would claim a trade never went against you.
 *
 * `usd` is the unrealised loss at that worst point, at the size held. It is an approximation
 * for a position that was scaled in or out, because the size is taken as the peak size; the
 * price figures are exact.
 */
export function maxAdverse(trip, candles) {
  if (!trip || !Array.isArray(candles) || !candles.length) return null
  const entry = Number(trip.entryPx)
  if (!(entry > 0)) return null
  const from = Number(trip.entryTime), to = Number(trip.exitTime ?? Date.now())

  // A bar's own width, inferred from the series, rather than a fixed slop. A candle counts
  // when its window OVERLAPS the trade's life, which keeps the bar the entry happened inside
  // and drops the ones before it. A fixed 60s pad was right for 1m candles and nonsense for
  // daily ones, where a whole day of price before the trade would have counted as part of it.
  let bar = 0
  for (let i = 1; i < candles.length; i++) {
    const d = Number(candles[i].t ?? 0) - Number(candles[i - 1].t ?? 0)
    if (d > 0) { bar = d; break }
  }

  let worst = null, at = null
  for (const k of candles) {
    const t = Number(k.t ?? k.T ?? 0)
    if (!(t + bar > from && t <= to)) continue
    const px = trip.side === 'LONG' ? Number(k.l) : Number(k.h)
    if (!Number.isFinite(px) || px <= 0) continue
    if (worst === null || (trip.side === 'LONG' ? px < worst : px > worst)) { worst = px; at = t }
  }
  if (worst === null) return null

  // A trade that never traded below its entry has no drawdown; that is a real zero, and
  // distinct from the null above.
  const move = trip.side === 'LONG' ? (worst - entry) / entry : (entry - worst) / entry
  const pct  = Math.min(0, move) * 100
  return {
    px: worst,
    at,
    pct,
    usd: -Math.abs(pct / 100) * entry * (Number(trip.size) || 0),
  }
}

/** A candle interval that covers a window in a reasonable number of bars. */
export function intervalFor(ms) {
  const h = ms / 3_600_000
  if (h <= 4)   return '1m'
  if (h <= 24)  return '5m'
  if (h <= 24 * 7)  return '1h'
  if (h <= 24 * 60) return '4h'
  return '1d'
}

const _cache = new Map()
export function drawdownCacheKey(trip) {
  return [trip.coin, trip.side, trip.entryTime, trip.exitTime ?? 'open', trip.size].join('|')
}

/**
 * One trade's drawdown, fetched on demand.
 *
 * `fetchCandles(coin, interval, startMs, endMs)` is injected so this module never reaches
 * the network itself and stays testable. Cached by trade: the answer for a finished trade
 * cannot change, and re-opening a row should cost nothing.
 *
 * Deliberately one trade at a time. Hyperliquid's rate limit is per IP and shared with
 * everything else the app is doing, so a page of history asking for thirty candle sets at
 * once is how the limiter gets tripped for the whole terminal.
 */
export async function drawdownFor(trip, fetchCandles) {
  const key = drawdownCacheKey(trip)
  if (_cache.has(key)) return _cache.get(key)
  const from = Number(trip.entryTime)
  const to   = Number(trip.exitTime ?? Date.now())
  if (!(from > 0) || !(to >= from)) return null
  const span = Math.max(to - from, 60_000)
  let out = null
  try {
    const candles = await fetchCandles(trip.coin, intervalFor(span), from - 60_000, to + 60_000)
    out = maxAdverse(trip, candles ?? [])
  } catch {
    out = null            // could not look; the caller must not render this as zero
  }
  if (out) _cache.set(key, out)
  return out
}
