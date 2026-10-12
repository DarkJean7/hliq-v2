// The allocation rules that need more than "today's weights": shared by the backtest
// (src/pfbacktest.js simulate) and the live bot (src/pflive.js decide), so a run trades what
// its backtest showed. Pure; prices in, weights out.
//
// Weights are signed (a short is negative) with Σ|w| = 1. Every function returns weights in
// that same form, or a scale factor, and never invents a price: a market with too little
// history is treated as described at each function, never as zero.

/** DCA trigger: 0 = every N days (the default), 1 = after the basket drops X%, 2 = either. */
export const DCA_TIME = 0, DCA_DROP = 1, DCA_BOTH = 2

/**
 * How the basket has moved since `ref` (prices at the last buy), weighted: Σ w × (px/ref − 1).
 * A short's weight is negative, so a falling price counts as the basket gaining. Markets with no
 * reference or no price are left out and the rest re-weighted; nothing comparable → null.
 */
export function basketChange(weights, ref, px) {
  let s = 0, wsum = 0
  for (const [k, w] of Object.entries(weights)) {
    const r = ref?.[k], p = px?.[k]
    if (!(r > 0) || !(p > 0)) continue
    s += w * (p / r - 1); wsum += Math.abs(w)
  }
  return wsum > 0 ? s / wsum : null
}

/** Annualised volatility of daily closes (oldest first), from the last `n` daily returns. Null with fewer than 5. */
export function annualVol(closes, n) {
  const xs = (closes ?? []).filter(x => x > 0).slice(-(n + 1))
  const r = []
  for (let i = 1; i < xs.length; i++) r.push(Math.log(xs[i] / xs[i - 1]))
  if (r.length < 5) return null
  const m = r.reduce((a, x) => a + x, 0) / r.length
  const v = r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)
  return Math.sqrt(v * 365)
}

/** Return over the last `n` days of closes (oldest first). Null with too little history. */
export function trailingReturn(closes, n) {
  const xs = (closes ?? []).filter(x => x > 0)
  if (xs.length < Math.min(n, 5) + 1) return null
  const a = xs[Math.max(0, xs.length - 1 - n)], b = xs[xs.length - 1]
  return b / a - 1
}

const norm = (o) => {
  const sum = Object.values(o).reduce((a, w) => a + Math.abs(w), 0)
  return sum > 0 ? Object.fromEntries(Object.entries(o).map(([k, w]) => [k, w / sum])) : {}
}

/**
 * Risk parity (inverse volatility): each holding sized by its weight ÷ its volatility, so a coin
 * that swings twice as hard gets half the share and each one moves the basket about as much.
 * A market without enough history keeps the average volatility of the others.
 */
export function invVolWeights(weights, vols) {
  const known = Object.keys(weights).map(k => vols[k]).filter(v => v > 0)
  const avg = known.length ? known.reduce((a, v) => a + v, 0) / known.length : 1
  return norm(Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, w / (vols[k] > 0 ? vols[k] : avg)])))
}

/**
 * Momentum rotation: the `top` holdings that did best over the window, at their own weights
 * scaled up to fill the book; any that went the wrong way (a long that fell, a short that rose)
 * is never held — with none left the whole book sits in cash ({}). No history: not picked.
 */
export function momentumWeights(weights, rets, top) {
  const ranked = Object.entries(weights)
    .map(([k, w]) => [k, w, rets[k] == null ? null : rets[k] * Math.sign(w)])
    .filter(([, , r]) => r != null && r > 0)
    .sort((a, b) => b[2] - a[2])
    .slice(0, Math.max(1, Math.round(top)))
  return norm(Object.fromEntries(ranked.map(([k, w]) => [k, w])))
}

/**
 * Volatility target: the share of the book to hold so the basket swings about `target` a year —
 * all of it when it is calmer than that, less when it is wilder. Never above 1: it can only
 * step back, never add leverage on top of what was chosen. Unknown volatility: all of it.
 */
export function volScale(basketVol, target) {
  if (!(basketVol > 0) || !(target > 0)) return 1
  return Math.min(1, target / basketVol)
}

/** The basket's own volatility: its daily return is Σ w × each holding's return. */
export function basketVol(weights, closesBy, n) {
  const keys = Object.keys(weights).filter(k => (closesBy[k] ?? []).length > 1)
  if (!keys.length) return null
  const len = Math.min(...keys.map(k => closesBy[k].length))
  const series = [100]
  for (let i = len - n > 1 ? len - n : 1; i < len; i++) {
    let r = 0
    for (const k of keys) { const c = closesBy[k], a = c[c.length - len + i - 1], b = c[c.length - len + i]; if (a > 0 && b > 0) r += weights[k] * (b / a - 1) }
    series.push(series[series.length - 1] * (1 + r))
  }
  return annualVol(series, n)
}
