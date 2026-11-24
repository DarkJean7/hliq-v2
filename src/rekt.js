/**
 * Rekt-01: the personal agent that learns by itself ("i would like my own personal agent that
 * learns itself" → self-tuning, settings changeable only in dev mode).
 *
 * It blends four signals into one score per market and learns how much to trust each:
 *   oracle     the Oracle's 24h call (score / 100)
 *   momentum   the 30-day trend, tanh(r30 / 20%)
 *   reversion  the opposite of the 7-day move, −tanh(r7 / 15%)
 *   funding    against the side paying funding, −f / 0.01%/h, clipped to ±1
 *
 * How it learns — two loops, both explainable on its card:
 *   1. Signal weights, from SHADOW calls. Every run it notes what each signal said about every
 *      market it watches, and once its horizon has passed it scores each signal against what the
 *      price actually did (Hedge: w ← w·e^(η·reward)). It learns from every market every hour,
 *      not only from the handful it trades, so it does not need months of its own trades.
 *   2. Its own habits, from its own trades. Each position is opened with a stop distance and a
 *      maximum hold picked from a few choices (a bandit: mostly the best so far, sometimes another
 *      to keep learning), and the trade's result is credited to the choices it was opened with.
 *
 * Everything here is pure; src/agentrunner.js calls it and keeps its state.
 */
import { retOver, liquidUniverse } from './agents.js'

const HOUR = 3600e3
export const REKT_ID = 'rekt01'
export const SIGNALS = ['oracle', 'momentum', 'reversion', 'funding']
export const SIGNAL_NAME = {
  oracle: ['Oracle call', 'Lectura del Oráculo'], momentum: ['30-day trend', 'Tendencia 30 días'],
  reversion: ['7-day bounce', 'Rebote 7 días'], funding: ['Funding', 'Funding'],
}
export const STYLES = {
  cautious:   { enter: 0.45, levMul: 0.5 },
  balanced:   { enter: 0.30, levMul: 1 },
  aggressive: { enter: 0.18, levMul: 1.5 },
}
// The horizon sets how long a shadow call is given before it is scored, and the holds to try.
export const HORIZONS = {
  hours: { evalH: 4,  holds: [8, 24, 48] },
  days:  { evalH: 24, holds: [48, 96, 168] },
  weeks: { evalH: 72, holds: [168, 336, 504] },
}
export const STOPS = [3, 5, 8, 12, 18]
export const ETA = 0.05            // learning rate of the signal weights
export const FLOOR = 0.05          // no signal's share falls below 5%: it can always come back

export const DEFAULT_CONFIG = {
  maxLev: 3, maxPositions: 4, maxLossPct: 2, pauseDDPct: 25,
  markets: { mode: 'all', list: [] }, style: 'balanced', horizon: 'days', arena: true, paused: false,
}

const num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
const clamp1 = (x) => Math.max(-1, Math.min(1, x))

/** Settings as they may be saved: every field clamped to its range, unknowns dropped. */
export function cleanConfig(c = {}) {
  const D = DEFAULT_CONFIG
  const mode = ['all', 'allow', 'block'].includes(c?.markets?.mode) ? c.markets.mode : D.markets.mode
  const list = [...new Set((Array.isArray(c?.markets?.list) ? c.markets.list : String(c?.markets?.list ?? '').split(/[\s,]+/))
    .map(s => String(s).trim().toUpperCase().replace(/^K/, 'k')).filter(s => /^[A-Za-z0-9]{1,15}$/.test(s)))].slice(0, 60)
  return {
    maxLev: Math.round(num(c.maxLev, 1, 10, D.maxLev)),
    maxPositions: Math.round(num(c.maxPositions, 1, 8, D.maxPositions)),
    maxLossPct: num(c.maxLossPct, 0.25, 10, D.maxLossPct),
    pauseDDPct: num(c.pauseDDPct, 5, 90, D.pauseDDPct),
    markets: { mode, list },
    style: c.style in STYLES ? c.style : D.style,
    horizon: c.horizon in HORIZONS ? c.horizon : D.horizon,
    arena: c.arena == null ? D.arena : !!c.arena,
    paused: !!c.paused,
  }
}

export const allowed = (coin, cfg) => cfg.markets.mode === 'all' || (cfg.markets.mode === 'allow' ? cfg.markets.list.includes(coin) : !cfg.markets.list.includes(coin))

export function initLearn(now = Date.now()) {
  return {
    since: now, w: Object.fromEntries(SIGNALS.map(s => [s, 1 / SIGNALS.length])),
    stats: Object.fromEntries(SIGNALS.map(s => [s, { n: 0, called: 0, hits: 0, reward: 0 }])),
    shadow: [], hist: [[now, Object.fromEntries(SIGNALS.map(s => [s, 1 / SIGNALS.length]))]],
    arms: { stop: {}, hold: {} }, open: {}, trades: 0, peak: null, pausedBy: null,
  }
}

/** What each signal says about one market, −1 (down) … +1 (up); null when it has nothing. */
export function signalsOf(coin, ctx) {
  const r = ctx.readings?.[coin]
  const d = ctx.daily?.[coin]
  const r30 = retOver(d, 30), r7 = retOver(d, 7)
  const f = ctx.funding?.[coin]
  return {
    oracle: r && Number.isFinite(r.score) && ctx.now - r.t < 6 * HOUR ? clamp1(r.score / 100) : null,
    momentum: r30 == null ? null : Math.tanh(r30 / 20),
    reversion: r7 == null ? null : -Math.tanh(r7 / 15),
    funding: Number.isFinite(f) ? clamp1(-f / 0.0001) : null,
  }
}

/** The blended score: the weighted mean of the signals that have something to say. */
export function blend(sig, w) {
  let s = 0, n = 0
  for (const k of SIGNALS) if (sig[k] != null) { s += w[k] * sig[k]; n += w[k] }
  return n > 0 ? s / n : null
}

/** Shares that sum to 1, none below FLOOR. */
export function normalize(w) {
  const out = {}
  const tot = SIGNALS.reduce((a, k) => a + Math.max(0, w[k] || 0), 0) || 1
  for (const k of SIGNALS) out[k] = Math.max(0, w[k] || 0) / tot
  // Lift the floored ones and take it evenly, proportionally, from the rest.
  const low = SIGNALS.filter(k => out[k] < FLOOR)
  if (low.length) {
    const need = low.reduce((a, k) => a + FLOOR - out[k], 0)
    const rest = SIGNALS.filter(k => !low.includes(k)), restTot = rest.reduce((a, k) => a + out[k], 0)
    for (const k of low) out[k] = FLOOR
    for (const k of rest) out[k] -= need * out[k] / restTot
  }
  return out
}

/** The watch list: the most traded markets the settings allow, and every allow-listed one. */
export function universeOf(ctx, cfg) {
  const base = cfg.markets.mode === 'allow' ? cfg.markets.list : liquidUniverse(ctx.daily, 30)
  return base.filter(c => allowed(c, cfg))
}

/**
 * Loop 1. Notes this run's shadow calls and scores the ones whose horizon has passed against the
 * price now. A shadow call is scored once; its price move is capped at ±5% so one wild market
 * cannot teach everything. → how many were scored.
 */
export function learnSignals(L, ctx, cfg) {
  const { evalH } = HORIZONS[cfg.horizon]
  const px = (c) => Number(ctx.marks?.[c]) || 0
  let scored = 0
  const keep = []
  for (const s of L.shadow) {
    if (ctx.now - s.t < evalH * HOUR) { keep.push(s); continue }
    const p = px(s.coin)
    if (!(p > 0) || !(s.px > 0)) continue
    const m = Math.max(-1, Math.min(1, Math.log(p / s.px) / 0.05))
    const w = { ...L.w }
    for (const k of SIGNALS) {
      const v = s.sig[k]
      if (v == null) continue
      const rw = v * m
      w[k] *= Math.exp(ETA * rw)
      const st = L.stats[k]
      st.n++; st.reward += rw
      if (Math.abs(v) > 0.1) { st.called = (st.called ?? 0) + 1; if (Math.sign(v) === Math.sign(m)) st.hits++ }
    }
    L.w = normalize(w)
    scored++
  }
  // One call per market per hour is enough; older than three horizons is dropped unscored.
  L.shadow = keep.filter(s => ctx.now - s.t < 3 * evalH * HOUR)
  const hour = Math.floor(ctx.now / HOUR)
  const noted = new Set(L.shadow.filter(s => Math.floor(s.t / HOUR) === hour).map(s => s.coin))
  for (const coin of universeOf(ctx, cfg)) {
    if (noted.has(coin) || !(px(coin) > 0)) continue
    const sig = signalsOf(coin, ctx)
    if (SIGNALS.some(k => sig[k] != null)) L.shadow.push({ t: ctx.now, coin, px: px(coin), sig })
  }
  if (L.shadow.length > 6000) L.shadow = L.shadow.slice(-6000)
  const last = L.hist.at(-1)
  if (!last || ctx.now - last[0] >= 6 * HOUR) { L.hist.push([ctx.now, { ...L.w }]); if (L.hist.length > 1500) L.hist.shift() }
  return scored
}

/** Loop 2's pick: mostly the best average so far; an untried choice or a random one sometimes. */
export function pickArm(stats, choices, rng = Math.random) {
  const n = choices.reduce((a, c) => a + (stats[c]?.n ?? 0), 0)
  const untried = choices.filter(c => !stats[c]?.n)
  const eps = Math.max(0.1, 0.5 / Math.sqrt(1 + n))
  if (untried.length && rng() < 0.5) return untried[Math.floor(rng() * untried.length)]
  if (rng() < eps) return choices[Math.floor(rng() * choices.length)]
  let best = choices[0], bv = -Infinity
  for (const c of choices) { const s = stats[c]; const v = s?.n ? s.sum / s.n : 0; if (v > bv) { bv = v; best = c } }
  return best
}

/** A trade ended: credit its result (% of equity at the open) to the stop and hold it was opened with. */
export function learnTrade(L, coin, pnl) {
  const o = L.open[coin]
  delete L.open[coin]
  if (!o || !Number.isFinite(pnl) || !(o.eq > 0)) return null
  const r = pnl / o.eq * 100
  for (const [k, v] of [['stop', o.stop], ['hold', o.hold]]) {
    const s = (L.arms[k][v] ??= { n: 0, sum: 0 })
    s.n++; s.sum += r
  }
  L.trades++
  return r
}

/**
 * The agent object the runner trades (src/agentrunner.js): decide() gets ctx.learn (its state)
 * and ctx.config, and answers wanted positions with their leverage, notional and stop.
 */
export const rektAgent = {
  id: REKT_ID, name: 'Rekt-01', color: '#f5a524', lev: 3, max: 4, every: HOUR, personal: true, stateful: true,
  blurb: ['Your own agent. It blends the Oracle\'s call, the 30-day trend, the 7-day bounce and funding into one score, and learns by itself how much to trust each — every hour it checks what each signal said against what the price then did. It also learns its own stop distance and holding time from its trades. Its settings are changed in dev mode.',
          'Tu propio agente. Combina la lectura del Oráculo, la tendencia de 30 días, el rebote de 7 días y el funding en una puntuación, y aprende solo cuánto confiar en cada una — cada hora compara lo que dijo cada señal con lo que hizo el precio. También aprende su distancia de stop y tiempo de tenencia de sus propias operaciones. Sus ajustes se cambian en modo dev.'],
  maxOf: (cfg) => cfg.maxPositions,
  levOf: (cfg) => Math.max(1, Math.min(cfg.maxLev, Math.round(cfg.maxLev * STYLES[cfg.style].levMul))),
  decide(ctx) {
    const cfg = ctx.config, L = ctx.learn
    if (!Object.keys(ctx.daily ?? {}).length || !Object.keys(ctx.marks ?? {}).length) return null
    learnSignals(L, ctx, cfg)
    const { enter } = STYLES[cfg.style], { holds } = HORIZONS[cfg.horizon]
    const lev = this.levOf(cfg), max = cfg.maxPositions
    const score = (coin) => blend(signalsOf(coin, ctx), L.w)
    // The account's peak, and a pause when it has fallen too far from it.
    if (Number.isFinite(ctx.equity)) {
      L.peak = Math.max(L.peak ?? ctx.equity, ctx.equity)
      const dd = (1 - ctx.equity / L.peak) * 100
      if (dd >= cfg.pauseDDPct) L.pausedBy ??= { t: ctx.now, dd }
      else if (dd < cfg.pauseDDPct / 2) L.pausedBy = null
    }
    const keep = []
    for (const h of ctx.held ?? []) {
      const o = L.open[h.coin]
      const sc = score(h.coin)
      const age = (ctx.now - (o?.t ?? h.openedAt ?? ctx.now)) / HOUR
      if (!allowed(h.coin, cfg)) continue                                  // closed: not allowed any more
      if (o?.hold && age >= o.hold) continue                               // closed: held as long as it chose to
      if (sc != null && (h.side === 'long' ? sc : -sc) < -enter / 2) continue  // closed: the blend turned against it
      keep.push({ coin: h.coin, side: h.side, why: `score ${sc == null ? '—' : (sc >= 0 ? '+' : '') + sc.toFixed(2)}, ${Math.floor(age)}h of ${o?.hold ?? '?'}h` })
    }
    if (cfg.paused || L.pausedBy) return keep
    const cands = universeOf(ctx, cfg).map(coin => ({ coin, sc: score(coin), sig: signalsOf(coin, ctx) }))
      .filter(x => x.sc != null && Math.abs(x.sc) >= enter && !keep.some(k => k.coin === x.coin) && (ctx.cool?.[x.coin] ?? 0) <= ctx.now)
      .sort((a, b) => Math.abs(b.sc) - Math.abs(a.sc))
    const out = [...keep]
    for (const c of cands) {
      if (out.length >= max) break
      const stop = pickArm(L.arms.stop, STOPS, ctx.rng)
      const hold = pickArm(L.arms.hold, holds, ctx.rng)
      // Sized so the stop costs at most maxLossPct of equity, and never more than an equal share.
      const eq = ctx.equity > 0 ? ctx.equity : 0
      const notional = Math.min(eq * 0.98 * lev / max, eq * cfg.maxLossPct / stop)
      const top = SIGNALS.filter(k => c.sig[k] != null).sort((a, b) => Math.abs(L.w[b] * c.sig[b]) - Math.abs(L.w[a] * c.sig[a]))[0]
      out.push({ coin: c.coin, side: c.sc > 0 ? 'long' : 'short', lev, notional, stopPct: stop, meta: { stop, hold, sig: c.sig },
        why: `score ${(c.sc >= 0 ? '+' : '') + c.sc.toFixed(2)}, led by ${SIGNAL_NAME[top][0].toLowerCase()} · stop ${stop}%, hold ≤${hold}h` })
    }
    return out
  },
  onOpen(L, w, { t, equity }) { if (w.meta) L.open[w.coin] = { t, eq: equity, stop: w.meta.stop, hold: w.meta.hold, sig: w.meta.sig } },
  onClose(L, coin, pnl) { return learnTrade(L, coin, pnl) },
  describe(L, cfg) {
    const arm = (k, list) => list.map(v => ({ v, n: L.arms[k][v]?.n ?? 0, avg: L.arms[k][v]?.n ? L.arms[k][v].sum / L.arms[k][v].n : null }))
    return {
      since: L.since, weights: L.w, hist: L.hist.slice(-200), trades: L.trades, pending: L.shadow.length,
      stats: Object.fromEntries(SIGNALS.map(k => [k, { n: L.stats[k].n, hit: L.stats[k].called ? L.stats[k].hits / L.stats[k].called : null, avg: L.stats[k].n ? L.stats[k].reward / L.stats[k].n : null }])),
      stops: arm('stop', STOPS), holds: arm('hold', HORIZONS[cfg.horizon].holds),
      pausedBy: L.pausedBy, peak: L.peak,
    }
  },
}
