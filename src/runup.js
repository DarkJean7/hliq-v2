/**
 * INSOLVENT TERMINAL — max upside: the mirror of max drawdown.
 *
 * "in the whole app we have some instances where it displays the max drawdown, lets also include
 * max upside". Drawdown is the largest fall from a high to a later low; upside is the largest
 * rise from a low to a later high. Same walk, opposite direction: the low so far, and how far
 * the curve climbed above it. A curve that only fell has an upside of 0, not "unknown".
 *
 * Two shapes, because the app keeps two kinds of curve:
 *   maxRunupPct  — an EQUITY curve (balance over time): the rise as a percent of the low it
 *                  started from. Equity at the low is the money that made the move.
 *   maxRunupUsd  — a PnL curve (dollars made so far): the rise in dollars, and when. A PnL
 *                  curve can sit at or below zero, so it has no percent of its own.
 * Both take [[t, v]], [{ x, y }] or bare-number points, skip anything not finite, and need two.
 */

// [t, v], { x, y }, or a bare value (a portfolio's equity is a plain list of numbers).
const pt = (p) => typeof p === 'number' ? [NaN, p] : Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.y)]

/** Largest low-to-later-high rise of an equity curve, in percent of that low. Null under two points. */
export function maxRunupPct(curve) {
  const pts = (curve ?? []).map(pt).filter(([, v]) => Number.isFinite(v))
  if (pts.length < 2) return null
  let low = Infinity, up = 0
  for (const [, v] of pts) {
    if (v < low) low = v
    if (low > 0) up = Math.max(up, (v - low) / low * 100)
  }
  return up
}

/** Largest low-to-later-high rise of a PnL curve, in dollars, with when it started and ended. */
export function maxRunupUsd(curve) {
  const pts = (curve ?? []).map(pt).filter(([, v]) => Number.isFinite(v))
  if (pts.length < 2) return null
  let low = pts[0][1], lowAt = pts[0][0], rise = 0, from = null, to = null
  for (const [t, v] of pts) {
    if (v < low) { low = v; lowAt = t }
    if (v - low > rise) { rise = v - low; from = lowAt; to = t }
  }
  return { rise, from, to, low }
}
