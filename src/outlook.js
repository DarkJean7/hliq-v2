/**
 * Outlook: what could happen to each open position, and what the signals lean towards.
 *
 * Asked: "an active tab that tracks the user's positions and tries to predict the future
 * movement of that asset... 3 cases chart with neutral, bullish, bearish. include
 * strength/rating", and "include in the bias and strength signals the range category... 4h
 * candles and a good amount of candles".
 *
 * It does NOT predict. Two different things are on the card and they are kept apart:
 *
 *   1. The CONE — how far this asset normally moves in the chosen time, from its own 4h
 *      returns. That is a measurement, not an opinion. The three scenarios are read off it
 *      (or off the nearest support/resistance inside it), and each says what it would do to
 *      THIS position: P&L, how close to liquidation, the chance of touching that price. The
 *      chances assume no drift — the cone is symmetric on purpose, so the score below cannot
 *      leak into numbers that look like measurements.
 *   2. The SCORE, -100 bearish to +100 bullish — a weighted read of six factors, each shown
 *      with the number it came from, so it says WHY. It is a lean, and the view says so.
 *
 * Pure: candles, levels and a position in, plain objects out. No state, no fetching, no DOM.
 * Missing data is null and is left out of the score, never counted as neutral.
 */
import { normalise, classify } from './backtest.js'
import { sma, rsi } from './zones.js'
import { readCandidates } from './outlooksignals.js'

// ── maths ───────────────────────────────────────────────────────────────────

/** Standard normal CDF (Abramowitz–Stegun 7.1.26; |error| < 1.5e-7). */
export function normCdf(x) {
  const s = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return 0.5 * (1 + s * y)
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * Volatility of one 4h candle: the standard deviation of its log returns over the last `n`.
 * Null under 30 returns — too few to say how the asset moves.
 */
export function vol4h(c4, n = 180) {
  const c = (c4 ?? []).slice(-(n + 1)).map(k => +k.c).filter(v => v > 0)
  if (c.length < 31) return null
  const r = []
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]))
  const m = r.reduce((s, x) => s + x, 0) / r.length
  const v = r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)
  return Math.sqrt(v)
}

/** One standard deviation of log price over `hours`, from the 4h figure (square-root of time). */
export const sigmaFor = (v4, hours) => v4 == null ? null : v4 * Math.sqrt(hours / 4)

/** Inverse standard normal CDF (Acklam; relative error < 1.2e-9). */
export function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  if (p > 1 - lo) return -normInv(1 - p)
  const q = p - 0.5, r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * The cone, calibrated ("do 2"): the multiplier on σ that would have put the measured share of
 * days inside ±1σ at the normal 68.3%. If a market ended inside 73% of the time its moves ran
 * smaller than its volatility said, and the cone narrows (×0.91); 60% widens it. Pulled towards
 * ×1 on few days — a week sampled daily counts days ÷ 7 — and kept within ×0.6 to ×1.6. One number
 * from a year of the market's own days: the touch chances the card prints for a liquidation, a
 * stop or a take-profit move with it.
 */
export function coneScale(cone, hours = 24) {
  if (!cone?.n) return 1
  const p = clamp(cone.inside, 0.3, 0.97)
  const k = 1 / normInv((1 + p) / 2)
  const nEff = cone.n / Math.max(1, hours / 24)
  return clamp(1 + (k - 1) * nEff / (nEff + 100), 0.6, 1.6)
}

/**
 * The chance the price TOUCHES `level` at some point within the horizon (not just ends there),
 * for a driftless random walk in log price: 2 × (1 − Φ(distance / σ)). The reflection principle.
 * Touching is what matters for a liquidation, a stop or a take-profit.
 */
export function touchProb(price, level, sigma) {
  if (!(price > 0) || !(level > 0) || !(sigma > 0)) return null
  return clamp(2 * (1 - normCdf(Math.abs(Math.log(level / price)) / sigma)), 0, 1)
}

/**
 * Which of two prices is touched FIRST, whenever that is: for a driftless walk in log price the
 * chance of reaching `up` before `down` is ln(p/down) / ln(up/down). It has no horizon — it is
 * "TP or SL, whichever comes first" — so the view says that instead of putting a time on it.
 */
export function firstTouchUp(price, up, down) {
  if (!(down > 0) || !(up > price) || !(price > down)) return null
  return Math.log(price / down) / Math.log(up / down)
}

function ema(vals, n) {
  const k = 2 / (n + 1)
  const out = []
  let e = null
  for (const v of vals) { e = e == null ? v : v * k + e * (1 - k); out.push(e) }
  return out
}
/** MACD (12, 26, 9) on closes: the histogram now and one bar back. Null without 60 bars. */
export function macdHist(closes) {
  if (!closes || closes.length < 60) return null
  const f = ema(closes, 12), s = ema(closes, 26)
  const line = f.map((v, i) => v - s[i])
  const sig = ema(line, 9)
  const h = line.map((v, i) => v - sig[i])
  return { now: h.at(-1), prev: h.at(-2) }
}

// ── the Range category, on 4h ─────────────────────────────────────────────────

/** "a good amount of candles": 500 4h candles is ~83 days; normal is the 200 before each one. */
export const RANGE_CANDLES = 500
export const RANGE_LOOKBACK = 200
export const RANGE_RECENT = 6          // the last 24 hours of 4h candles
const RANGE_DECAY = 0.8                // a candle 4h older counts 80% as much

/**
 * The simulator's Range categories (backtest.js classify: a candle's size against the average
 * of the 200 before it, 1-9, 5 = normal), read as a lean: unusually large 4h candles in the
 * last day — category 7 and up, twice normal or more — count in their own direction, as the
 * Range strategy's "follow" mode trades them. Bigger and more recent counts more. Also says
 * whether candles lately are larger than normal (expanding) or smaller (quiet).
 *
 * Null when there is not enough 4h history to have a normal.
 */
export function rangeRead(c4) {
  const rows = normalise((c4 ?? []).slice(-RANGE_CANDLES))
  if (rows.length < RANGE_LOOKBACK + RANGE_RECENT) return null
  const cls = classify(rows, { baselineLookback: RANGE_LOOKBACK, baselineKind: 'mean' })
  const recent = cls.slice(-RANGE_RECENT)
  if (recent.some(c => c == null)) return null
  let sum = 0, big = 0, up = 0, down = 0
  recent.forEach((c, i) => {
    const cat = Math.abs(c), age = RANGE_RECENT - 1 - i
    if (cat >= 7) {
      big++
      if (c > 0) up++; else down++
      sum += Math.sign(c) * (cat - 6) * RANGE_DECAY ** age
    }
  })
  const avgCat = recent.reduce((s, c) => s + Math.abs(c), 0) / recent.length
  return {
    v: clamp(sum / 3, -1, 1),
    last: recent.at(-1),                         // signed category of the latest 4h candle
    big, up, down, avgCat,
    regime: avgCat >= 6 ? 'expanding' : avgCat <= 4 ? 'quiet' : 'normal',
    candles: rows.length,
  }
}

// ── the score ─────────────────────────────────────────────────────────────

export const WEIGHTS = { trend: 25, momentum: 20, range: 20, levels: 15, book: 10, funding: 10 }
/**
 * At 4h the score is a different set ("do 1": tests/signal-research.mjs, results in
 * tests/research/signal-results.json). Across 19 markets and a year of 4h candles, two signals
 * that FADE a stretched price called the next 4 hours better than chance — pooled, by the money,
 * and in both halves of the year: the 3-day move (54.3% of 3,576 calls vs 49.6%) and the
 * Bollinger stretch (55.7% of 4,548 vs 49.6%). Momentum called it WRONG — 42.7% of 4,338 vs 50.1%,
 * in both halves — so at 4h it is out and they are in. At 24h, 3d and 7d nothing new passed, and
 * those keep the set they had.
 */
export const WEIGHTS_4H = { trend: 25, range: 20, rev3d: 15, bbFade: 15, levels: 15, book: 10, funding: 10 }
export const weightsFor = (hours) => hours <= 4 ? WEIGHTS_4H : WEIGHTS
/** The signals that can be replayed from candles, per horizon: the past record is of these. */
export const candleIds = (hours) => hours <= 4 ? ['trend', 'range', 'rev3d', 'bbFade'] : ['trend', 'momentum', 'range']
// Hyperliquid's resting funding: 0.01% per 8h, so 0.00125% an hour. Above it longs pay more
// than the default — crowded long; below, crowded short.
const BASE_FUNDING = 0.00125

/**
 * The six factors. Each is { id, v: -1..1, w, x } where `x` is what it was read from, or null
 * and left out when its data is missing. `fundingPctHr` is percent per hour (as _mktCtxMap holds
 * it); `ratio` is bid ÷ ask depth near the price.
 */
export function factors({ price, c4, c1, setup, fundingPctHr = null, ratio = null, hours = 24 }) {
  const W = weightsFor(hours)
  const out = []
  // Trend — daily: price against its 50-day average, and the 50 against the 200.
  const s50 = sma(c1, 50), s200 = sma(c1, 200)
  if (s50 != null) {
    const a = price > s50 ? 1 : -1
    const b = s200 != null ? (s50 > s200 ? 1 : -1) : null
    out.push({ id: 'trend', w: W.trend, v: b == null ? a : (a + b) / 2, x: { s50, s200, above: a > 0, golden: b == null ? null : b > 0 } })
  }
  // Momentum — 4h: RSI (stretched readings lean back the other way) and the MACD histogram.
  // Not at 4h: it called the next four hours wrong (see WEIGHTS_4H).
  const r = W.momentum ? rsi(c4) : null
  const m = W.momentum ? macdHist((c4 ?? []).map(k => +k.c)) : null
  if (W.momentum && (r != null || m)) {
    const vr = r == null ? null : r >= 75 ? -0.5 : r <= 25 ? 0.5 : clamp((r - 50) / 20, -1, 1)
    const vm = m == null ? null : (m.now > 0 ? 0.5 : -0.5) + (m.now > m.prev ? 0.5 : -0.5)
    const vs = [vr, vm].filter(v => v != null)
    out.push({ id: 'momentum', w: W.momentum, v: vs.reduce((s, v) => s + v, 0) / vs.length, x: { rsi: r, macd: m } })
  }
  // Range category — 4h, see rangeRead.
  const rr = rangeRead(c4)
  if (rr) out.push({ id: 'range', w: W.range, v: rr.v, x: rr })
  // At 4h: the two fading signals that earned a place (src/outlooksignals.js).
  if (W.rev3d || W.bbFade) {
    const i = (c4?.length ?? 0) - 1
    const c = readCandidates(c4, i, vol4h(c4), null, ['rev3d', 'bbFade'])
    if (W.rev3d && c.rev3d != null) out.push({ id: 'rev3d', w: W.rev3d, v: c.rev3d, x: { move: i >= 18 ? +c4[i].c / +c4[i - 18].c - 1 : null } })
    if (W.bbFade && c.bbFade != null) {
      const cl = c4.slice(-20).map(k => +k.c), mean = cl.reduce((a, b) => a + b, 0) / cl.length
      const sd = Math.sqrt(cl.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, cl.length - 1))
      out.push({ id: 'bbFade', w: W.bbFade, v: c.bbFade, x: { sd: sd > 0 ? (cl.at(-1) - mean) / sd : 0 } })
    }
  }
  // Levels — where price sits against the support/resistance the Analysis tab finds.
  if (setup?.state) {
    const v = { breakout: 1, breakdown: -1, support: 0.5, resistance: -0.5 }[setup.state] ?? 0
    out.push({ id: 'levels', w: W.levels, v, x: { state: setup.state } })
  }
  // Book — more bids than asks near the price leans up.
  if (ratio > 0) out.push({ id: 'book', w: W.book, v: clamp(Math.log2(ratio) / Math.log2(1.5), -1, 1), x: { ratio } })
  // Funding — contrarian: a crowded side is the one that gets squeezed.
  if (Number.isFinite(fundingPctHr)) out.push({ id: 'funding', w: W.funding, v: -clamp((fundingPctHr - BASE_FUNDING) / 0.01, -1, 1), x: { pctHr: fundingPctHr } })
  return out
}

/** -100..100 over the factors that have data, with how much of the full weight that is. */
export function scoreOf(fs, hours = 24) {
  const W = weightsFor(hours)
  const w = fs.reduce((s, f) => s + f.w, 0)
  if (!w) return null
  const total = Object.values(W).reduce((s, x) => s + x, 0)
  const score = Math.round(100 * fs.reduce((s, f) => s + f.w * f.v, 0) / w)
  const a = Math.abs(score)
  const strength = a < 15 ? 'neutral' : a < 40 ? 'weak' : a < 70 ? 'moderate' : 'strong'
  const lean = a < 15 ? 'flat' : score > 0 ? 'up' : 'down'
  const agree = fs.filter(f => Math.sign(f.v) === Math.sign(score) && f.v !== 0).length
  // Coverage is of the BASE weights: learned multipliers change how much a signal counts, not
  // whether its data is there.
  const have = fs.reduce((s, f) => s + (W[f.id] ?? f.w), 0)
  return { score, strength, lean, agree, of: fs.length, coverage: have / total }
}

// ── the position ────────────────────────────────────────────────────────────

/** Hyperliquid's position object → what this file needs. Null for no position. */
export function posOf(p) {
  const szi = parseFloat(p?.szi)
  if (!p?.coin || !Number.isFinite(szi) || szi === 0) return null
  const liq = parseFloat(p.liquidationPx)
  return {
    coin: p.coin, szi, side: szi > 0 ? 'long' : 'short',
    entry: parseFloat(p.entryPx), liq: liq > 0 ? liq : null,
    upnl: parseFloat(p.unrealizedPnl) || 0, margin: parseFloat(p.marginUsed) || null,
    lev: p.leverage?.value ?? null, acct: p._acct ?? null, acctAddr: p._acctAddr ?? null,
  }
}

/**
 * The position's own take-profit and stop, from its trigger orders — the nearest of each on the
 * side it belongs. Same detection as the position card: orderType "Take Profit…"/"Stop…" or a
 * triggerCondition. In the combined view an order counts only for its own account.
 */
export function guardsOf(pos, orders) {
  let tp = null, sl = null
  for (const o of orders ?? []) {
    if (o?.coin !== pos.coin) continue
    if (pos.acctAddr && o._acctAddr && o._acctAddr !== pos.acctAddr) continue
    const ot = String(o.orderType ?? '')
    const px = parseFloat(o.triggerPx)
    if (!(px > 0)) continue
    const isTp = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = ot.startsWith('Stop') || o.triggerCondition === 'sl'
    const better = (cur, wantHigh) => cur == null || (wantHigh ? px < cur : px > cur)
    if (isTp && better(tp, pos.side === 'long')) tp = px
    if (isSl && better(sl, pos.side !== 'long')) sl = px
  }
  return { tp, sl }
}

// "add more smaller and higher timeframes": 1h to 30d. 1h reads the 4h set (the nearest tested one)
// but cannot be replayed — the candles here are 4h, so the shortest outcome there is to check is 4h.
export const HORIZONS = { '1h': 1, '4h': 4, '24h': 24, '3d': 72, '7d': 168, '30d': 720 }
/**
 * Where a signal set has BEATEN CHANCE on real candles (tests/signal-research.mjs; results in
 * tests/research/signal-results.json — 20 markets, a year, re-run with 30d added): only 4h. At
 * 24h, 3d, 7d and 30d nothing passed, and 1h has no replay. The suggestion still reads every
 * horizon, but caps its conviction at Low where the horizon is not in here, and says why.
 */
export const TESTED_HORIZONS = [4]

/**
 * The three cases for one position over `hours`.
 *
 *   bullish  the nearest resistance if it is inside two standard deviations, else +1σ
 *   bearish  the nearest support likewise, else −1σ
 *   neutral  where it is now; its "chance" is of touching neither of the other two
 *
 * Each with the position's unrealized P&L if price were there, the change from now, and the
 * chance of touching it within the horizon. A case past the liquidation price says so: the
 * position would be gone before it got there, and its P&L is the margin, not the line.
 */
export function scenarios({ pos, price, sigma, setup }) {
  if (!(price > 0) || !(sigma > 0)) return null
  const far = (k) => price * Math.exp(k * sigma)
  const res = setup?.resistance?.lo, sup = setup?.support?.hi
  const upPx = res > price && res <= far(2) ? res : far(1)
  const dnPx = sup > 0 && sup < price && sup >= far(-2) ? sup : far(-1)
  const at = (px) => {
    const liquidated = pos?.liq != null && (pos.side === 'long' ? px <= pos.liq : px >= pos.liq)
    const pnl = pos ? (liquidated && pos.margin ? -pos.margin : pos.szi * (px - pos.entry)) : null
    return { px, pct: (px / price - 1) * 100, pnl, change: pos ? pos.szi * (px - price) : null, liquidated }
  }
  const pUp = touchProb(price, upPx, sigma), pDn = touchProb(price, dnPx, sigma)
  return {
    bull: { ...at(upPx), p: pUp, level: upPx === res ? 'resistance' : null },
    neutral: { ...at(price), p: pUp == null || pDn == null ? null : Math.max(0, 1 - pUp - pDn) },
    bear: { ...at(dnPx), p: pDn, level: dnPx === sup ? 'support' : null },
  }
}

/**
 * Everything one card needs. `c4`/`c1` are 4h and daily candles ({t,o,h,l,c}), `setup` the
 * Analysis reading (zones.js readSetup), `ratio` the book ratio, `fundingPctHr` percent per hour.
 */
export function outlookFor({ position, price, c4, c1, setup, ratio = null, fundingPctHr = null, orders = [], hours = 24, mult = null, sigmaScale = 1 }) {
  const pos = posOf(position)
  const v4 = vol4h(c4)
  // sigmaScale: the cone calibrated to the market's own past (coneScale); 1 = as measured.
  const sigma = sigmaFor(v4, hours) == null ? null : sigmaFor(v4, hours) * sigmaScale
  // `mult`: learned multipliers for the candle signals (learnedWeights), {trend: 1.4, ...}.
  const fs = (price > 0 ? factors({ price, c4, c1, setup, fundingPctHr, ratio, hours }) : [])
    .map(f => mult?.[f.id] != null ? { ...f, w: f.w * mult[f.id], m: mult[f.id] } : f)
  const sc = scoreOf(fs, hours)
  const g = pos ? guardsOf(pos, orders) : { tp: null, sl: null }
  const risk = pos && price > 0 && sigma > 0 ? {
    liq: pos.liq != null ? { px: pos.liq, p: touchProb(price, pos.liq, sigma), sig: Math.abs(Math.log(pos.liq / price)) / sigma } : null,
    tp: g.tp != null ? { px: g.tp, p: touchProb(price, g.tp, sigma) } : null,
    sl: g.sl != null ? { px: g.sl, p: touchProb(price, g.sl, sigma) } : null,
    // TP before SL, whenever that happens. Up is the TP for a long, the SL for a short.
    tpFirst: g.tp != null && g.sl != null
      ? (pos.side === 'long' ? firstTouchUp(price, g.tp, g.sl) : (() => { const u = firstTouchUp(price, g.sl, g.tp); return u == null ? null : 1 - u })())
      : null,
  } : null
  // Does the lean agree with the position? Only when the lean is a lean.
  const agrees = !pos || !sc || sc.lean === 'flat' ? null : (sc.lean === 'up') === (pos.side === 'long')
  return { pos, price, hours, v4, sigma, factors: fs, score: sc, cases: scenarios({ pos, price, sigma, setup }), risk, agrees, setup: setup ?? null }
}

// ── the track record ───────────────────────────────────────────────────────

/**
 * The signals that can be replayed from candles alone. Levels need the zones as they stood then,
 * and there is no history here of the order book or of funding, so the past record is of these
 * three (65% of the weight) and says so. The live record (outlooklog.js) grades all six.
 */
export const CANDLE_FACTORS = ['trend', 'momentum', 'range']
export const candleScoreOf = (fs, hours = 24) => scoreOf(fs.filter(f => candleIds(hours).includes(f.id)), hours)
/** The horizons replayed, in hours: "more samples" — some signals work at one and not another. */
export const PAST_HORIZONS = [4, 24, 72, 168, 720]
/** A signal "calls" a direction when it leans at least this far. */
export const CALL_AT = 0.25
const INSIDE_1S = 0.6827, TOUCH_1S = 0.3173

const DAY_MS = 864e5, H4_MS = 4 * 3600e3
const bandOf = (s) => Math.abs(s) < 15 ? 'flat' : (s > 0 ? 'up' : 'down') + (Math.abs(s) >= 40 ? '+' : '')
export const leanOfScore = (s) => Math.abs(s) < 15 ? 'flat' : s > 0 ? 'up' : 'down'
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null
const pctOfLog = (r) => r == null ? null : Math.expm1(r) * 100

/**
 * One replay of the past year, done once per market and shared by every record below.
 *
 * Once a day (every sixth 4h candle) it reads the candle signals as they stood — from candles that
 * had CLOSED by then; a daily candle counts only once its day is over — and keeps their values,
 * the fixed-weight score and the 4h volatility. Then, for each horizon, what happened next: the
 * log return, the cone's 1σ at the time, and whether the price TOUCHED the cone's ±1σ line on the
 * way (from the highs and lows in between). A horizon not yet over at the end of the data is null.
 */
export function pastSamples(c4, c1) {
  const daily = (c1 ?? []).filter(k => +k.c > 0)
  const out = []
  if (!c4?.length) return out
  const first = RANGE_LOOKBACK + RANGE_RECENT + 1
  let d = 0
  for (let i = first; i < c4.length - 1; i += 6) {
    const closeAt = +c4[i].t + H4_MS
    while (d < daily.length && +daily[d].t + DAY_MS <= closeAt) d++
    const price = +c4[i].c
    const fs = factors({ price, c4: c4.slice(Math.max(0, i + 1 - RANGE_CANDLES), i + 1), c1: daily.slice(Math.max(0, d - 260), d) })
      .filter(f => CANDLE_FACTORS.includes(f.id))
    const sc = scoreOf(fs)
    const v4 = vol4h(c4.slice(Math.max(0, i - 180), i + 1))
    if (!sc || !(v4 > 0) || !(price > 0)) continue
    const o = {}
    for (const h of PAST_HORIZONS) {
      const a = h / 4
      if (i + a >= c4.length) { o[h] = null; continue }
      const sigma = v4 * Math.sqrt(h / 4), end = +c4[i + a].c
      let hi = 0, lo = Infinity
      for (let j = i + 1; j <= i + a; j++) { hi = Math.max(hi, +c4[j].h); lo = Math.min(lo, +c4[j].l) }
      o[h] = end > 0 ? { ret: Math.log(end / price), sigma, up: hi >= price * Math.exp(sigma), dn: lo <= price * Math.exp(-sigma) } : null
    }
    const extra = readCandidates(c4, i, v4, null, ['rev3d', 'bbFade'])
    out.push({ t: +c4[i].t, i, f: { ...Object.fromEntries(fs.map(f => [f.id, f.v])), ...extra }, s: sc.score, out: o })
  }
  return out
}

const resolved = (samples, h) => (samples ?? []).filter(x => x.out?.[h])

/** Was a call right? up: higher; down: lower; flat (neutral): ended within 1σ. */
const hitFor = (lean) => (x, o) => lean === 'up' ? o.ret > 0 : lean === 'down' ? o.ret < 0 : Math.abs(o.ret) < o.sigma

/** Rate against chance, with a verdict. `div` thins overlapping windows (a week sampled daily). */
function judge(hits, n, chance, div) {
  if (!n) return { n: 0, verdict: 'none' }
  const rate = hits / n
  const nEff = n / Math.max(1, div)
  const z = (rate - chance) / Math.sqrt(Math.max(1e-9, chance * (1 - chance)) / nEff)
  return { n, rate, chance, z, verdict: nEff < 10 ? 'thin' : z >= 2 ? 'better' : z <= -2 ? 'worse' : 'chance' }
}

/**
 * How often a reading like `score` was right at horizon `h`, against how often the same call was
 * right on ANY day (the base rate), and the average move after it against the average on any day.
 * "Like this" is the same lean and strength band (under 40 / 40 and over); under 20 such days it
 * widens to the same lean, and says so. `scoreOf` picks the score replayed: the fixed weights
 * (x.s) or the learned ones (learnedScores).
 */
export function pastRecord(samples, score, h, scoreOfX = (x) => weightedScore(x.f, null, h)) {
  const all = resolved(samples, h).filter(x => scoreOfX(x) != null)
  if (!all.length || score == null) return null
  const lean = leanOfScore(score), hit = hitFor(lean)
  let match = all.filter(x => bandOf(scoreOfX(x)) === bandOf(score)), widened = false
  if (match.length < 20 && bandOf(score) !== lean) { match = all.filter(x => leanOfScore(scoreOfX(x)) === lean); widened = true }
  const base = all.filter(x => hit(x, x.out[h])).length / all.length
  const j = judge(match.filter(x => hit(x, x.out[h])).length, match.length, base, h / 24)
  return { ...j, lean, base, widened, days: all.length, from: all[0].t,
    avgAfter: pctOfLog(mean(match.map(x => x.out[h].ret))), avgAll: pctOfLog(mean(all.map(x => x.out[h].ret))) }
}

/**
 * Each candle signal on its own: on the days it called a direction, how often was the price that
 * way at horizon `h`? Chance is what calls in the same up/down mix would have scored on any day.
 * `edge` is the average move in the called direction, per call — a signal can be right less than
 * half the time and still be worth having if its right calls are the bigger ones.
 */
export function signalRecords(samples, h) {
  const all = resolved(samples, h)
  if (!all.length) return {}
  const up = all.filter(x => x.out[h].ret > 0).length / all.length
  const dn = all.filter(x => x.out[h].ret < 0).length / all.length
  const out = {}
  for (const id of candleIds(h)) {
    const calls = all.filter(x => Math.abs(x.f[id] ?? 0) >= CALL_AT)
    const ups = calls.filter(x => x.f[id] > 0).length
    const hits = calls.filter(x => Math.sign(x.f[id]) === Math.sign(x.out[h].ret) && x.out[h].ret !== 0).length
    const chance = calls.length ? (ups * up + (calls.length - ups) * dn) / calls.length : 0.5
    out[id] = { ...judge(hits, calls.length, chance, h / 24), edge: pctOfLog(mean(calls.map(x => Math.sign(x.f[id]) * x.out[h].ret))) }
  }
  return out
}

/**
 * Weights learned from a market's own past: a signal that has called this market better than
 * chance counts more, one that has done worse counts less — between ×0.25 and ×2, never flipped
 * (a signal that "works backwards" is more likely noise than a signal), and pulled towards ×1
 * when it has made few calls. Learned only from samples whose outcome was KNOWN at bar `upto`, so
 * a replayed day never learns from its own future.
 */
export function learnedWeights(samples, h, upto = Infinity) {
  const known = resolved(samples, h).filter(x => x.i + h / 4 <= upto)
  const rec = signalRecords(known, h)
  const m = {}
  for (const id of candleIds(h)) {
    const r = rec[id]
    if (!r?.n) { m[id] = 1; continue }
    const shrink = r.n / (r.n + 60)
    m[id] = clamp(1 + 5 * (r.rate - r.chance) * shrink, 0.25, 2)
  }
  return m
}

/** The candle score with multipliers applied, from a sample's signal values. */
export function weightedScore(f, m, h = 24) {
  const W = weightsFor(h)
  let w = 0, s = 0
  for (const id of candleIds(h)) if (f[id] != null) { const k = W[id] * (m?.[id] ?? 1); w += k; s += k * f[id] }
  return w ? Math.round(100 * s / w) : null
}

/**
 * The learned score on every past day, each with the weights it could have had THEN (walk-forward).
 * This is what makes "learned weights help" a claim the record can test rather than an assumption:
 * learning from the whole year and grading the same year would always look good.
 */
export function learnedScores(samples, h) {
  const m = new Map()
  for (const x of samples ?? []) m.set(x, weightedScore(x.f, learnedWeights(samples, h, x.i), h))
  return m
}

/**
 * The cone, checked: how often the price ended inside ±1σ (it should be ~68%) and how often it
 * touched each 1σ line on the way (~32% each, the chance the card prints for them). If the moves
 * ran bigger than the cone, its chances are too low, and the card should say so.
 */
export function coneRecord(samples, h) {
  const all = resolved(samples, h)
  if (!all.length) return null
  const n = all.length
  const inside = all.filter(x => Math.abs(x.out[h].ret) < x.out[h].sigma).length / n
  const up = all.filter(x => x.out[h].up).length / n, dn = all.filter(x => x.out[h].dn).length / n
  const off = inside - INSIDE_1S
  const verdict = n / Math.max(1, h / 24) < 10 ? 'thin' : off < -0.07 ? 'narrow' : off > 0.07 ? 'wide' : 'calibrated'
  return { n, inside, up, dn, expInside: INSIDE_1S, expTouch: TOUCH_1S, verdict }
}

/**
 * Every market pooled — more days than any one has. Per lean: how often the fixed score's calls
 * were right, against each market's own base rate weighted by how many calls it made.
 */
export function pooledRecord(byCoin, h) {
  const out = {}
  for (const lean of ['up', 'down']) {
    let hits = 0, n = 0, chance = 0
    for (const samples of byCoin) {
      const all = resolved(samples, h)
      if (!all.length) continue
      const hit = hitFor(lean)
      const calls = all.filter(x => leanOfScore(weightedScore(x.f, null, h)) === lean)
      const base = all.filter(x => hit(x, x.out[h])).length / all.length
      hits += calls.filter(x => hit(x, x.out[h])).length; n += calls.length; chance += calls.length * base
    }
    out[lean] = judge(hits, n, n ? chance / n : 0.5, h / 24)
  }
  const cones = byCoin.map(s => coneRecord(s, h)).filter(Boolean)
  const cn = cones.reduce((s, c) => s + c.n, 0)
  out.cone = cn ? { n: cn, inside: cones.reduce((s, c) => s + c.inside * c.n, 0) / cn } : null
  out.markets = byCoin.filter(s => resolved(s, h).length).length
  return out
}

/**
 * Pooled, the way pooledRecord does it: hits and calls ADD across markets, and chance is each
 * market's OWN base rate weighted by how many calls it made there. Pooling the raw days instead
 * would let one market's drift stand in for every other's -- a coin that only went up all year
 * makes "bullish" look right everywhere, and the pooled number would be measuring the year
 * rather than the signal.
 *
 * `per` is called once per market and returns { hits, n, chance, ...extra } or null.
 */
function poolBy(byCoin, div, per) {
  let hits = 0, n = 0, chance = 0, markets = 0, wsum = 0, wn = 0
  for (const samples of byCoin) {
    const r = per(samples)
    if (!r || !r.n) continue
    hits += r.hits; n += r.n; chance += r.n * r.chance; markets++
    if (r.weighted != null) { wsum += r.weighted * r.n; wn += r.n }
  }
  return { ...judge(hits, n, n ? chance / n : 0.5, div), markets, weighted: wn ? wsum / wn : null }
}

/**
 * Each signal, pooled across every market on screen. The per-market version (signalRecords) is
 * the one the learned weights come from; this is the same question asked of all of them at once,
 * which is the only way a signal with forty calls on each of eight markets ever says anything.
 * `edge` is the average move in the called direction, per call.
 */
export function pooledSignals(byCoin, h) {
  const out = {}
  for (const id of candleIds(h)) {
    out[id] = poolBy(byCoin, h / 24, (samples) => {
      const all = resolved(samples, h)
      if (!all.length) return null
      const up = all.filter(x => x.out[h].ret > 0).length / all.length
      const dn = all.filter(x => x.out[h].ret < 0).length / all.length
      const calls = all.filter(x => Math.abs(x.f[id] ?? 0) >= CALL_AT)
      if (!calls.length) return null
      const ups = calls.filter(x => x.f[id] > 0).length
      return {
        hits: calls.filter(x => Math.sign(x.f[id]) === Math.sign(x.out[h].ret) && x.out[h].ret !== 0).length,
        n: calls.length,
        chance: (ups * up + (calls.length - ups) * dn) / calls.length,
        weighted: pctOfLog(mean(calls.map(x => Math.sign(x.f[id]) * x.out[h].ret))),
      }
    })
    out[id].edge = out[id].weighted
  }
  return out
}

/** Every reading band, pooled: how often a band's call was right across all the markets. */
export function pooledBands(byCoin, h, scoreOfX = (x) => weightedScore(x.f, null, h)) {
  return BANDS.map(b => {
    const hit = hitFor(b.lean)
    const r = poolBy(byCoin, h / 24, (samples) => {
      const all = resolved(samples, h).filter(x => scoreOfX(x) != null)
      if (!all.length) return null
      const days = all.filter(x => inBand(b, scoreOfX(x)))
      if (!days.length) return null
      return {
        hits: days.filter(x => hit(x, x.out[h])).length,
        n: days.length,
        chance: all.filter(x => hit(x, x.out[h])).length / all.length,
        weighted: pctOfLog(mean(days.map(x => x.out[h].ret))),
      }
    })
    return { ...r, band: b.id, lean: b.lean, avgAfter: r.weighted }
  })
}

/** Every DIRECTIONAL call pooled -- bullish and bearish together -- at horizon `h`. */
function pooledCalls(byCoin, h) {
  return poolBy(byCoin, h / 24, (samples) => {
    const all = resolved(samples, h)
    if (!all.length) return null
    // This market's own base rate for each direction, worked out once rather than per call.
    const base = { up: all.filter(x => hitFor('up')(x, x.out[h])).length / all.length,
                   down: all.filter(x => hitFor('down')(x, x.out[h])).length / all.length }
    let hits = 0, chance = 0, n = 0
    for (const x of all) {
      const lean = leanOfScore(weightedScore(x.f, null, h) ?? 0)
      if (lean === 'flat') continue
      n++
      if (hitFor(lean)(x, x.out[h])) hits++
      chance += base[lean]
    }
    return n ? { hits, n, chance: chance / n } : null
  })
}

/**
 * The same directional calls in each half of the sample, pooled. One lucky stretch across eight
 * markets still looks like an edge until it is split in two. Each market is halved at its OWN
 * midpoint, because they do not all have the same amount of history.
 */
export function pooledHalves(byCoin, h) {
  const first = [], second = []
  for (const samples of byCoin) {
    const all = resolved(samples, h)
    if (all.length < 4) continue
    const mid = all[Math.floor(all.length / 2)].t
    first.push(all.filter(x => x.t < mid))
    second.push(all.filter(x => x.t >= mid))
  }
  if (!first.length) return null
  return [pooledCalls(first, h), pooledCalls(second, h)]
}

/** Every horizon, pooled: which window these markets have actually been readable at. */
export function pooledHorizons(byCoin) {
  return PAST_HORIZONS.map(h => {
    const r = pooledCalls(byCoin, h)
    const cones = byCoin.map(s => coneRecord(s, h)).filter(Boolean)
    const cn = cones.reduce((a, c) => a + c.n, 0)
    return { h, ...r, cone: cn ? cones.reduce((a, c) => a + c.inside * c.n, 0) / cn : null, coneN: cn }
  })
}

/**
 * How the markets on screen have actually moved over the scheduled reports -- CPI, the Fed, jobs
 * -- against how much they move on an ordinary day. Pooled, because one market over one year has
 * a dozen CPI days and that is not enough to say anything; eight markets have a hundred.
 *
 * An event counts for a sample when it falls inside that sample's OWN outcome window,
 * [x.t, x.t + h). Matching by calendar day would be wrong by up to a day: pastSamples steps 24h
 * from wherever the candle series happens to start, so its windows do not line up with midnight,
 * and a 13:30 release often belongs to the window that opened the day before.
 *
 * `events` is the macro feed's PAST list (/macro-data `past`); its `events` key holds only what
 * is still to come. Returns null when nothing lines up rather than a table of zeroes.
 */
export function pooledEventMoves(byCoin, events, h = 24, now = Date.now()) {
  const past = (events ?? []).filter(e => e && Number.isFinite(e.t) && e.t <= now).sort((a, b) => a.t - b.t)
  if (!past.length) return null
  const out = new Map()
  let nsum = 0, nn = 0
  for (const samples of byCoin) {
    for (const x of resolved(samples, h)) {
      const mv = Math.abs(pctOfLog(x.out[h].ret))
      nsum += mv; nn++
      const to = x.t + h * 3600e3
      for (const e of past) {
        if (e.t < x.t) continue
        if (e.t >= to) break
        const k = out.get(e.kind) ?? { kind: e.kind, n: 0, sum: 0, up: 0 }
        k.n++; k.sum += mv; if (x.out[h].ret > 0) k.up++
        out.set(e.kind, k)
      }
    }
  }
  if (!nn || !out.size) return null
  const normal = nsum / nn
  return {
    normal, days: nn, markets: byCoin.filter(s => resolved(s, h).length).length,
    kinds: [...out.values()].map(k => ({ kind: k.kind, n: k.n, up: k.up, avgAbs: k.sum / k.n, vsNormal: k.sum / k.n / normal - 1 }))
      .sort((a, b) => b.avgAbs - a.avgAbs),
  }
}

/** The cone pooled, with both lines, not just the share that ended inside. */
export function pooledCone(byCoin, h) {
  const cones = byCoin.map(s => coneRecord(s, h)).filter(Boolean)
  const n = cones.reduce((a, c) => a + c.n, 0)
  if (!n) return null
  const w = (k) => cones.reduce((a, c) => a + c[k] * c.n, 0) / n
  const inside = w('inside')
  const off = inside - INSIDE_1S
  return { n, markets: cones.length, inside, up: w('up'), dn: w('dn'), expInside: INSIDE_1S, expTouch: TOUCH_1S,
    verdict: n / Math.max(1, h / 24) < 10 ? 'thin' : off < -0.07 ? 'narrow' : off > 0.07 ? 'wide' : 'calibrated' }
}

// ── the track record, in detail (each row of the record opens to these) ──────────
// "make this section each individually expandable ... more detailed, more data ... so the user
// can see the records better". Everything below reads the same replay (pastSamples).

/** The reading bands, strongest bearish to strongest bullish. */
export const BANDS = [
  { id: 'sbear', lean: 'down', lo: -Infinity, hi: -40 },
  { id: 'bear', lean: 'down', lo: -40, hi: -15 },
  { id: 'neutral', lean: 'flat', lo: -15, hi: 15 },
  { id: 'bull', lean: 'up', lo: 15, hi: 40 },
  { id: 'sbull', lean: 'up', lo: 40, hi: Infinity },
]
const inBand = (b, s) => b.id === 'sbear' ? s <= -40 : b.id === 'sbull' ? s >= 40 : b.id === 'neutral' ? Math.abs(s) < 15 : b.id === 'bear' ? s > -40 && s <= -15 : s >= 15 && s < 40
export const bandOfScore = (s) => BANDS.find(b => inBand(b, s)) ?? null

/**
 * Every band at horizon `h`: how many days read that way, how often the band's call was right, the
 * same call's chance on any day, and the average move after. `scoreOfX` picks fixed or learned.
 */
export function bandTable(samples, h, scoreOfX = (x) => weightedScore(x.f, null, h)) {
  const all = resolved(samples, h).filter(x => scoreOfX(x) != null)
  if (!all.length) return null
  return BANDS.map(b => {
    const hit = hitFor(b.lean)
    const days = all.filter(x => inBand(b, scoreOfX(x)))
    const base = all.filter(x => hit(x, x.out[h])).length / all.length
    const j = judge(days.filter(x => hit(x, x.out[h])).length, days.length, base, h / 24)
    return { ...j, band: b.id, lean: b.lean, base, avgAfter: pctOfLog(mean(days.map(x => x.out[h].ret))) }
  })
}

/** The same reading in each half of the year — did it hold, or was it one lucky stretch? */
export function halvesRecord(samples, score, h, scoreOfX) {
  const all = resolved(samples, h)
  if (all.length < 4) return null
  const mid = all[Math.floor(all.length / 2)].t
  return [all.filter(x => x.t < mid), all.filter(x => x.t >= mid)].map(part => pastRecord(part, score, h, scoreOfX))
}

/** The last `k` days that read like `score`, newest first: when, the score, the move after, right? */
export function recentLike(samples, score, h, scoreOfX = (x) => weightedScore(x.f, null, h), k = 8) {
  const b = bandOfScore(score)
  if (!b) return []
  const hit = hitFor(b.lean)
  return resolved(samples, h).filter(x => { const s = scoreOfX(x); return s != null && inBand(b, s) })
    .slice(-k).reverse()
    .map(x => ({ t: x.t, s: scoreOfX(x), move: pctOfLog(x.out[h].ret), hit: hit(x, x.out[h]), inside: Math.abs(x.out[h].ret) < x.out[h].sigma }))
}

/** How the learned weights moved through the year: at a quarter, half, three quarters, and now. */
export function weightsOverTime(samples, h) {
  const all = resolved(samples, h)
  if (all.length < 8) return []
  return [0.25, 0.5, 0.75, 1].map(q => {
    const x = all[Math.min(all.length - 1, Math.floor(all.length * q) - 1)]
    return { t: x.t, m: learnedWeights(samples, h, q === 1 ? Infinity : x.i + h / 4) }
  })
}

/**
 * How big the moves were, in the cone's own σ, against what a normal distribution expects: the
 * share of days whose move was under 0.5σ, 0.5–1σ, 1–1.5σ, 1.5–2σ and over 2σ.
 */
export const MOVE_BINS = [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, Infinity]]
export function moveDistribution(samples, h) {
  const all = resolved(samples, h)
  if (!all.length) return null
  return MOVE_BINS.map(([a, b]) => {
    const n = all.filter(x => { const z = Math.abs(x.out[h].ret) / x.out[h].sigma; return z >= a && z < b }).length
    const expect = 2 * ((b === Infinity ? 1 : normCdf(b)) - normCdf(a))
    return { lo: a, hi: b, share: n / all.length, expect, n }
  })
}
