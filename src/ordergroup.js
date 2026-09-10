/**
 * INSOLVENT TERMINAL — many orders, one intent
 *
 * A grid bot rests a ladder: twelve buys on the same coin at twelve prices. As twelve rows
 * that is twelve things to read and one thing to understand. Positions were collapsed the same
 * way (see posgroup.js); this does it for the order book.
 *
 * What may be joined, and what may NOT:
 *
 *   COIN + SIDE + KIND. Coin and side are obvious. Kind is the part worth being careful about:
 *   a resting limit buy, a take profit and a stop loss can all be "sell SOL", and they are
 *   three different intentions. A stop folded in with a take profit would report a ladder that
 *   does not exist and hide the one order that closes a losing trade.
 *
 * What the fold reports: the count, the total size, the total notional, the SIZE-WEIGHTED
 * average price, and the price RANGE. The range is the useful one for a ladder — "twelve buys
 * from $0.196 to $0.239" is the shape of the grid — and the average alone would hide it.
 *
 * Pure, so both shells fold identically and the arithmetic can be tested on its own.
 */

/** 'buy' | 'sell' — HL sends B/A, the app has also carried 'buy'/'sell' strings. */
export function orderSide(o) {
  const s = String(o?.side ?? '')
  if (s === 'B' || /^buy$/i.test(s)) return 'buy'
  if (s === 'A' || s === 'S' || /^sell$/i.test(s)) return 'sell'
  return 'sell'
}

/** The price this order actually rests at: the trigger when it has one, else the limit. */
export function orderPx(o) {
  const t = parseFloat(o?.triggerPx ?? 0)
  return t > 0 ? t : (parseFloat(o?.limitPx ?? 0) || 0)
}

/**
 * What the order is FOR. Three orders can be "sell SOL" and mean three different things, and
 * folding them together would report a ladder nobody placed.
 */
export function orderKind(o) {
  const ot = String(o?.orderType ?? '')
  if (ot.startsWith('Take Profit') || o?.triggerCondition === 'tp') return 'tp'
  if (ot.startsWith('Stop')        || o?.triggerCondition === 'sl') return 'sl'
  return o?.reduceOnly ? 'reduce' : 'limit'
}

export const ORDER_KIND_LABEL = {
  tp: 'Take profit', sl: 'Stop loss', reduce: 'Reduce only', limit: 'Limit',
}

export function orderGroupKey(o) {
  return `${o?.coin ?? ''}|${orderSide(o)}|${orderKind(o)}`
}

/**
 * Group, preserving arrival order.
 *
 * The caller has already sorted by whichever column was tapped; re-sorting here would silently
 * override it. The first member of a group decides where the group sits.
 */
export function groupOrders(orders) {
  const byKey = new Map()
  for (const o of orders ?? []) {
    const k = orderGroupKey(o)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(o)
  }
  return [...byKey.values()]
}

/** Fold a group into the one order-ladder it describes. */
export function aggregateOrderGroup(members) {
  const ms = members ?? []
  const first = ms[0] ?? {}
  const num = (v) => { const n = parseFloat(v ?? 0); return Number.isFinite(n) ? n : 0 }

  let totSz = 0, notional = 0, lo = Infinity, hi = -Infinity
  const accounts = new Set()
  for (const o of ms) {
    const sz = Math.abs(num(o.sz))
    const px = orderPx(o)
    totSz += sz
    notional += sz * px
    if (px > 0) { if (px < lo) lo = px; if (px > hi) hi = px }
    if (o._acct) accounts.add(o._acct)
  }
  return {
    coin: first.coin, side: orderSide(first), kind: orderKind(first),
    n: ms.length, members: ms,
    totSz, notional,
    // Size-weighted, so a ladder with one large rung reports where the money actually sits.
    avgPx: totSz > 0 ? notional / totSz : orderPx(first),
    loPx: Number.isFinite(lo) ? lo : 0,
    hiPx: Number.isFinite(hi) ? hi : 0,
    accounts: [...accounts],
    // A ladder spread over more than one price is worth showing as a range; a stack of orders
    // all at one price is not, and "$0.21 – $0.21" reads as a bug.
    spread: Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > 0,
  }
}

/**
 * What this order books if it fills — or null, because it opens rather than closes.
 *
 * The old rule was "only if it is flagged Take Profit, Stop, or reduce-only". That misses the
 * commonest closing order in this app: a grid's exit sells are plain limits with no flag on
 * them at all, and they were showing no PnL while doing exactly what a take profit does.
 *
 * The honest question is not what the order is LABELLED, it is whether it REDUCES a position
 * that exists. A sell against a long reduces it; a buy against a short reduces it; anything
 * else is opening, and an opening order has no PnL to state because there is nothing to close
 * against yet.
 *
 * An order can be both: sell 10 against a long of 6 closes 6 and opens 4 short. Only the
 * closing part has a PnL, and the opening part is reported separately so the caller can say so
 * rather than quoting a figure for the whole size.
 *
 * `sz` of 0 is HL's "close the whole position".
 */
export function expectedPnl(o, pos) {
  if (!o || !pos) return null
  const szi = parseFloat(pos.szi ?? 0)
  const entry = parseFloat(pos.entryPx ?? 0)
  const px = orderPx(o)
  if (!szi || !(entry > 0) || !(px > 0)) return null

  const long = szi > 0
  // Opposite side, or it is adding to the position rather than taking it off.
  if (long ? orderSide(o) !== 'sell' : orderSide(o) !== 'buy') return null

  const held = Math.abs(szi)
  const raw = Math.abs(parseFloat(o.sz ?? 0))
  const want = raw > 0 ? raw : held
  const closing = Math.min(want, held)
  const opening = Math.max(0, want - held)
  return {
    pnl: (long ? px - entry : entry - px) * closing,
    closing, opening, entry, px,
  }
}

/** The group's total, over the members that actually close something. */
export function groupExpectedPnl(members, pos) {
  let total = 0, any = false
  for (const o of members ?? []) {
    const e = expectedPnl(o, pos)
    if (!e) continue
    any = true
    total += e.pnl
  }
  return any ? total : null
}

/**
 * How far the nearest rung is from the mark, as a percentage. The group's headline distance:
 * of a whole ladder, the one that matters is the one about to fill.
 */
export function nearestAwayPct(group, markPx) {
  const mk = parseFloat(markPx ?? 0)
  if (!(mk > 0) || !group?.members?.length) return null
  let best = null
  for (const o of group.members) {
    const px = orderPx(o)
    if (!(px > 0)) continue
    const d = (px - mk) / mk * 100
    if (best == null || Math.abs(d) < Math.abs(best)) best = d
  }
  return best
}
