/**
 * Funding and slippage for /portfolios — the two costs a backtest used to charge as $0.
 *
 * FUNDING is real where we have it. Hyperliquid publishes every perp's hourly rate
 * (fundingHistory, 500 hours a request); the server collects them for the featured markets a
 * request a minute and keeps them by UTC day. A long pays rate × position value each hour when
 * the rate is positive and receives it when negative; a short the reverse. Where a day's rates
 * are not in yet, the market's own average over the days that are stands in, and the run says
 * how many days were estimated. Before a market listed on Hyperliquid (Mixed's outside history)
 * and for spot tokens there is no funding at all; "TradingView" (exchange prices — owning the
 * asset) charges none either.
 *
 * SLIPPAGE is an estimate, in two parts: half the spread, from Hyperliquid's impact prices (the
 * prices a standard-size order would actually fill at, each side), plus market impact by the
 * square-root law — impact ≈ 0.7 × daily volatility × √(order ÷ daily volume) — so a rebalance
 * that is large next to the market's volume costs more than one that is not.
 *
 * Pure: imported by src/pfbacktest.js, src/portfolio.js and serve-prod.js.
 */
export const DAY = 86_400_000
const dayOf = (t) => Math.floor(t / DAY) * DAY

// One fundingHistory request returns up to 500 hours. Ask for whole UTC days (20 = 480 hours) so
// no day is cut at a request's edge: a partial day would read low, and when two requests are
// merged the later one's partial day would overwrite a complete one.
export const FUND_HOURS = 480
export const FUND_DAYS = 20
export const IMPACT_Y = 0.7                   // square-root impact coefficient
export const SLIP_CAP_BPS = 500               // no single fill is charged more than 5%
export const SLIP_DEFAULT_BPS = 10            // a market with no book data: a modest guess

/** fundingHistory entries → [[day, Σ hourly rate]] by UTC day, sorted. */
export function dailyFunding(entries) {
  const by = new Map()
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = Number(e?.time), r = Number(e?.fundingRate)
    if (!Number.isFinite(t) || !Number.isFinite(r)) continue
    by.set(dayOf(t), (by.get(dayOf(t)) ?? 0) + r)
  }
  return [...by].sort((a, b) => a[0] - b[0])
}

/** Two daily series into one; where both have a day, `b` (the newer fetch) wins. */
export function mergeDaily(a, b) {
  const by = new Map(a ?? [])
  for (const [d, r] of (b ?? [])) by.set(d, r)
  return [...by].sort((x, y) => x[0] - y[0])
}

/**
 * The average daily rate over the days known, or null with none. Today's partial day is left
 * out — it has fewer than 24 hours in it and would pull the average toward zero.
 */
export function fundingAvg(daily, now = Date.now()) {
  const full = (daily ?? []).filter(([d]) => d < dayOf(now))
  if (!full.length) return null
  return full.reduce((a, [, r]) => a + r, 0) / full.length
}

/**
 * One market's funding as the engine reads it: `{ days: Map(day → rate), avg, from }`, where
 * `from` is the first day it traded on Hyperliquid (no funding before that).
 */
export function fundingInfo(daily, from, now = Date.now()) {
  return { days: new Map(daily ?? []), avg: fundingAvg(daily, now), from: from ?? null }
}

/** The rate for one day: actual, else the average (estimated), else nothing. → [rate, estimated] */
export function rateOn(info, day) {
  if (!info || info.from == null || day < info.from) return [0, false]
  const r = info.days.get(day)
  if (r != null) return [r, false]
  return info.avg != null ? [info.avg, true] : [0, false]
}

/** Half the spread, in bps, from Hyperliquid's impact prices [bid, ask] and its mid. */
export function halfSpreadBps(impactPxs, mid) {
  const b = Number(impactPxs?.[0]), a = Number(impactPxs?.[1]), m = Number(mid) || (a + b) / 2
  if (!(a > 0 && b > 0 && m > 0) || a < b) return null
  return ((a - b) / m / 2) * 1e4
}

/** Daily volatility (stdev of daily returns) over the last `n` closes before index i. */
export function dailyVol(closes, i, n = 30) {
  const r = []
  for (let k = Math.max(1, i - n + 1); k <= i; k++) {
    const a = closes[k - 1], b = closes[k]
    if (a > 0 && b > 0) r.push(b / a - 1)
  }
  if (r.length < 5) return null
  const m = r.reduce((x, y) => x + y, 0) / r.length
  return Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (r.length - 1))
}

/**
 * The slippage on one fill, in dollars. `book` is { spreadBps (half-spread), vol (24h volume) };
 * `sigma` the market's daily volatility. Unknown parts fall back to the default, never to zero.
 */
export function slippage(notional, book, sigma) {
  const q = Math.abs(notional)
  if (!(q > 0)) return 0
  const hs = Number.isFinite(book?.spreadBps) ? book.spreadBps : SLIP_DEFAULT_BPS / 2
  const impact = book?.vol > 0 && sigma > 0 ? IMPACT_Y * sigma * Math.sqrt(q / book.vol) * 1e4 : SLIP_DEFAULT_BPS / 2
  return q * Math.min(SLIP_CAP_BPS, hs + impact) / 1e4
}
