/**
 * INSOLVENT TERMINAL — where the money actually is
 *
 * The allocation wheel used to draw two things: the margin backing open positions, and free
 * margin. On a real account that is a minority of it. Reported with the numbers attached —
 * a combined equity of about $6,800 against a wheel that totalled $2,737.75 — and the whole
 * $4,100 difference was sitting in the two places the wheel could not see:
 *
 *   ORDERS. Margin reserved by resting orders is gone from `withdrawable` (so it is not
 *           "free") and absent from every position's `marginUsed` (so it is not "used").
 *           It fell straight down the gap between the wheel's only two categories. Measured
 *           on one live wallet: $710.05 of $1,664 — 43% of the account, invisible.
 *
 *   SPOT.   Spot token holdings were never counted at all. `_freeMarginUsd` reads spot USDC
 *           and stops there, so $413.60 of HYPE and KNTQ on that same wallet showed up
 *           nowhere on a screen whose whole job is to say where the money is.
 *
 * Both are computed here rather than in main.js because both are arithmetic with no view in
 * them, and arithmetic that was wrong by 60% deserves a test that does not need a browser.
 *
 * ── Order margin ──
 * There is no endpoint for it, but there are two ways to get it and they agree:
 *
 *   per order:  size x price / leverage, skipping anything reduce-only (closing an existing
 *               position posts no new margin) and any position TP/SL.
 *   per account: accountValue − totalMarginUsed − withdrawable, since `totalMarginUsed` is
 *               positions only and orders are the only other thing holding margin back.
 *
 * On the wallet above both give 710.05, to the cent, across 18 resting orders on two coins.
 * The per-order sum is what this module returns, because it is the one that can say WHICH
 * coin — a wheel that knows $710 is reserved but not against what is only half an answer.
 * The account residual is the check, and main.js reconciles against it.
 */

/** Ignore a slice worth less than this; a dust balance is noise on a wheel. */
export const SLICE_DUST = 0.01

/** A reduce-only or position-TP/SL order closes something that already exists, so it posts
 *  no margin of its own. Counting it would inflate the reserved figure by the whole size of
 *  every stop on the book. */
export function reservesMargin(o) {
  return !!o && !o.reduceOnly && !o.isPositionTpsl
}

/**
 * What one resting order holds back.
 *
 * `lev` is that coin's leverage on that account. `cash` says the order is on a market with no
 * leverage at all — spot, or an outcome share — where a BUY holds the whole notional in USDC
 * and a SELL holds the token, which is already counted as a holding. Dividing a spot buy by a
 * leverage it does not have would report a tenth of the money it is actually sitting on.
 */
export function orderMarginOf(o, lev, cash = false) {
  if (!reservesMargin(o)) return 0
  const sz = Math.abs(parseFloat(o.sz ?? 0))
  const px = parseFloat(o.limitPx ?? 0) || parseFloat(o.triggerPx ?? 0)
  if (!(sz > 0) || !(px > 0)) return 0
  if (cash) return String(o.side).toUpperCase() === 'B' ? sz * px : 0
  const L = parseFloat(lev) > 0 ? parseFloat(lev) : 1
  return (sz * px) / L
}

/**
 * Reserved margin per coin, with enough about the orders to describe the row.
 *
 * `levOf(coin, acctAddr)` is asked per order rather than per coin: in the combined view the
 * same coin can be open at 5x on one wallet and 20x on another, and using one of them for
 * both would misattribute the reserve between them.
 */
export function orderMarginByCoin(orders, levOf, isCashMarket) {
  const by = new Map()
  for (const o of orders ?? []) {
    const cash = !!isCashMarket?.(o.coin)
    const m = orderMarginOf(o, levOf?.(o.coin, o._acctAddr), cash)
    if (!(m > 0)) continue
    const cur = by.get(o.coin) ?? { coin: o.coin, cash, margin: 0, count: 0, buys: 0, sells: 0, notional: 0, accts: new Set() }
    cur.margin   += m
    cur.notional += Math.abs(parseFloat(o.sz ?? 0)) * (parseFloat(o.limitPx ?? 0) || parseFloat(o.triggerPx ?? 0))
    cur.count++
    if (String(o.side).toUpperCase() === 'B') cur.buys++; else cur.sells++
    // Which wallet's book it is resting on, so the combined view can say so on the row.
    if (o._acct) cur.accts.add(o._acct)
    by.set(o.coin, cur)
  }
  return by
}

/** Total reserved across every coin. */
export function orderMarginTotal(byCoin) {
  let t = 0
  for (const v of byCoin?.values?.() ?? []) t += v.margin
  return t
}

/**
 * Spot token holdings, priced.
 *
 * USDC is excluded deliberately — it is cash, and it is already counted as free margin. Any
 * token `midOf` cannot price is returned with `usd: 0` and kept: a holding whose price failed
 * to load is not a holding of nothing, and dropping it silently is the "empty is not unknown"
 * mistake in miniature. The caller decides whether an unpriced row is worth drawing.
 */
export function spotValues(balances, midOf) {
  const out = []
  for (const b of balances ?? []) {
    if (!b || b.coin === 'USDC') continue
    const size = parseFloat(b.total ?? 0)
    if (!(size > 0)) continue
    const px   = parseFloat(midOf?.(b.coin) ?? 0)
    const usd  = px > 0 ? size * px : 0
    const cost = parseFloat(b.entryNtl ?? 0)
    out.push({ coin: b.coin, size, px: px > 0 ? px : null, usd, cost, acct: b._acct ?? null, priced: px > 0 })
  }
  return out
}

/** One row per token, summing the same token held on several accounts. */
export function spotByCoin(balances, midOf) {
  const by = new Map()
  for (const h of spotValues(balances, midOf)) {
    const cur = by.get(h.coin) ?? { coin: h.coin, size: 0, usd: 0, cost: 0, px: null, accts: new Set(), priced: false }
    cur.size += h.size
    cur.usd  += h.usd
    cur.cost += h.cost
    cur.priced = cur.priced || h.priced
    // One price for the token, whichever wallet it came from — they all read the same mid.
    if (cur.px == null && h.px != null) cur.px = h.px
    if (h.acct) cur.accts.add(h.acct)
    by.set(h.coin, cur)
  }
  return by
}
