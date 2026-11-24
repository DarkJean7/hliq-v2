/**
 * The Agent Arena: shared paper agents, each trading its own $1,000 paper account on the server.
 * "go with 1 + 3, shared" — an agent that follows the Oracle's own calls, a few simple personas
 * beside it, and buy-and-hold BTC as the line every one of them has to beat.
 *
 * This file only DECIDES: pure functions from what an agent can see to the positions it wants.
 * src/agentrunner.js does the trading, through the same paper engine a person's account uses
 * (src/paperhost.js withStore → src/paper.js), so an agent pays the same fees, slippage and
 * funding and is stopped out by the same server tick.
 *
 * What an agent sees (ctx):
 *   now
 *   readings: { coin: { score, sigma, t } }  the Oracle's latest 24h call per market (server log)
 *   daily:    { coin: [{t,o,h,l,c,v}] }      daily candles the Oracle's logger keeps on disk
 *   funding:  { coin: hourly rate (fraction) } from metaAndAssetCtxs
 *   held:     [{ coin, side: 'long'|'short', openedAt }]
 *   cool:     { coin: until }                 a coin just closed is not reopened at once
 *
 * decide() answers the FULL list of positions the agent wants after this run — the ones it keeps
 * and the ones it opens — each with the reason, in words a person can read in the journal.
 * Anything held and not in the list is closed. A position is never resized: kept is kept.
 *
 * Empty is not unknown: an agent whose data is missing (no readings, no candles) answers null —
 * "could not look" — and the runner leaves its positions alone rather than closing them all.
 */

const DAY = 864e5, HOUR = 3600e3

/** Percent return over the last `days` daily closes. Null when the history does not reach. */
export function retOver(daily, days) {
  const c = daily ?? []
  if (c.length < days + 1) return null
  const a = c[c.length - 1 - days].c, b = c[c.length - 1].c
  return a > 0 && b > 0 ? (b / a - 1) * 100 : null
}

/** The liquid markets: the top `n` by average daily notional over 30 days, with ≥ 60 days of history. */
export function liquidUniverse(daily, n = 25) {
  const rows = []
  for (const [coin, c] of Object.entries(daily ?? {})) {
    if (!c || c.length < 60) continue
    const last = c.slice(-30)
    const ntl = last.reduce((s, k) => s + (k.v || 0) * (k.c || 0), 0) / last.length
    if (ntl > 0) rows.push({ coin, ntl })
  }
  return rows.sort((a, b) => b.ntl - a.ntl).slice(0, n).map(r => r.coin)
}

const pct = (x, d = 1) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%'
const fr = (f) => (f * 100).toFixed(4) + '%/h'

/** Keep what still qualifies, then fill the free slots with the best new ones not cooling down. */
function fill(keep, fresh, max, ctx) {
  const out = [...keep].slice(0, max)
  const have = new Set(out.map(x => x.coin))
  for (const f of fresh) {
    if (out.length >= max) break
    if (have.has(f.coin) || (ctx.cool?.[f.coin] ?? 0) > ctx.now) continue
    out.push(f); have.add(f.coin)
  }
  return out
}

export const AGENTS = [
  {
    id: 'oracle', name: 'Oracle', color: '#4da3ff', lev: 2, max: 3, every: HOUR,
    blurb: ['Trades the Oracle\'s own 24-hour calls. Opens the 3 strongest (score 40 or more, long or short), stop at two of the call\'s expected moves, and closes when the call fades below 15 or flips.',
            'Opera las propias lecturas de 24 h del Oráculo. Abre las 3 más fuertes (puntuación 40 o más, largo o corto), stop a dos movimientos esperados, y cierra cuando la lectura baja de 15 o se invierte.'],
    decide(ctx) {
      const fresh = Object.entries(ctx.readings ?? {}).filter(([, r]) => r && Number.isFinite(r.score) && ctx.now - r.t < 6 * HOUR)
      if (!fresh.length) return null
      const R = Object.fromEntries(fresh)
      const keep = []
      for (const h of ctx.held ?? []) {
        const r = R[h.coin]
        if (!r) { keep.push({ coin: h.coin, side: h.side, why: 'no fresh call: kept' }); continue }   // unknown ≠ faded
        const s = h.side === 'long' ? r.score : -r.score
        if (s >= 15) keep.push({ coin: h.coin, side: h.side, why: `call still ${r.score > 0 ? '+' : ''}${r.score}` })
      }
      const cands = fresh.filter(([, r]) => Math.abs(r.score) >= 40).sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))
        .map(([coin, r]) => ({ coin, side: r.score > 0 ? 'long' : 'short', stopPct: Math.min(15, Math.max(3, 200 * (r.sigma || 0.03))), why: `Oracle 24h call ${r.score > 0 ? '+' : ''}${r.score}` }))
      return fill(keep, cands, this.max, ctx)
    },
  },
  {
    id: 'momentum', name: 'Momentum', color: '#a78bfa', lev: 2, max: 4, every: 24 * HOUR,
    blurb: ['Rides the strongest 30-day trends among the 25 most traded markets: long the 2 best (+10% or more), short the 2 worst (−10% or less). Re-checked daily; a position is kept while it stays in the top 5 of its side. 12% stop.',
            'Sigue las tendencias de 30 días más fuertes entre los 25 mercados más operados: largo en los 2 mejores (+10% o más), corto en los 2 peores (−10% o menos). Revisa a diario; mantiene mientras siga entre los 5 primeros de su lado. Stop 12%.'],
    decide(ctx) {
      const uni = liquidUniverse(ctx.daily)
      if (uni.length < 10) return null
      const rows = uni.map(coin => ({ coin, r: retOver(ctx.daily[coin], 30) })).filter(x => x.r != null).sort((a, b) => b.r - a.r)
      const top5 = new Set(rows.slice(0, 5).filter(x => x.r > 0).map(x => x.coin)), bot5 = new Set(rows.slice(-5).filter(x => x.r < 0).map(x => x.coin))
      const r30 = Object.fromEntries(rows.map(x => [x.coin, x.r]))
      const keep = (ctx.held ?? []).filter(h => (h.side === 'long' ? top5 : bot5).has(h.coin)).map(h => ({ coin: h.coin, side: h.side, why: `30d ${pct(r30[h.coin])}, still top 5` }))
      const longs = rows.filter(x => x.r >= 10).slice(0, 2).map(x => ({ coin: x.coin, side: 'long', stopPct: 12, why: `30d ${pct(x.r)}: among the strongest` }))
      const shorts = rows.filter(x => x.r <= -10).reverse().slice(0, 2).map(x => ({ coin: x.coin, side: 'short', stopPct: 12, why: `30d ${pct(x.r)}: among the weakest` }))
      return fill(keep, [...longs, ...shorts], this.max, ctx)
    },
  },
  {
    id: 'dip', name: 'Dip buyer', color: '#22d3ee', lev: 2, max: 3, every: 24 * HOUR,
    blurb: ['Buys the sharpest 7-day drops (−12% or worse) among the 25 most traded markets, betting on a bounce. Sells when the week turns positive or after 5 days. 12% stop.',
            'Compra las caídas de 7 días más fuertes (−12% o peor) entre los 25 mercados más operados, apostando a un rebote. Vende cuando la semana vuelve a positivo o a los 5 días. Stop 12%.'],
    decide(ctx) {
      const uni = liquidUniverse(ctx.daily)
      if (uni.length < 10) return null
      const keep = []
      for (const h of ctx.held ?? []) {
        const r = retOver(ctx.daily[h.coin], 7)
        const age = ctx.now - (h.openedAt ?? ctx.now)
        if (r == null) { keep.push({ coin: h.coin, side: h.side, why: 'no candles: kept' }); continue }
        if (r < 0 && age < 5 * DAY) keep.push({ coin: h.coin, side: h.side, why: `7d ${pct(r)}, day ${Math.floor(age / DAY) + 1} of 5` })
      }
      const cands = uni.map(coin => ({ coin, r: retOver(ctx.daily[coin], 7) })).filter(x => x.r != null && x.r <= -12).sort((a, b) => a.r - b.r)
        .map(x => ({ coin: x.coin, side: 'long', stopPct: 12, why: `7d ${pct(x.r)}: oversold` }))
      return fill(keep, cands, this.max, ctx)
    },
  },
  {
    id: 'funding', name: 'Funding fader', color: '#f472b6', lev: 2, max: 3, every: 4 * HOUR,
    blurb: ['Bets against the crowded side and collects the funding: shorts where longs pay 0.005%/h or more, longs where shorts pay 0.003%/h or more, among the 25 most traded markets. Kept while the crowd is still paying. 10% stop.',
            'Apuesta contra el lado saturado y cobra el funding: corto donde los largos pagan 0,005%/h o más, largo donde los cortos pagan 0,003%/h o más, entre los 25 mercados más operados. Mantiene mientras sigan pagando. Stop 10%.'],
    decide(ctx) {
      const uni = liquidUniverse(ctx.daily)
      const F = ctx.funding ?? {}
      if (uni.length < 10 || !Object.keys(F).length) return null
      const keep = []
      for (const h of ctx.held ?? []) {
        const f = F[h.coin]
        if (!Number.isFinite(f)) { keep.push({ coin: h.coin, side: h.side, why: 'no funding rate: kept' }); continue }
        if (h.side === 'short' ? f >= 0.00001 : f <= -0.00001) keep.push({ coin: h.coin, side: h.side, why: `funding ${fr(f)}, still paid` })
      }
      const cands = uni.filter(c => Number.isFinite(F[c])).map(c => ({ coin: c, f: F[c] }))
        .filter(x => x.f >= 0.00005 || x.f <= -0.00003).sort((a, b) => Math.abs(b.f) - Math.abs(a.f))
        .map(x => ({ coin: x.coin, side: x.f > 0 ? 'short' : 'long', stopPct: 10, why: `funding ${fr(x.f)}: ${x.f > 0 ? 'longs' : 'shorts'} crowded` }))
      return fill(keep, cands, this.max, ctx)
    },
  },
  {
    id: 'hodl', name: 'HODL BTC', color: '#94a3b8', lev: 1, max: 1, every: 24 * HOUR, baseline: true,
    blurb: ['The benchmark: bought BTC at 1× on day one and never sells. An agent that cannot beat this is not adding anything.',
            'La referencia: compró BTC a 1× el primer día y nunca vende. Un agente que no supera esto no aporta nada.'],
    decide(ctx) { return [{ coin: 'BTC', side: 'long', why: (ctx.held ?? []).length ? 'held since day one' : 'buy and hold' }] },
  },
]
export const AGENT_IDS = AGENTS.map(a => a.id)
export const agentById = (id) => AGENTS.find(a => a.id === id) ?? null

/**
 * What to do, from what is held and what is wanted: { close: [held], open: [wanted] }.
 * Null `wanted` (the agent could not look) does nothing at all.
 */
export function planOf(held, wanted) {
  if (!Array.isArray(wanted)) return { close: [], open: [] }
  const want = new Map(wanted.map(w => [w.coin, w]))
  const close = (held ?? []).filter(h => want.get(h.coin)?.side !== h.side)
  const keep = new Set((held ?? []).filter(h => !close.includes(h)).map(h => h.coin))
  const open = wanted.filter(w => !keep.has(w.coin))
  return { close, open }
}

/** Size for a new position: an equal share of equity × leverage, floored to the market's decimals. */
export function sizeFor(equity, lev, max, px, szDecimals = 4) {
  if (!(equity > 0) || !(px > 0)) return 0
  const f = 10 ** Math.max(0, szDecimals)
  return Math.floor((equity * lev / max) / px * f) / f
}

/** Largest peak-to-trough fall of an equity curve, in percent (0 when it only rose). */
export function maxDrawdown(curve) {
  let peak = -Infinity, dd = 0
  for (const [, v] of curve ?? []) { if (v > peak) peak = v; if (peak > 0) dd = Math.max(dd, (peak - v) / peak * 100) }
  return dd
}

/** At most n points, evenly picked, always keeping the last. */
export function thin(curve, n = 300) {
  const c = curve ?? []
  if (c.length <= n) return c
  const step = (c.length - 1) / (n - 1)
  return Array.from({ length: n }, (_, i) => c[Math.round(i * step)])
}

/** The value of a curve at time t: the last point at or before it (null before the curve begins). */
export function valueAt(curve, t) {
  let v = null
  for (const [x, y] of curve) { if (x > t) break; v = y }
  return v
}
