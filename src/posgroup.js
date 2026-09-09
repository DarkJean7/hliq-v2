/**
 * INSOLVENT TERMINAL — one position, held on several accounts
 *
 * In the combined view four wallets can be long the same coin. Shown as four rows that is
 * four separate-looking bets; shown as one row it is what it actually is — a single
 * position, split across accounts for margin reasons.
 *
 * Mobile has collapsed them since the combined view shipped. Desktop never did, and the two
 * drifted because the arithmetic lived inside the mobile card builder. This module is that
 * arithmetic, extracted, so both shells add up the same numbers and a change to one is a
 * change to both.
 *
 * What merges and what does not:
 *
 *   ADDITIVE   size, notional, unrealized PnL, margin, funding — these are just sums, and
 *              a sum is exactly what the user wants to know about their total exposure.
 *   WEIGHTED   entry price, by size. The average entry of the combined position.
 *   NOT MERGED liquidation. Liquidation is per-account: one wallet can be liquidated while
 *              the others are fine, so a group reports the WORST health it contains and
 *              names the account that carries it. An averaged liq price would be a number
 *              that describes no account and no risk anyone actually holds.
 *
 * A member is the normalised shape both shells build from a raw HL position:
 *   { coin, side, absSz, entryPx, posVal, uPnl, margin, funding, markPx,
 *     healthPct, lev, isIso, acct, acctAddr }
 */

/** Stable key for "the same position". Coin AND direction: a long and a short on the same
 *  coin across two wallets are a hedge, not one position, and summing them would report a
 *  flat book while both legs can still be liquidated. */
export function posGroupKey(coin, side) {
  return String(coin) + '|' + String(side)
}

export function posSideOf(szi) {
  return parseFloat(szi ?? 0) > 0 ? 'LONG' : 'SHORT'
}

/** Health of one position: distance from mark to its liquidation price, relative to entry
 *  (100% at entry, 0% at liq). Both shells had their own copy of this; they now share one. */
export function posHealthPct(szi, entryPx, liqPx, markPx) {
  const sz    = parseFloat(szi ?? 0)
  const entry = parseFloat(entryPx ?? 0)
  const liq   = parseFloat(liqPx ?? 0)
  const mark  = parseFloat(markPx ?? 0)
  if (liq > 0 && entry > 0 && mark > 0) {
    if (sz > 0 && entry > liq) return Math.max(0, Math.min(100, (mark - liq) / (entry - liq) * 100))
    if (sz < 0 && liq > entry) return Math.max(0, Math.min(100, (liq - mark) / (liq - entry) * 100))
  }
  // No liquidation price is not "perfectly safe" — it is a position that cannot be
  // liquidated by price (fully margined, or HL reported nothing). 100 is the honest answer
  // for the first and the only available one for the second.
  return 100
}

export function healthColor(pct) {
  return pct > 70 ? '#00e5a0' : pct > 40 ? '#f59e0b' : pct > 20 ? '#ff9444' : '#ff4d6d'
}

/**
 * Fold a group of members into the one position they add up to.
 *
 * Returns the totals plus `worst` (the member nearest liquidation) and `mixed` (the merged
 * accounts do not share one leverage / margin mode, so their risk settings genuinely differ
 * and the summary must not be read as uniform).
 */
export function aggregatePosGroup(members) {
  const ms    = members ?? []
  const first = ms[0] ?? {}
  const num   = (v) => { const n = parseFloat(v ?? 0); return Number.isFinite(n) ? n : 0 }
  const sum   = (f) => ms.reduce((s, m) => s + num(m[f]), 0)

  const totSz   = sum('absSz')
  const totVal  = sum('posVal')
  const totUPnl = sum('uPnl')
  const totMrg  = sum('margin')
  const totFund = sum('funding')
  const avgEntry = totSz > 0
    ? ms.reduce((s, m) => s + num(m.entryPx) * num(m.absSz), 0) / totSz
    : num(first.entryPx)

  let worst = first
  for (const m of ms) if (num(m.healthPct) < num(worst.healthPct)) worst = m

  // Mark is a property of the market, not the account, so any member that has one answers
  // for the group — but a member missing it (a HIP-3 coin absent from allMids) must not
  // make the group report "—" when a sibling knows the price.
  const markPx = num(ms.find(m => num(m.markPx) > 0)?.markPx)

  return {
    coin: first.coin, side: first.side,
    n: ms.length, members: ms,
    totSz, totVal, totUPnl, totMrg, totFund, avgEntry, markPx,
    roe: totMrg > 0 ? totUPnl / totMrg * 100 : 0,
    // Effective leverage of the combined position — notional over the margin actually
    // backing it, which is not the leverage SETTING on any one account.
    realLev: totMrg > 0 ? totVal / totMrg : 0,
    worst, healthPct: num(worst.healthPct),
    mixed: !(ms.every(m => m.lev === first.lev) && ms.every(m => !!m.isIso === !!first.isIso)),
  }
}

/**
 * Group members by coin + direction, preserving the order they arrived in.
 *
 * Order matters: the caller has already sorted, and re-sorting here would silently override
 * the column the user clicked. The first member of each group decides where the group sits.
 */
export function groupPositions(members) {
  const byKey = new Map()
  for (const m of members ?? []) {
    const k = posGroupKey(m.coin, m.side)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(m)
  }
  return [...byKey.values()]
}
