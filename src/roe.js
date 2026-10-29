/**
 * INSOLVENT TERMINAL — return on equity, defined once
 *
 * ROE answers "what did this money earn?", which is the question a dollar figure cannot: +$500
 * is a great month on $2,000 and a bad one on $200,000. The leaderboard was ranked by dollars
 * alone, so it read as a list of who is richest rather than who trades well.
 *
 * There are two ROEs in this app and they are not interchangeable:
 *
 *   POSITION ROE — unrealized PnL against the margin actually committed to that position.
 *     Hyperliquid computes it and sends it as `returnOnEquity`, so it already carries the
 *     leverage: a 3× long up 5% on the mark shows +15%. Prefer HL's own number; the fallback
 *     is only for a row that arrived without one.
 *
 *   ACCOUNT ROE — net PnL against what the account started with, which is its value today less
 *     everything it has made or lost: `accountValue - netPnl`. Once profits are withdrawn that
 *     goes negative (Spartan: +$922 on $518 now), so a row that carries `deposited` — every
 *     dollar that came in, src/depositbasis.js — falls back to that instead of having no ROE.
 *
 * Both return NULL when there is no usable basis rather than 0 or Infinity. A fresh account
 * whose starting equity rounds to nothing has an UNKNOWN return, not a zero one, and printing
 * "+0.0%" or "+∞%" beside a real trader's number is worse than printing nothing. Callers show
 * a dash. This is the same distinction that has already cost this codebase three bugs.
 */

/** Below this the basis is noise and the percentage is meaningless. */
export const MIN_BASIS = 1

/**
 * What an account has returned on the money it started with, as a percentage. Null when that
 * cannot be known.
 */
export function accountRoe(entry) {
  const basis = roeBasis(entry)
  return basis == null ? null : (Number(entry.netPnl) / basis) * 100
}

/** What account ROE divides by, or null: the start value, else what was deposited. */
export function roeBasis(entry) {
  if (!entry || entry.error) return null
  const value = Number(entry.accountValue)
  const net   = Number(entry.netPnl)
  if (!Number.isFinite(value) || !Number.isFinite(net)) return null
  const start = value - net
  if (start > MIN_BASIS) return start
  const dep = Number(entry.deposited)
  return Number.isFinite(dep) && dep > MIN_BASIS ? dep : null
}

/** The same ratio for any one part of the PnL — realized alone, unrealized alone. */
export function partRoe(part, entry) {
  if (!entry || entry.error) return null
  const p = Number(part)
  if (!Number.isFinite(p)) return null
  const basis = roeBasis(entry)
  return basis == null ? null : (p / basis) * 100
}

/**
 * A position's return on the margin committed to it.
 *
 * `returnOnEquity` comes from Hyperliquid as a RATIO (0.15 for +15%), already accounting for
 * leverage. Deriving it from marginUsed is the fallback for a position that arrived without
 * one — same answer, but HL's is authoritative.
 */
export function positionRoe(pos) {
  const p = pos?.position ?? pos
  if (!p) return null
  const roe = Number(p.returnOnEquity)
  if (Number.isFinite(roe) && p.returnOnEquity !== '' && p.returnOnEquity != null) return roe * 100
  const pnl    = Number(p.unrealizedPnl)
  const margin = Number(p.marginUsed)
  if (!Number.isFinite(pnl) || !Number.isFinite(margin) || !(Math.abs(margin) > 0)) return null
  return (pnl / margin) * 100
}

/** "+12.3%" / "−4.0%", or a dash when the return is not knowable. */
export function fmtRoe(pct, { dash = '—', decimals = 1 } = {}) {
  if (pct == null || !Number.isFinite(pct)) return dash
  return (pct >= 0 ? '+' : '') + pct.toFixed(decimals) + '%'
}

/** Sort comparator by ROE. Rows without one sort last whichever way the list is pointing, so a
 *  flip never parades unknowns at the top. */
export function compareRoe(a, b, dir = -1) {
  const ra = accountRoe(a), rb = accountRoe(b)
  if (ra == null && rb == null) return 0
  if (ra == null) return 1
  if (rb == null) return -1
  return (ra - rb) * (dir < 0 ? -1 : 1)
}
