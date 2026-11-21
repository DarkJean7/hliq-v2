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
// Hyperliquid's resting funding: 0.01% per 8h, so 0.00125% an hour. Above it longs pay more
// than the default — crowded long; below, crowded short.
const BASE_FUNDING = 0.00125

/**
 * The six factors. Each is { id, v: -1..1, w, x } where `x` is what it was read from, or null
 * and left out when its data is missing. `fundingPctHr` is percent per hour (as _mktCtxMap holds
 * it); `ratio` is bid ÷ ask depth near the price.
 */
export function factors({ price, c4, c1, setup, fundingPctHr = null, ratio = null }) {
  const out = []
  // Trend — daily: price against its 50-day average, and the 50 against the 200.
  const s50 = sma(c1, 50), s200 = sma(c1, 200)
  if (s50 != null) {
    const a = price > s50 ? 1 : -1
    const b = s200 != null ? (s50 > s200 ? 1 : -1) : null
    out.push({ id: 'trend', w: WEIGHTS.trend, v: b == null ? a : (a + b) / 2, x: { s50, s200, above: a > 0, golden: b == null ? null : b > 0 } })
  }
  // Momentum — 4h: RSI (stretched readings lean back the other way) and the MACD histogram.
  const r = rsi(c4)
  const m = macdHist((c4 ?? []).map(k => +k.c))
  if (r != null || m) {
    const vr = r == null ? null : r >= 75 ? -0.5 : r <= 25 ? 0.5 : clamp((r - 50) / 20, -1, 1)
    const vm = m == null ? null : (m.now > 0 ? 0.5 : -0.5) + (m.now > m.prev ? 0.5 : -0.5)
    const vs = [vr, vm].filter(v => v != null)
    out.push({ id: 'momentum', w: WEIGHTS.momentum, v: vs.reduce((s, v) => s + v, 0) / vs.length, x: { rsi: r, macd: m } })
  }
  // Range category — 4h, see rangeRead.
  const rr = rangeRead(c4)
  if (rr) out.push({ id: 'range', w: WEIGHTS.range, v: rr.v, x: rr })
  // Levels — where price sits against the support/resistance the Analysis tab finds.
  if (setup?.state) {
    const v = { breakout: 1, breakdown: -1, support: 0.5, resistance: -0.5 }[setup.state] ?? 0
    out.push({ id: 'levels', w: WEIGHTS.levels, v, x: { state: setup.state } })
  }
  // Book — more bids than asks near the price leans up.
  if (ratio > 0) out.push({ id: 'book', w: WEIGHTS.book, v: clamp(Math.log2(ratio) / Math.log2(1.5), -1, 1), x: { ratio } })
  // Funding — contrarian: a crowded side is the one that gets squeezed.
  if (Number.isFinite(fundingPctHr)) out.push({ id: 'funding', w: WEIGHTS.funding, v: -clamp((fundingPctHr - BASE_FUNDING) / 0.01, -1, 1), x: { pctHr: fundingPctHr } })
  return out
}

/** -100..100 over the factors that have data, with how much of the full weight that is. */
export function scoreOf(fs) {
  const w = fs.reduce((s, f) => s + f.w, 0)
  if (!w) return null
  const total = Object.values(WEIGHTS).reduce((s, x) => s + x, 0)
  const score = Math.round(100 * fs.reduce((s, f) => s + f.w * f.v, 0) / w)
  const a = Math.abs(score)
  const strength = a < 15 ? 'neutral' : a < 40 ? 'weak' : a < 70 ? 'moderate' : 'strong'
  const lean = a < 15 ? 'flat' : score > 0 ? 'up' : 'down'
  const agree = fs.filter(f => Math.sign(f.v) === Math.sign(score) && f.v !== 0).length
  return { score, strength, lean, agree, of: fs.length, coverage: w / total }
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

export const HORIZONS = { '24h': 24, '7d': 168 }

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
export function outlookFor({ position, price, c4, c1, setup, ratio = null, fundingPctHr = null, orders = [], hours = 24 }) {
  const pos = posOf(position)
  const v4 = vol4h(c4)
  const sigma = sigmaFor(v4, hours)
  const fs = price > 0 ? factors({ price, c4, c1, setup, fundingPctHr, ratio }) : []
  const sc = scoreOf(fs)
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

// ── version 2: the past record ───────────────────────────────────────────────

/**
 * The signals that can be replayed from candles alone. Levels need the zones as they stood then,
 * and there is no history here of the order book or of funding, so the past record is of these
 * three (65% of the weight) and says so. The live record (outlooklog.js) grades all six.
 */
export const CANDLE_FACTORS = ['trend', 'momentum', 'range']
export const candleScoreOf = (fs) => scoreOf(fs.filter(f => CANDLE_FACTORS.includes(f.id)))

const DAY_MS = 864e5, H4_MS = 4 * 3600e3
const bandOf = (s) => Math.abs(s) < 15 ? 'flat' : (s > 0 ? 'up' : 'down') + (Math.abs(s) >= 40 ? '+' : '')
const leanOfScore = (s) => Math.abs(s) < 15 ? 'flat' : s > 0 ? 'up' : 'down'

/**
 * Replay the candle score once a day (every sixth 4h candle) over the candles given, and pair
 * each with what happened next: the log return `hours` later, and the cone's 1σ at the time.
 * Everything at a sample is computed from candles that had CLOSED by then — a daily candle counts
 * only once its day is over — so no sample sees its own future.
 */
export function pastSamples(c4, c1, hours) {
  const ahead = Math.round(hours / 4)
  const daily = (c1 ?? []).filter(k => +k.c > 0)
  const out = []
  if (!c4?.length) return out
  const first = RANGE_LOOKBACK + RANGE_RECENT + 1
  let d = 0
  for (let i = first; i + ahead < c4.length; i += 6) {
    const closeAt = +c4[i].t + H4_MS
    while (d < daily.length && +daily[d].t + DAY_MS <= closeAt) d++
    const price = +c4[i].c
    const fs = factors({ price, c4: c4.slice(Math.max(0, i + 1 - RANGE_CANDLES), i + 1), c1: daily.slice(Math.max(0, d - 260), d) })
    const sc = candleScoreOf(fs)
    const sigma = sigmaFor(vol4h(c4.slice(Math.max(0, i - 180), i + 1)), hours)
    const end = +c4[i + ahead].c
    if (!sc || !(sigma > 0) || !(price > 0) || !(end > 0)) continue
    out.push({ t: +c4[i].t, s: sc.score, ret: Math.log(end / price), sigma })
  }
  return out
}

/**
 * How often a score like `score` was right, against how often the same call would have been
 * right on ANY day — the base rate. A bullish read that was right 58% of the time in a market
 * that rose on 57% of days is no read at all, and this says so.
 *
 * "Like this" is the same lean and strength band (under 40 / 40 and over); with fewer than 20
 * such days it widens to the same lean, and says it did. Samples a week apart overlap when the
 * horizon is a week, so the test of whether it beats the base rate counts days ÷ 7, not days.
 */
export function pastRecord(samples, score, hours) {
  if (!samples?.length || score == null) return null
  const lean = leanOfScore(score)
  const hit = (x) => lean === 'up' ? x.ret > 0 : lean === 'down' ? x.ret < 0 : Math.abs(x.ret) < x.sigma
  let match = samples.filter(x => bandOf(x.s) === bandOf(score)), widened = false
  if (match.length < 20 && bandOf(score) !== lean) { match = samples.filter(x => leanOfScore(x.s) === lean); widened = true }
  const n = match.length
  const base = samples.filter(hit).length / samples.length
  if (!n) return { lean, n: 0, base, widened, verdict: 'none', days: samples.length }
  const rate = match.filter(hit).length / n
  const nEff = n / Math.max(1, hours / 24)
  const se = Math.sqrt(Math.max(1e-9, base * (1 - base)) / nEff)
  const z = (rate - base) / se
  const verdict = nEff < 10 ? 'thin' : z >= 2 ? 'better' : z <= -2 ? 'worse' : 'chance'
  const avg = match.reduce((s, x) => s + x.ret, 0) / n
  return { lean, n, rate, base, z, verdict, widened, avg: Math.expm1(avg) * 100, days: samples.length, from: samples[0].t }
}
