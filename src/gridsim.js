/**
 * Grid Ladder — a simulated Hyperliquid account for one bot.
 *
 * The same adapter interface the live bot gets from strategies/gridladder.js, so dry-run, the
 * backtester and the restart / dropped-socket tests all drive the REAL runner and engine, not
 * a copy of them. What it imitates, because the runner depends on it:
 *
 *   - post-only (Alo) orders that would cross are REJECTED with Hyperliquid's own wording,
 *     including the "bbo was bid@ask" the runner re-prices from
 *   - the $10 minimum, a duplicate cloid, a reduce-only order with nothing to reduce
 *   - resting orders fill at their own price when the price trades through them (maker fee);
 *     Ioc fills at the touch (taker fee)
 *   - fills carry tid, cloid, px, sz, fee and time, and are kept for fillsSince()
 *   - the "socket" can be dropped: fills and order updates still happen, nothing is delivered
 *
 * Pure apart from the callbacks it is handed. Time is whatever setMid() is told.
 */
import { MAKER_FEE, TAKER_FEE, MIN_NOTIONAL, roundPx, tickOf } from './gridladder.js'

export function createSimExchange({ szDecimals = 2, maxLeverage = 10, mid = 80, cash = 1000, time = 0, makerFee = MAKER_FEE, takerFee = TAKER_FEE } = {}) {
  let px = mid, now = time, nextOid = 1, nextTid = 1
  const orders = new Map()          // oid -> {oid, cloid, isBuy, px, sz, reduceOnly}
  const usedCloids = new Set()
  const fills = []
  let pos = 0, entry = 0, realized = 0, feesPaid = 0, fundingPaid = 0
  const subs = { fills: new Set(), updates: new Set() }
  let socketUp = true

  const bbo = () => {
    const t = tickOf(px, szDecimals)
    const bid = roundPx(px, szDecimals, 'down')
    return { bid, ask: +(bid + t).toFixed(8) }
  }
  const emit = (kind, v) => { if (socketUp) for (const cb of subs[kind]) cb(v) }

  function trade(o, fillPx, sz, maker) {
    const fee = fillPx * sz * (maker ? makerFee : takerFee)
    const signed = o.isBuy ? sz : -sz
    if (pos >= 0 && signed > 0) { entry = (entry * pos + fillPx * sz) / (pos + sz); pos += sz }
    else { realized += (fillPx - entry) * Math.min(sz, Math.abs(pos)) * (pos > 0 ? 1 : -1); pos += signed; if (Math.abs(pos) < 1e-9) { pos = 0; entry = 0 } }
    feesPaid += fee
    const f = { tid: String(nextTid++), oid: o.oid, cloid: o.cloid, coin: 'HYPE', px: String(fillPx), sz: String(+sz.toFixed(szDecimals)), side: o.isBuy ? 'B' : 'A', fee: String(fee), time: now }
    fills.push(f)
    emit('fills', [f])
    return f
  }

  /** Fill whatever the move from the last price to `p` traded through, nearest first. */
  function cross(p) {
    const hit = [...orders.values()].filter(o => (o.isBuy ? o.px >= p : o.px <= p))
    hit.sort((a, b) => (p < px ? b.px - a.px : a.px - b.px))
    for (const o of hit) {
      let sz = o.sz
      if (o.reduceOnly) sz = Math.min(sz, Math.max(0, o.isBuy ? -pos : pos))
      orders.delete(o.oid)
      if (sz > 0) trade(o, o.px, sz, true)
      emit('updates', [{ order: { oid: o.oid, cloid: o.cloid }, status: sz > 0 ? 'filled' : 'reduceOnlyCanceled' }])
    }
  }

  return {
    // ── the adapter the runner uses ──
    async meta() { return { szDecimals, maxLeverage } },
    async mid() { return px },
    async bbo() { return bbo() },
    async openOrders() { return [...orders.values()].map(o => ({ ...o })) },
    async fillsSince(t) { return fills.filter(f => f.time >= t).map(f => ({ ...f })) },
    async position() { return { szi: pos, entryPx: entry } },
    async accountValue() { return cash + realized - feesPaid - fundingPaid + pos * (px - entry) },
    async funding() { return fundingPaid },
    async setLeverage() { return true },
    async place(list) {
      return list.map(o => {
        if (usedCloids.has(o.cloid)) return { error: 'Duplicate cloid' }
        if (!(o.sz * o.px >= MIN_NOTIONAL) && !o.reduceOnly) return { error: `Order must have minimum value of $${MIN_NOTIONAL}.` }
        const b = bbo()
        if (o.tif === 'Alo' && (o.isBuy ? o.px >= b.ask : o.px <= b.bid))
          return { error: `Post only order would have immediately matched, bbo was ${b.bid}@${b.ask}. asset=159` }
        if (o.reduceOnly && (o.isBuy ? pos >= 0 : pos <= 0)) return { error: 'Reduce only order would increase position.' }
        usedCloids.add(o.cloid)
        const rec = { oid: nextOid++, cloid: o.cloid, isBuy: o.isBuy, px: +o.px, sz: +o.sz, reduceOnly: !!o.reduceOnly }
        if (o.tif === 'Ioc') {
          const touch = o.isBuy ? b.ask : b.bid
          if (o.isBuy ? o.px < touch : o.px > touch) return { error: 'Order could not immediately match against any resting orders.' }
          let sz = rec.sz
          if (rec.reduceOnly) sz = Math.min(sz, Math.abs(pos))
          const f = trade(rec, touch, sz, false)
          return { filled: { oid: rec.oid, totalSz: f.sz, avgPx: f.px } }
        }
        orders.set(rec.oid, rec)
        return { resting: { oid: rec.oid } }
      })
    },
    async cancel(cloids) {
      return cloids.map(c => {
        const o = [...orders.values()].find(x => x.cloid === c)
        if (!o) return { error: 'Order was never placed, already canceled, or filled.' }
        orders.delete(o.oid)
        emit('updates', [{ order: { oid: o.oid, cloid: o.cloid }, status: 'canceled' }])
        return 'success'
      })
    },
    onFills(cb) { subs.fills.add(cb); return () => subs.fills.delete(cb) },
    onOrderUpdates(cb) { subs.updates.add(cb); return () => subs.updates.delete(cb) },

    // ── the world, for dry-run / backtest / tests ──
    setMid(p, t = now) { now = t; cross(p); px = p },
    /** Funding for one interval at `rate` (Hyperliquid: a long pays rate × notional when rate > 0). */
    applyFunding(rate) { fundingPaid += pos * px * rate },
    dropSocket() { socketUp = false },
    restoreSocket() { socketUp = true },
    cancelBehindBack(cloid) { const o = [...orders.values()].find(x => x.cloid === cloid); if (o) orders.delete(o.oid) },   // e.g. margin-cancelled with the socket down
    get time() { return now },
    get price() { return px },
    get fills() { return fills },
    get book() { return [...orders.values()] },
    get pos() { return pos },
    get feesPaid() { return feesPaid },
    get fundingPaid() { return fundingPaid },
  }
}
