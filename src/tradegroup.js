/**
 * INSOLVENT TERMINAL — one order is one trade
 *
 * Hyperliquid reports FILLS, and a single order is filled in as many pieces as the book takes
 * to satisfy it. One short on USELESS, closed once, came back as six fills — and the app
 * counted six: "14 trades" on the Scoreboard header, "6 CLOSED · 0/6 WON" under it, for what
 * the trader did twice.
 *
 * The app's older answer was to bucket closes by coin and hour, which merges those six and
 * also merges two genuinely separate trades that happen in the same hour. The exchange already
 * says which fills belong together: they share an ORDER ID. So a trade is an order, and the
 * bucket is gone.
 *
 * `hash` is deliberately not used — HL returns 0x0…0 for many fills, which would collapse
 * unrelated orders into one phantom trade.
 */

/** The order a fill belongs to. Per account, since oids repeat across wallets. */
export function tradeKey(f) {
  if (!f) return ''
  const acct = String(f._acctAddr ?? f._acct ?? '').toLowerCase()
  if (f.oid != null && f.oid !== '') return `${acct}|o${f.oid}`
  if (f.tid != null && f.tid !== '') return `${acct}|t${f.tid}`
  // Paper fills and very old history carry neither; each of those is already one trade.
  return `${acct}|${f.coin}|${f.time}|${f.px}|${f.dir ?? ''}`
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/**
 * Fills → trades, newest last. Each carries what the whole order did: its size, its
 * volume-weighted price, what it closed and what it cost, and `fills` — how many pieces the
 * exchange filled it in, which is the number that used to be mistaken for a trade count.
 */
export function groupTrades(fills) {
  const by = new Map()
  for (const f of fills ?? []) {
    const k = tradeKey(f)
    let g = by.get(k)
    if (!g) {
      g = { key: k, coin: f.coin, dir: f.dir ?? '', rawSide: f.rawSide ?? f.side ?? null,
            time: num(f.time), timeFirst: num(f.time), sz: 0, notional: 0, closedPnl: 0, fee: 0,
            fills: 0, oid: f.oid ?? null, acct: f._acct ?? null, acctAddr: f._acctAddr ?? null, px: 0, _lastPx: 0 }
      by.set(k, g)
    }
    const sz = Math.abs(num(f.sz))
    const px = num(f.px)
    g.sz        += sz
    g.notional  += Number.isFinite(num(f.notional)) && num(f.notional) !== 0 ? num(f.notional) : sz * px
    g.closedPnl += num(f.closedPnl)
    g.fee       += num(f.fee)
    g.fills     += 1
    g.time      = Math.max(g.time, num(f.time))
    g.timeFirst = Math.min(g.timeFirst, num(f.time))
    if (px) g._lastPx = px
    // The last piece's direction wins; every piece of one order says the same thing anyway.
    if (f.dir) g.dir = f.dir
  }
  // Volume-weighted across the pieces — or the fill's own price when no size came with it
  // (paper history and some old records carry a price and nothing else).
  for (const g of by.values()) { g.px = g.sz > 0 ? g.notional / g.sz : g._lastPx; delete g._lastPx }
  return [...by.values()].sort((a, b) => a.time - b.time)
}

/** How many trades these fills are. */
export const countTrades = (fills) => groupTrades(fills).length

/** The trades that CLOSED something — the ones a win rate is measured over. */
export const closedTrades = (fills) => groupTrades(fills).filter(g => g.closedPnl !== 0)

/**
 * Trade key → net result after fees, for the win rate and the track record.
 *
 * This replaces the coin+hour buckets those figures used to be built from: same shape (a map
 * of key → net), so every caller keeps working, and one order can no longer be several trades
 * nor two trades one.
 */
export function tradeWindows(fills) {
  const out = {}
  for (const g of closedTrades(fills)) out[g.key] = g.closedPnl - g.fee
  return out
}
