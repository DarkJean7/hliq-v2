/**
 * Candidate signals for the Outlook score, kept apart until one EARNS its place.
 *
 * Asked: "do 1" — find out, on real candles, which signals call these markets better than chance
 * before adding any to the score. tests/signal-research.mjs replays each one over a year of
 * real 4h candles across many markets, at 4h / 24h / 3d / 7d, and a signal goes into the score
 * only if it beats chance pooled AND in both halves of the year. Whatever passes is exactly the
 * code below: the research and the app share it, so what was tested is what ships.
 *
 * Why these: the first pooled record (14 markets, 1,797 bearish calls) was right LESS often than
 * chance — after a bearish read, prices tended to bounce. That points at short-term reversal, so
 * most candidates fade a move; trend and breakout are here to be beaten.
 *
 * Each takes closed 4h candles `c4` ({o,h,l,c}, oldest first), the index `i` of the candle the
 * reading is taken at (nothing after it is read), and `v4` — one 4h candle's volatility at i
 * (outlook.js vol4h). Each returns -1..+1 (+ leans up), or null when it cannot be read.
 */
import { rsi } from './zones.js'
import { rangeRead, RANGE_CANDLES } from './outlook.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
/** The move over the last `n` candles in standard deviations of an n-candle move. */
function zMove(c4, i, v4, n) {
  if (i - n < 0 || !(v4 > 0)) return null
  const r = Math.log(+c4[i].c / +c4[i - n].c)
  return Number.isFinite(r) ? r / (v4 * Math.sqrt(n)) : null
}

export const CANDIDATES = {
  /** Fade the last 24 hours: a 2σ day leans fully the other way. */
  revDay: { kind: 'fade', name: ['Fade 24h move', 'Contra movimiento 24h'], fn: (c4, i, v4) => { const z = zMove(c4, i, v4, 6); return z == null ? null : -clamp(z / 2, -1, 1) } },
  /** Fade the last three days. */
  rev3d: { kind: 'fade', name: ['Fade 3-day move', 'Contra movimiento 3d'], fn: (c4, i, v4) => { const z = zMove(c4, i, v4, 18); return z == null ? null : -clamp(z / 2, -1, 1) } },
  /** Follow the last week. */
  trend7d: { kind: 'follow', name: ['7-day trend', 'Tendencia 7d'], fn: (c4, i, v4) => { const z = zMove(c4, i, v4, 42); return z == null ? null : clamp(z / 2, -1, 1) } },
  /** Fade 4h RSI only at its extremes: 70+ leans down, 30- leans up, in between nothing. */
  rsiFade: { kind: 'fade', name: ['RSI extremes (4h)', 'RSI extremos (4h)'], fn: (c4, i) => {
    if (i < 60) return null
    const r = rsi(c4.slice(i - 60, i + 1).map(k => ({ c: +k.c })))
    return r == null ? null : r >= 70 ? -Math.min(1, (r - 70) / 15) : r <= 30 ? Math.min(1, (30 - r) / 15) : 0
  } },
  /** Fade a close far from its 20-candle average (Bollinger z). */
  bbFade: { kind: 'fade', name: ['Bollinger stretch (4h)', 'Estiramiento Bollinger (4h)'], fn: (c4, i) => {
    if (i < 19) return null
    const c = c4.slice(i - 19, i + 1).map(k => +k.c)
    const m = c.reduce((s, x) => s + x, 0) / 20
    const sd = Math.sqrt(c.reduce((s, x) => s + (x - m) ** 2, 0) / 19)
    return sd > 0 ? -clamp((c.at(-1) - m) / sd / 2.5, -1, 1) : null
  } },
  /** Fade a run of four or more 4h candles the same colour. */
  streak: { kind: 'fade', name: ['Candle streak (4h)', 'Racha de velas (4h)'], fn: (c4, i) => {
    const dir = (k) => Math.sign(+k.c - +k.o)
    const d = dir(c4[i])
    if (!d) return 0
    let n = 1
    for (let j = i - 1; j >= 0 && j > i - 12 && dir(c4[j]) === d; j--) n++
    return n >= 4 ? -d * Math.min(1, (n - 3) / 3) : 0
  } },
  /** Follow a close above the last 20 days' high, or below their low. */
  breakout20d: { kind: 'follow', name: ['20-day breakout', 'Ruptura 20d'], fn: (c4, i) => {
    if (i < 120) return null
    let hi = 0, lo = Infinity
    for (let j = i - 120; j < i; j++) { hi = Math.max(hi, +c4[j].h); lo = Math.min(lo, +c4[j].l) }
    const c = +c4[i].c
    return c > hi ? 1 : c < lo ? -1 : 0
  } },
  /** The Range signal reversed: fade the large 4h candles instead of following them. */
  rangeFade: { kind: 'fade', name: ['Fade large candles (4h)', 'Contra velas grandes (4h)'], fn: (c4, i) => {
    const r = rangeRead(c4.slice(Math.max(0, i + 1 - RANGE_CANDLES), i + 1))
    return r ? -r.v : null
  } },
  /**
   * Fade crowded funding: the average hourly rate over the last day against Hyperliquid's
   * resting 0.00125%/h. Needs `funding` ([{t, rate}], rate a fraction per hour, oldest first);
   * null without it — the research only has a couple of months of funding history.
   */
  fundingFade: { kind: 'fade', name: ['Funding extremes', 'Funding extremo'], needs: 'funding', fn: (c4, i, v4, ctx) => {
    const f = ctx?.funding
    if (!f?.length) return null
    const at = +c4[i].t + 4 * 3600e3, from = at - 864e5
    let s = 0, n = 0
    for (const x of f) if (x.t > from && x.t <= at) { s += x.rate; n++ }
    if (n < 12) return null
    return -clamp((s / n - 0.0000125) / 0.0001, -1, 1)
  } },
}

/** Every candidate read at bar `i`: {id: v}. Nulls are left out. */
export function readCandidates(c4, i, v4, ctx, ids = Object.keys(CANDIDATES)) {
  const out = {}
  for (const id of ids) {
    const v = CANDIDATES[id].fn(c4, i, v4, ctx)
    if (v != null && Number.isFinite(v)) out[id] = v
  }
  return out
}

/**
 * Score a signal across markets at one horizon. `rows` are {v, ret, half} — the signal's value
 * on a day, the log return that followed, and which half of the year (0/1) the day was in.
 * A call is |v| ≥ `callAt`. Right means the price moved the called way. Chance is what calls in
 * the same up/down mix would have scored on any day of the same markets. Also: the average move
 * in the called direction per call (edge) and its t-statistic, each thinned for overlapping
 * windows (a 7-day outcome sampled daily is about one independent week per seven days).
 */
export function scoreSignal(rows, h, callAt = 0.25) {
  const div = Math.max(1, h / 24)
  const evalOf = (rs) => {
    const all = rs.filter(r => Number.isFinite(r.ret))
    if (!all.length) return { n: 0 }
    const up = all.filter(r => r.ret > 0).length / all.length, dn = all.filter(r => r.ret < 0).length / all.length
    const calls = all.filter(r => Math.abs(r.v) >= callAt)
    const n = calls.length
    if (!n) return { n: 0 }
    const ups = calls.filter(r => r.v > 0).length
    const hits = calls.filter(r => Math.sign(r.v) === Math.sign(r.ret) && r.ret !== 0).length
    const chance = (ups * up + (n - ups) * dn) / n
    const rate = hits / n, nEff = n / div
    const z = (rate - chance) / Math.sqrt(Math.max(1e-9, chance * (1 - chance)) / nEff)
    const sr = calls.map(r => Math.sign(r.v) * r.ret)
    const m = sr.reduce((s, x) => s + x, 0) / n
    const sd = Math.sqrt(sr.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1))
    const t = sd > 0 ? m / (sd / Math.sqrt(nEff)) : 0
    return { n, rate, chance, z, edgeBps: m * 1e4, t }
  }
  const all = evalOf(rows), h0 = evalOf(rows.filter(r => r.half === 0)), h1 = evalOf(rows.filter(r => r.half === 1))
  // Earns its place: better than chance pooled — by the hit rate and by the money — and better in
  // BOTH halves of the year, so it is not one lucky stretch.
  const pass = all.n > 0 && all.z >= 2 && all.t >= 2 && h0.n > 0 && h1.n > 0 && h0.rate > h0.chance && h1.rate > h1.chance && h0.edgeBps > 0 && h1.edgeBps > 0
  return { ...all, halves: [h0, h1], pass }
}
