/**
 * Labs: strategies built on the spot out of signals, groups and rules, replayed over candles.
 *
 * Pure. A strategy and candles in, a result out -- no DOM, no fetching, no storage. labsview.js
 * is the screen; this is the arithmetic, and it is tested on its own (tests/suites/labs.test.mjs).
 *
 * THE MODEL, which is the whole point of the screen:
 *
 *   SIGNAL   one comparison, true or false on every candle: "RSI(14) below 30", "close crosses
 *            above EMA(200)", "volume above 2 x its 20-candle average". A left series, an
 *            operator, and a right side that is either a number or another series.
 *   GROUP    several signals (or other groups) made into one: ALL of them, ANY of them, or AT
 *            LEAST k. A member can be negated, and can count if it fired in the last N candles
 *            rather than only this one. Groups REFERENCE their members, never copy them: the
 *            same three signals can make one group and, paired differently, another.
 *   RULE     when a signal or group is true, do something: buy, sell, short, cover, close, or
 *            hold -- which does nothing and stops the rules under it from being read, so it
 *            works as a veto ("when volatility is extreme, hold").
 *
 * WHAT KEEPS IT HONEST, because a backtest that flatters itself is worse than none:
 *
 *   1. NO LOOKAHEAD. Rules are read on a candle's CLOSE and fill at the NEXT candle's open. A
 *      "highest high of 20" is the 20 candles BEFORE this one, so a breakout can actually break.
 *   2. UNKNOWN IS NOT FALSE. An indicator still warming up is null, and so is a group whose
 *      answer depends on it. Null never fires a rule -- and is counted apart from false.
 *   3. AMBIGUOUS CANDLES COUNT AGAINST YOU. When one candle reaches both the stop and the
 *      target, which came first is unknowable from OHLC; the stop is assumed.
 *   4. COSTS ARE CHARGED. A taker fee and slippage on every market fill, a maker fee on a target.
 *      No funding is charged, which the report says.
 */
import { rsiSeries, supertrendSeries } from './backtest.js'

// ── series ──────────────────────────────────────────────────────────────────────────────────
// Every source a signal can compare. `p` lists its parameters with their defaults; `kind` says
// what scale it lives on, which is what the screen uses to offer a sensible number beside it.
export const LAB_SOURCES = {
  close:   { en: 'Price (close)', es: 'Precio (cierre)', p: [], kind: 'price' },
  open:    { en: 'Open', es: 'Apertura', p: [], kind: 'price' },
  high:    { en: 'High', es: 'Máximo', p: [], kind: 'price' },
  low:     { en: 'Low', es: 'Mínimo', p: [], kind: 'price' },
  sma:     { en: 'SMA', es: 'SMA', p: [['n', 50]], kind: 'price' },
  ema:     { en: 'EMA', es: 'EMA', p: [['n', 21]], kind: 'price' },
  hh:      { en: 'Highest high (prior)', es: 'Máximo previo', p: [['n', 20]], kind: 'price' },
  ll:      { en: 'Lowest low (prior)', es: 'Mínimo previo', p: [['n', 20]], kind: 'price' },
  bbUp:    { en: 'Bollinger upper', es: 'Bollinger superior', p: [['n', 20], ['k', 2]], kind: 'price' },
  bbMid:   { en: 'Bollinger middle', es: 'Bollinger media', p: [['n', 20], ['k', 2]], kind: 'price' },
  bbLow:   { en: 'Bollinger lower', es: 'Bollinger inferior', p: [['n', 20], ['k', 2]], kind: 'price' },
  rsi:     { en: 'RSI', es: 'RSI', p: [['n', 14]], kind: 'osc', def: 30 },
  stoch:   { en: 'Stochastic %K', es: 'Estocástico %K', p: [['n', 14]], kind: 'osc', def: 20 },
  macd:    { en: 'MACD line', es: 'Línea MACD', p: [['f', 12], ['s', 26]], kind: 'macd', def: 0 },
  macdSig: { en: 'MACD signal', es: 'Señal MACD', p: [['f', 12], ['s', 26], ['g', 9]], kind: 'macd', def: 0 },
  macdHist:{ en: 'MACD histogram', es: 'Histograma MACD', p: [['f', 12], ['s', 26], ['g', 9]], kind: 'macd', def: 0 },
  change:  { en: 'Change % over', es: 'Cambio % en', p: [['n', 6]], kind: 'pct', def: 5 },
  atrPct:  { en: 'ATR % of price', es: 'ATR % del precio', p: [['n', 14]], kind: 'pct', def: 3 },
  volume:  { en: 'Volume', es: 'Volumen', p: [], kind: 'vol' },
  volAvg:  { en: 'Volume average', es: 'Volumen medio', p: [['n', 20]], kind: 'vol' },
  trend:   { en: 'Supertrend direction', es: 'Dirección Supertrend', p: [['n', 10], ['m', 3]], kind: 'dir', def: 0 },
  streak:  { en: 'Candle streak (+green / −red)', es: 'Racha de velas (+verdes / −rojas)', p: [], kind: 'count', def: 3 },
}
export const LAB_OPS = {
  gt:        { en: 'is above', es: 'está por encima de' },
  lt:        { en: 'is below', es: 'está por debajo de' },
  crossUp:   { en: 'crosses above', es: 'cruza por encima de' },
  crossDown: { en: 'crosses below', es: 'cruza por debajo de' },
  rising:    { en: 'is rising', es: 'está subiendo', unary: true },
  falling:   { en: 'is falling', es: 'está bajando', unary: true },
}
export const LAB_ACTIONS = {
  buy:   { en: 'Buy (go long)', es: 'Comprar (largo)' },
  sell:  { en: 'Sell (close long)', es: 'Vender (cerrar largo)' },
  short: { en: 'Short', es: 'Corto' },
  cover: { en: 'Cover (close short)', es: 'Cubrir (cerrar corto)' },
  close: { en: 'Close any position', es: 'Cerrar cualquier posición' },
  hold:  { en: 'Hold (skip rules below)', es: 'Mantener (ignorar reglas debajo)' },
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(num(v, d))))

/** Hyperliquid candles to rows, oldest first. Keeps volume, which the simulator's rows drop. */
export function labRows(candles) {
  const out = []
  for (const k of candles ?? []) {
    const t = Number(k.t ?? k.time), o = Number(k.o), h = Number(k.h), l = Number(k.l), c = Number(k.c), v = Number(k.v ?? 0)
    if (![t, o, h, l, c].every(Number.isFinite) || h < l) continue
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 })
  }
  out.sort((a, b) => a.t - b.t)
  // Hyperliquid can repeat the candle that is still forming at the end of a page.
  return out.filter((r, i) => i === 0 || r.t !== out[i - 1].t)
}

function smaOf(vals, n) {
  const out = new Array(vals.length).fill(null)
  let sum = 0, cnt = 0
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (v == null) { sum = 0; cnt = 0; continue }
    sum += v; cnt++
    if (cnt > n) { sum -= vals[i - n]; cnt = n }
    if (cnt === n) out[i] = sum / n
  }
  return out
}
function emaOf(vals, n) {
  const out = new Array(vals.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null, seen = 0, seed = 0
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (v == null) continue
    seen++
    // Seeded with the plain average of the first n values, as charting packages do, so an
    // EMA(200) means the same thing here as on the chart beside it.
    if (seen < n) { seed += v; continue }
    if (seen === n) { prev = (seed + v) / n; out[i] = prev; continue }
    prev = v * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}
function stdevOf(vals, n, mean) {
  const out = new Array(vals.length).fill(null)
  for (let i = n - 1; i < vals.length; i++) {
    if (mean[i] == null) continue
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += (vals[j] - mean[i]) ** 2
    out[i] = Math.sqrt(s / n)
  }
  return out
}

/** One source series over the rows. Memoised per run by the caller. */
export function sourceSeries(rows, src, p = {}) {
  const N = rows.length
  const c = rows.map(r => r.c)
  const n = clampInt(p.n, 1, 1000, LAB_SOURCES[src]?.p?.find(x => x[0] === 'n')?.[1] ?? 14)
  switch (src) {
    case 'close': return c
    case 'open': return rows.map(r => r.o)
    case 'high': return rows.map(r => r.h)
    case 'low': return rows.map(r => r.l)
    case 'volume': return rows.map(r => r.v)
    case 'sma': return smaOf(c, n)
    case 'ema': return emaOf(c, n)
    case 'volAvg': return smaOf(rows.map(r => r.v), n)
    case 'hh': case 'll': {
      const out = new Array(N).fill(null)
      for (let i = n; i < N; i++) {
        let x = src === 'hh' ? -Infinity : Infinity
        for (let j = i - n; j < i; j++) x = src === 'hh' ? Math.max(x, rows[j].h) : Math.min(x, rows[j].l)
        out[i] = x
      }
      return out
    }
    case 'bbUp': case 'bbMid': case 'bbLow': {
      const k = num(p.k, 2)
      const mid = smaOf(c, n)
      if (src === 'bbMid') return mid
      const sd = stdevOf(c, n, mid)
      return mid.map((m, i) => m == null || sd[i] == null ? null : m + (src === 'bbUp' ? k : -k) * sd[i])
    }
    case 'rsi': return rsiSeries(rows, n)
    case 'stoch': {
      const out = new Array(N).fill(null)
      for (let i = n - 1; i < N; i++) {
        let hi = -Infinity, lo = Infinity
        for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, rows[j].h); lo = Math.min(lo, rows[j].l) }
        out[i] = hi > lo ? (c[i] - lo) / (hi - lo) * 100 : 50
      }
      return out
    }
    case 'macd': case 'macdSig': case 'macdHist': {
      const f = clampInt(p.f, 1, 500, 12), s = clampInt(p.s, 1, 500, 26), g = clampInt(p.g, 1, 500, 9)
      const ef = emaOf(c, f), es = emaOf(c, s)
      const line = ef.map((v, i) => v == null || es[i] == null ? null : v - es[i])
      if (src === 'macd') return line
      const sig = emaOf(line, g)
      if (src === 'macdSig') return sig
      return line.map((v, i) => v == null || sig[i] == null ? null : v - sig[i])
    }
    case 'change': return c.map((v, i) => i >= n && c[i - n] > 0 ? (v / c[i - n] - 1) * 100 : null)
    case 'atrPct': {
      const out = new Array(N).fill(null)
      let atr = null, sum = 0
      for (let i = 0; i < N; i++) {
        const pc = i ? c[i - 1] : rows[i].o
        const tr = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - pc), Math.abs(rows[i].l - pc))
        if (i < n) { sum += tr; if (i === n - 1) atr = sum / n; else continue }
        else atr = (atr * (n - 1) + tr) / n
        out[i] = c[i] > 0 ? atr / c[i] * 100 : null
      }
      return out
    }
    case 'trend': return supertrendSeries(rows, n, num(p.m, 3))
    case 'streak': {
      const out = new Array(N).fill(0)
      for (let i = 0; i < N; i++) {
        const d = rows[i].c > rows[i].o ? 1 : rows[i].c < rows[i].o ? -1 : 0
        const prev = i ? out[i - 1] : 0
        out[i] = d === 0 ? 0 : (Math.sign(prev) === d ? prev + d : d)
      }
      return out
    }
    default: return new Array(N).fill(null)
  }
}

// ── evaluation ──────────────────────────────────────────────────────────────────────────────

/** A signal's truth on every candle: true, false, or null while its inputs are unknown. */
export function signalSeries(rows, sig, cache = new Map()) {
  const get = (src, p) => {
    const key = src + JSON.stringify(p ?? {})
    if (!cache.has(key)) cache.set(key, sourceSeries(rows, src, p))
    return cache.get(key)
  }
  const N = rows.length
  const L = get(sig.left?.src ?? 'close', sig.left?.p)
  const op = LAB_OPS[sig.op] ? sig.op : 'gt'
  const mult = num(sig.right?.mult, 1)
  const R = LAB_OPS[op].unary ? null
    : sig.right?.type === 'src' ? get(sig.right.src ?? 'close', sig.right.p).map(v => v == null ? null : v * mult)
    : new Array(N).fill(num(sig.right?.value, 0))
  const raw = new Array(N).fill(null)
  for (let i = 0; i < N; i++) {
    const a = L[i]
    if (a == null) continue
    if (op === 'rising' || op === 'falling') {
      const p = i ? L[i - 1] : null
      if (p == null) continue
      raw[i] = op === 'rising' ? a > p : a < p
      continue
    }
    const b = R[i]
    if (b == null) continue
    if (op === 'gt') raw[i] = a > b
    else if (op === 'lt') raw[i] = a < b
    else {
      // A cross needs the candle before as well: unknown there is unknown here.
      const pa = i ? L[i - 1] : null, pb = i ? R[i - 1] : null
      if (pa == null || pb == null) continue
      raw[i] = op === 'crossUp' ? (pa <= pb && a > b) : (pa >= pb && a < b)
    }
  }
  // "For N candles in a row": true only once it has held that long.
  const need = clampInt(sig.bars, 1, 500, 1)
  if (need === 1) return raw
  const out = new Array(N).fill(null)
  let run = 0
  for (let i = 0; i < N; i++) {
    if (raw[i] == null) { run = 0; continue }
    run = raw[i] ? run + 1 : 0
    out[i] = run >= need ? true : (i + 1 >= need ? false : null)
  }
  return out
}

/** Did it fire anywhere in the last `w` candles? Unknown only if nothing in the window is known. */
function within(s, w) {
  if (w <= 1) return s
  const out = new Array(s.length).fill(null)
  let lastTrue = -Infinity
  for (let i = 0; i < s.length; i++) {
    if (s[i] === true) lastTrue = i
    if (i - lastTrue < w) out[i] = true
    else if (s[i] === false) out[i] = false
  }
  return out
}
const not = (s) => s.map(v => v == null ? null : !v)

/**
 * Every signal and group of a strategy evaluated over the rows: { [id]: series }.
 * A group that refers to itself, directly or through another, is unknown everywhere rather
 * than a hang -- the screen refuses to build one, but a saved strategy is untrusted input.
 */
export function evaluate(rows, strat) {
  const cache = new Map()
  const sigs = new Map((strat.signals ?? []).map(s => [s.id, s]))
  const groups = new Map((strat.groups ?? []).map(g => [g.id, g]))
  const done = {}
  const visiting = new Set()
  const N = rows.length
  const unknown = () => new Array(N).fill(null)
  // Every group on a loop is unknown as a whole -- not half-evaluated around the point the loop
  // was cut, which would make its answer depend on which group happened to be read first.
  const cyclic = new Set([...groups.keys()].filter(id => (groups.get(id).members ?? []).some(m => groups.has(m.ref) && makesCycle(strat, id, m.ref))))
  const of = (id) => {
    if (done[id]) return done[id]
    if (sigs.has(id)) return (done[id] = signalSeries(rows, sigs.get(id), cache))
    const g = groups.get(id)
    if (cyclic.has(id)) return (done[id] = unknown())
    if (!g || visiting.has(id)) return unknown()
    visiting.add(id)
    const mem = (g.members ?? []).filter(m => sigs.has(m.ref) || groups.has(m.ref))
      .map(m => { const s = within(of(m.ref), clampInt(g.within, 1, 500, 1)); return m.not ? not(s) : s })
    visiting.delete(id)
    const mode = g.mode === 'any' ? 'any' : g.mode === 'atleast' ? 'atleast' : 'all'
    const k = mode === 'all' ? mem.length : mode === 'any' ? 1 : clampInt(g.k, 1, Math.max(1, mem.length), 2)
    const out = new Array(N).fill(null)
    if (mem.length) for (let i = 0; i < N; i++) {
      let t = 0, u = 0
      for (const s of mem) { if (s[i] === true) t++; else if (s[i] == null) u++ }
      out[i] = t >= k ? true : (t + u < k ? false : null)
    }
    return (done[id] = out)
  }
  for (const id of [...sigs.keys(), ...groups.keys()]) of(id)
  return done
}

/** Would adding `ref` to group `gid` make it contain itself? */
export function makesCycle(strat, gid, ref) {
  if (ref === gid) return true
  const groups = new Map((strat.groups ?? []).map(g => [g.id, g]))
  const seen = new Set()
  const walk = (id) => {
    if (id === gid) return true
    if (seen.has(id)) return false
    seen.add(id)
    return (groups.get(id)?.members ?? []).some(m => walk(m.ref))
  }
  return walk(ref)
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────
export const LAB_RISK_DEFAULTS = {
  balance: 1000,     // starting balance, USDC
  sizePct: 100,      // of the balance, as margin, per position
  leverage: 1,
  stopPct: 0,        // 0 = off; percent of entry price
  targetPct: 0,
  trailPct: 0,
  maxBars: 0,        // close after this many candles; 0 = never
  feeBps: 4.5,       // taker, Hyperliquid base tier
  makerBps: 1.5,     // a resting target
  slipBps: 1,        // on every market fill
  maxLev: 20,        // the market's ceiling: sets maintenance margin, so where you are liquidated
}
export function coerceRisk(r = {}) {
  const d = LAB_RISK_DEFAULTS
  return {
    balance: Math.max(10, num(r.balance, d.balance)),
    sizePct: Math.max(1, Math.min(100, num(r.sizePct, d.sizePct))),
    leverage: Math.max(1, Math.min(50, num(r.leverage, d.leverage))),
    stopPct: Math.max(0, Math.min(99, num(r.stopPct, d.stopPct))),
    targetPct: Math.max(0, Math.min(10000, num(r.targetPct, d.targetPct))),
    trailPct: Math.max(0, Math.min(99, num(r.trailPct, d.trailPct))),
    maxBars: clampInt(r.maxBars, 0, 100000, d.maxBars),
    feeBps: Math.max(0, Math.min(100, num(r.feeBps, d.feeBps))),
    makerBps: Math.max(-10, Math.min(100, num(r.makerBps, d.makerBps))),
    slipBps: Math.max(0, Math.min(500, num(r.slipBps, d.slipBps))),
    maxLev: Math.max(1, num(r.maxLev, d.maxLev)),
  }
}

/**
 * Replay a strategy over the rows.
 * → { startBalance, balance, roe, from, to, candles, curve [[t, equity]], trades, maxDrawdown,
 *     fires { id: { on, off, unknown } }, actions, notes }
 * `balance` is EQUITY at the end: a position still open is marked to the last close, and is
 * listed as an open trade so the closed-trade statistics do not count it.
 */
export function runLab(rows, strat, riskIn = {}) {
  const risk = coerceRisk({ ...strat.risk, ...riskIn })
  const series = evaluate(rows, strat)
  const N = rows.length
  const rules = (strat.rules ?? []).filter(r => series[r.ref] && LAB_ACTIONS[r.action])
  const fee = risk.feeBps / 1e4, mfee = risk.makerBps / 1e4, slip = risk.slipBps / 1e4
  const mm = 1 / (2 * risk.maxLev)
  const lev = Math.min(risk.leverage, risk.maxLev)

  let cash = risk.balance
  let pos = null      // { side: 1|-1, entry, q, margin, i, peak, trough, liq, why }
  const trades = []
  const curve = []
  let peakEq = cash, maxDD = 0
  const actions = { buy: 0, sell: 0, short: 0, cover: 0, close: 0, hold: 0 }
  let refused = 0

  const close = (i, px, why, kind = 'taker') => {
    const r = kind === 'maker' ? mfee : fee
    const pnl = pos.side * (px - pos.entry) * pos.q - px * pos.q * r
    const delta = why === 'liquidated' ? -pos.margin - pos.openFee : pnl - pos.openFee
    cash += why === 'liquidated' ? -pos.margin : pnl
    trades.push({
      side: pos.side > 0 ? 'long' : 'short', entry: pos.entry, exit: px, time: rows[pos.i].t, exitAt: rows[i].t,
      i: pos.i, j: i, heldFor: i - pos.i + 1, delta, balance: cash, outcome: why, liq: why === 'liquidated',
      retPct: pos.side * (px / pos.entry - 1) * 100 * lev, why: pos.why,
    })
    pos = null
  }
  const open = (i, side, why) => {
    // Filled at this candle's open, which is the first price after the close the rule read.
    const px = rows[i].o * (1 + side * slip)
    const margin = cash * risk.sizePct / 100
    const notional = margin * lev
    if (!(margin > 0) || notional < 10) { refused++; return }
    const q = notional / px
    const openFee = notional * fee
    cash -= openFee
    // Isolated: the margin posted is all that backs it.
    const liq = side > 0 ? px * (1 - 1 / lev + mm) : px * (1 + 1 / lev - mm)
    pos = { side, entry: px, q, margin, openFee, i, peak: px, trough: px, liq: liq > 0 ? liq : null, why }
  }

  let pending = null   // decisions read on candle i-1's close, filled at candle i's open
  const firstUsable = 1
  for (let i = 0; i < N; i++) {
    const r = rows[i]
    // 1. what the last close decided, at this open
    if (pending) {
      for (const a of pending) {
        if (a.do === 'exit' && pos && (a.side == null || pos.side === a.side)) close(i, r.o * (1 - pos.side * slip), 'rule:' + a.why)
        else if (a.do === 'enter' && !pos) open(i, a.side, a.why)
      }
      pending = null
    }
    // 2. stops, targets and liquidation inside this candle, worst case first
    if (pos) {
      const s = pos.side
      const stop = risk.stopPct > 0 ? pos.entry * (1 - s * risk.stopPct / 100) : null
      const trail = risk.trailPct > 0 ? (s > 0 ? pos.peak * (1 - risk.trailPct / 100) : pos.trough * (1 + risk.trailPct / 100)) : null
      const target = risk.targetPct > 0 ? pos.entry * (1 + s * risk.targetPct / 100) : null
      // The tightest protective level is the one that would be hit first.
      const prot = [[stop, 'stop'], [trail, 'trailing stop'], [pos.liq, 'liquidated']].filter(x => x[0] != null)
        .sort((a, b) => s > 0 ? b[0] - a[0] : a[0] - b[0])
      const hitProt = prot.find(([lvl]) => s > 0 ? r.l <= lvl : r.h >= lvl)
      const hitTarget = target != null && (s > 0 ? r.h >= target : r.l <= target)
      if (hitProt) {
        const [lvl, why] = hitProt
        // A candle that opens beyond the level fills at the open, not at the level.
        const gap = s > 0 ? r.o < lvl : r.o > lvl
        close(i, why === 'liquidated' ? lvl : (gap ? r.o : lvl) * (1 - s * slip), why)
      } else if (hitTarget) {
        const gap = s > 0 ? r.o > target : r.o < target
        close(i, gap ? r.o : target, 'target', 'maker')
      } else if (risk.maxBars > 0 && i - pos.i + 1 >= risk.maxBars) {
        close(i, r.c * (1 - s * slip), 'time limit')
      }
      if (pos) { pos.peak = Math.max(pos.peak, r.h); pos.trough = Math.min(pos.trough, r.l) }
    }
    // 3. the rules, on this close, for the next open
    if (i >= firstUsable && i < N - 1) {
      let side = pos?.side ?? 0          // what the position will be after the decisions so far
      const out = []
      for (const rule of rules) {
        if (series[rule.ref][i] !== true) continue
        const a = rule.action, why = rule.ref
        if (a === 'hold') { actions.hold++; break }
        if (a === 'buy' || a === 'short') {
          const want = a === 'buy' ? 1 : -1
          if (side === want) continue
          if (side !== 0) out.push({ do: 'exit', side, why })
          out.push({ do: 'enter', side: want, why })
          side = want; actions[a]++
        } else {
          const want = a === 'sell' ? 1 : a === 'cover' ? -1 : null
          if (side === 0 || (want != null && side !== want)) continue
          out.push({ do: 'exit', side, why }); side = 0; actions[a]++
        }
      }
      if (out.length) pending = out
    }
    // 4. marked to this close
    const eq = cash + (pos ? pos.side * (r.c - pos.entry) * pos.q : 0)
    curve.push([r.t, eq])
    if (eq > peakEq) peakEq = eq
    if (peakEq > 0) maxDD = Math.max(maxDD, (peakEq - eq) / peakEq * 100)
  }
  let balance = cash
  if (pos && N) {
    const last = rows[N - 1]
    const unreal = pos.side * (last.c - pos.entry) * pos.q
    balance = cash + unreal
    trades.push({
      side: pos.side > 0 ? 'long' : 'short', entry: pos.entry, exit: last.c, time: rows[pos.i].t, exitAt: last.t,
      i: pos.i, j: N - 1, heldFor: N - pos.i, delta: unreal - pos.openFee, balance, outcome: 'open', liq: false,
      retPct: pos.side * (last.c / pos.entry - 1) * 100 * lev, why: pos.why,
    })
  }
  const fires = {}
  for (const [id, s] of Object.entries(series)) {
    let on = 0, off = 0, unknown = 0
    for (const v of s) v === true ? on++ : v === false ? off++ : unknown++
    fires[id] = { on, off, unknown, now: s.length ? s[s.length - 1] : null }
  }
  return {
    startBalance: risk.balance, balance, roe: (balance / risk.balance - 1) * 100,
    from: rows[0]?.t ?? null, to: rows[N - 1]?.t ?? null, candles: N,
    curve, trades, maxDrawdown: maxDD, fires, actions, refused, risk, series,
  }
}

/** Human formula for a group: "A AND B AND NOT C", "2 of (A, B, C)". */
export function groupFormula(strat, g, label = (id) => id) {
  const mem = (g.members ?? []).map(m => (m.not ? 'NOT ' : '') + label(m.ref))
  if (!mem.length) return '—'
  const w = clampInt(g.within, 1, 500, 1)
  const tail = w > 1 ? ` · within ${w}` : ''
  if (g.mode === 'any') return mem.join(' OR ') + tail
  if (g.mode === 'atleast') return `${clampInt(g.k, 1, mem.length, 2)} of (${mem.join(', ')})` + tail
  return mem.join(' AND ') + tail
}

// ── starting points ─────────────────────────────────────────────────────────────────────────
const S = (id, name, left, op, right, bars = 1) => ({ id, name, left, op, right, bars })
const V = (value) => ({ type: 'value', value })
const R = (src, p = {}, mult = 1) => ({ type: 'src', src, p, mult })

/** Ready-made signals the screen offers in "Add signal". */
export const LAB_PRESETS = [
  { en: 'RSI oversold', es: 'RSI sobrevendido', make: () => ({ name: 'RSI oversold', left: { src: 'rsi', p: { n: 14 } }, op: 'lt', right: V(30) }) },
  { en: 'RSI overbought', es: 'RSI sobrecomprado', make: () => ({ name: 'RSI overbought', left: { src: 'rsi', p: { n: 14 } }, op: 'gt', right: V(70) }) },
  { en: 'Above EMA 200 (uptrend)', es: 'Sobre EMA 200 (alcista)', make: () => ({ name: 'Uptrend', left: { src: 'close' }, op: 'gt', right: R('ema', { n: 200 }) }) },
  { en: 'Golden cross (EMA 9 / 21)', es: 'Cruce dorado (EMA 9 / 21)', make: () => ({ name: 'EMA cross up', left: { src: 'ema', p: { n: 9 } }, op: 'crossUp', right: R('ema', { n: 21 }) }) },
  { en: 'Death cross (EMA 9 / 21)', es: 'Cruce de la muerte (EMA 9 / 21)', make: () => ({ name: 'EMA cross down', left: { src: 'ema', p: { n: 9 } }, op: 'crossDown', right: R('ema', { n: 21 }) }) },
  { en: 'MACD crosses up', es: 'MACD cruza al alza', make: () => ({ name: 'MACD up', left: { src: 'macd', p: { f: 12, s: 26 } }, op: 'crossUp', right: R('macdSig', { f: 12, s: 26, g: 9 }) }) },
  { en: 'Breakout (20-candle high)', es: 'Ruptura (máximo de 20)', make: () => ({ name: 'Breakout', left: { src: 'close' }, op: 'gt', right: R('hh', { n: 20 }) }) },
  { en: 'Breakdown (20-candle low)', es: 'Ruptura bajista (mínimo de 20)', make: () => ({ name: 'Breakdown', left: { src: 'close' }, op: 'lt', right: R('ll', { n: 20 }) }) },
  { en: 'Volume spike (2× average)', es: 'Pico de volumen (2× media)', make: () => ({ name: 'Volume spike', left: { src: 'volume' }, op: 'gt', right: R('volAvg', { n: 20 }, 2) }) },
  { en: 'Below lower Bollinger', es: 'Bajo Bollinger inferior', make: () => ({ name: 'Below band', left: { src: 'close' }, op: 'lt', right: R('bbLow', { n: 20, k: 2 }) }) },
  { en: 'Supertrend turns up', es: 'Supertrend gira al alza', make: () => ({ name: 'Supertrend up', left: { src: 'trend', p: { n: 10, m: 3 } }, op: 'crossUp', right: V(0) }) },
  { en: 'Big drop (−5% in 6 candles)', es: 'Caída fuerte (−5% en 6 velas)', make: () => ({ name: 'Big drop', left: { src: 'change', p: { n: 6 } }, op: 'lt', right: V(-5) }) },
  { en: 'High volatility (ATR > 4%)', es: 'Volatilidad alta (ATR > 4%)', make: () => ({ name: 'Volatile', left: { src: 'atrPct', p: { n: 14 } }, op: 'gt', right: V(4) }) },
  { en: '3 red candles in a row', es: '3 velas rojas seguidas', make: () => ({ name: 'Red streak', left: { src: 'streak' }, op: 'lt', right: V(-2.5) }) },
]

/** Whole strategies to start from, each showing a different part of the model. */
export const LAB_TEMPLATES = [
  {
    key: 'dip', en: 'Dip buyer in an uptrend', es: 'Comprar caídas en tendencia alcista',
    make: () => ({
      name: 'Dip buyer',
      signals: [
        S('s1', 'RSI oversold', { src: 'rsi', p: { n: 14 } }, 'lt', V(30)),
        S('s2', 'Uptrend', { src: 'close' }, 'gt', R('ema', { n: 200 })),
        S('s3', 'RSI recovered', { src: 'rsi', p: { n: 14 } }, 'gt', V(65)),
      ],
      groups: [{ id: 'g1', name: 'Dip in uptrend', mode: 'all', within: 1, members: [{ ref: 's1' }, { ref: 's2' }] }],
      rules: [{ ref: 'g1', action: 'buy' }, { ref: 's3', action: 'sell' }],
      risk: { stopPct: 6, sizePct: 100, leverage: 1 },
    }),
  },
  {
    key: 'trend', en: 'Trend follower (long and short)', es: 'Seguidor de tendencia (largo y corto)',
    make: () => ({
      name: 'Trend follower',
      signals: [
        S('s1', 'EMA cross up', { src: 'ema', p: { n: 9 } }, 'crossUp', R('ema', { n: 21 })),
        S('s2', 'EMA cross down', { src: 'ema', p: { n: 9 } }, 'crossDown', R('ema', { n: 21 })),
      ],
      groups: [],
      rules: [{ ref: 's1', action: 'buy' }, { ref: 's2', action: 'short' }],
      risk: { stopPct: 4, leverage: 2, sizePct: 50 },
    }),
  },
  {
    key: 'breakout', en: 'Confirmed breakouts, both ways (shared signals)', es: 'Rupturas confirmadas, en ambos sentidos (señales compartidas)',
    make: () => ({
      name: 'Confirmed breakouts',
      signals: [
        S('s1', 'Breakout', { src: 'close' }, 'gt', R('hh', { n: 20 })),
        S('s2', 'Breakdown', { src: 'close' }, 'lt', R('ll', { n: 20 })),
        S('s3', 'Volume spike', { src: 'volume' }, 'gt', R('volAvg', { n: 20 }, 1.8)),
        S('s4', 'Uptrend', { src: 'close' }, 'gt', R('ema', { n: 100 })),
        S('s5', 'Too volatile', { src: 'atrPct', p: { n: 14 } }, 'gt', V(8)),
      ],
      // The same volume and trend signals feed both groups -- one negated.
      groups: [
        { id: 'g1', name: 'Confirmed breakout', mode: 'all', within: 2, members: [{ ref: 's1' }, { ref: 's3' }, { ref: 's4' }] },
        { id: 'g2', name: 'Confirmed breakdown', mode: 'all', within: 2, members: [{ ref: 's2' }, { ref: 's3' }, { ref: 's4', not: true }] },
      ],
      rules: [{ ref: 's5', action: 'hold' }, { ref: 'g1', action: 'buy' }, { ref: 'g2', action: 'short' }],
      risk: { trailPct: 5, sizePct: 50, leverage: 2 },
    }),
  },
  {
    key: 'blank', en: 'Blank', es: 'En blanco',
    make: () => ({ name: 'New strategy', signals: [], groups: [], rules: [], risk: {} }),
  },
]

/** A saved strategy read back from storage, made safe to run whatever it contains. */
export function coerceStrategy(raw = {}) {
  const ids = new Set()
  const okId = (x) => typeof x === 'string' && /^[a-z0-9_-]{1,24}$/i.test(x)
  const srcOf = (s) => (LAB_SOURCES[s?.src] ? { src: s.src, p: Object.fromEntries(Object.entries(s.p ?? {}).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) } : { src: 'close', p: {} })
  const signals = (Array.isArray(raw.signals) ? raw.signals : []).filter(s => okId(s?.id) && !ids.has(s.id) && ids.add(s.id)).map(s => ({
    id: s.id, name: String(s.name ?? 'Signal').slice(0, 40), left: srcOf(s.left), op: LAB_OPS[s.op] ? s.op : 'gt',
    right: s.right?.type === 'src' ? { type: 'src', ...srcOf(s.right), mult: num(s.right.mult, 1) } : { type: 'value', value: num(s.right?.value, 0) },
    bars: clampInt(s.bars, 1, 500, 1),
  }))
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).filter(g => okId(g?.id) && !ids.has(g.id) && ids.add(g.id)).map(g => ({
    id: g.id, name: String(g.name ?? 'Group').slice(0, 40), mode: ['all', 'any', 'atleast'].includes(g.mode) ? g.mode : 'all',
    k: clampInt(g.k, 1, 50, 2), within: clampInt(g.within, 1, 500, 1),
    members: (Array.isArray(g.members) ? g.members : []).filter(m => okId(m?.ref)).map(m => ({ ref: m.ref, not: !!m.not })),
  }))
  for (const g of groups) g.members = g.members.filter(m => ids.has(m.ref) && m.ref !== g.id)
  const rules = (Array.isArray(raw.rules) ? raw.rules : []).filter(r => ids.has(r?.ref) && LAB_ACTIONS[r?.action]).map(r => ({ ref: r.ref, action: r.action }))
  return {
    id: okId(raw.id) ? raw.id : 'x' + Math.random().toString(36).slice(2, 10),
    name: String(raw.name ?? 'Strategy').slice(0, 60), signals, groups, rules,
    risk: { ...coerceRisk(raw.risk), maxLev: undefined },
  }
}

/** The next free id with this prefix: s1, s2 … or g1, g2 … */
export function nextId(strat, prefix) {
  const used = new Set([...(strat.signals ?? []), ...(strat.groups ?? [])].map(x => x.id))
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n
}
