/**
 * Grid Ladder — backtest. The five bots together, each its own simulated account
 * (src/gridsim.js), each driven by the real runner (src/gridrunner.js), over one price path.
 *
 * What it charges: maker fees on every grid fill, taker on the start-up buy and any close,
 * and Hyperliquid's historical hourly funding on whatever each bot holds. What it watches for:
 * a bot whose equity falls below maintenance margin is LIQUIDATED — closed at that price and
 * done for the period — because a leveraged grid held through a crash is exactly how this
 * strategy loses money, and a backtest that skips it flatters the result.
 *
 * Candles become a path open → (low, high in the order the candle most likely took them) →
 * close, walked in steps of `stepPct` so the bot hears each level crossed and can place the
 * opposite order before the price comes back. Pure: candles and funding are handed in.
 */
import { createSimExchange } from './gridsim.js'
import { createRunner, memoryStore } from './gridrunner.js'
import { botCapital, inventoryOf, fitLadder, levelsOf, MIN_NOTIONAL } from './gridladder.js'

/**
 * The smallest dollars per level that still clears the $10 minimum at every level of this range
 * once the size is rounded DOWN to szDecimals — a range moved up can need slightly more than it
 * started with, because the rounding step is worth more at a higher price.
 */
export function minUsdPerLevel(cfg, szDecimals) {
  const f = 10 ** szDecimals
  let need = 0
  for (const px of levelsOf(+cfg.low, +cfg.high, +cfg.levels, szDecimals).slice(0, -1)) need = Math.max(need, (Math.ceil((MIN_NOTIONAL / px) * f) / f) * px)
  return need * 1.0001
}

export { fitLadder }

/** The price path a candle most likely took: a red candle went up first, a green one down first. */
export function candlePath(c, stepPct = 0.004) {
  const o = +c.o, h = +c.h, l = +c.l, cl = +c.c
  const pts = cl >= o ? [o, l, h, cl] : [o, h, l, cl]
  const out = [o]
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k]
    const n = Math.max(1, Math.ceil(Math.abs(b / a - 1) / stepPct))
    for (let j = 1; j <= n; j++) out.push(a + ((b - a) * j) / n)
  }
  return out
}

/** Funding rate in force at time t (the last one at or before it). */
function fundingAt(funding, t, idx) {
  while (idx.i + 1 < funding.length && funding[idx.i + 1].time <= t) idx.i++
  return funding[idx.i]?.time <= t ? +funding[idx.i].fundingRate : 0
}

/**
 * Run the ladder over `candles` ({t, o, h, l, c}, oldest first) with `funding`
 * ({time, fundingRate}, hourly). `bots` are ladder configs. Returns per-bot and total results.
 */
export async function backtestLadder({ candles, funding = [], bots, szDecimals = 2, maxLeverage = 10, cashMult = 1.25, stepPct = 0.004, feeRates = null, trail = false }) {
  if (!candles.length) throw new Error('no candles')
  const start = +candles[0].o, t0 = +candles[0].t
  const rigs = []
  let seq = 0
  // A runner for this rig's account. Re-centring gives the same account a new runner, as the
  // live bot would start a new run after its grid changed.
  async function attach(x, cfg) {
    let seed = 1000 + cfg.id + 97 * seq++
    const r = createRunner({ key: 'bt' + cfg.id, botId: cfg.id, cfg, ex: x.sim, store: memoryStore(), now: () => x.sim.time, rand: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) })
    x.offs = [x.sim.onFills(f => r.onFills(f)), x.sim.onOrderUpdates(u => r.onOrderUpdates(u))]
    x.r = r; x.cfg = cfg
    await r.start(); await r.idle()
  }
  for (const cfg of bots) {
    const cap = botCapital(cfg, szDecimals)
    const cash = (cap.notional / Math.max(1, cfg.leverage)) * cashMult
    const sim = createSimExchange({ szDecimals, maxLeverage, mid: start, cash, time: t0, ...(feeRates ? { makerFee: feeRates.maker, takerFee: feeRates.taker } : {}) })
    const x = { sim, cash, liquidated: null, done: { realized: 0, cycles: 0 } }
    await attach(x, cfg)
    rigs.push(x)
  }
  let recentres = 0
  const top = () => Math.max(...rigs.map(x => +x.cfg.high))
  const mid0 = () => (Math.min(...rigs.map(x => +x.cfg.low)) + top()) / 2
  const capital = rigs.reduce((s, x) => s + x.cash, 0)
  const curve = []
  let peak = -Infinity, maxDD = 0
  const fIdx = { i: 0 }
  let lastHour = Math.floor(t0 / 3_600_000)

  for (let k = 0; k < candles.length; k++) {
    const c = candles[k], t = +c.t
    const dt = (k + 1 < candles.length ? +candles[k + 1].t : t + (t - +candles[Math.max(0, k - 1)].t || 3_600_000)) - t
    const path = candlePath(c, stepPct)
    for (let j = 0; j < path.length; j++) {
      const p = +path[j].toFixed(6), now = t + Math.floor((dt * j) / path.length)
      // Funding once per hour on what each bot holds.
      const hour = Math.floor(now / 3_600_000)
      if (hour > lastHour) { const rate = fundingAt(funding, now, fIdx); for (const x of rigs) if (!x.liquidated) for (let h = lastHour; h < hour; h++) x.sim.applyFunding(rate); lastHour = hour }
      for (const x of rigs) {
        if (x.liquidated) continue
        x.sim.setMid(p, now)
        await x.r.tick(p); await x.r.idle()
        const eq = await x.sim.accountValue()
        const maint = Math.abs(x.sim.pos) * p / (2 * maxLeverage)
        if (x.sim.pos > 0 && eq <= maint) {
          await x.r.stop('close'); await x.r.idle()
          x.liquidated = { t: now, px: p }
        }
      }
    }
    // trail: the price has closed above the whole ladder and every bot has sold everything — it is
    // all cash, so the ladder moves up to centre on the price, keeping its shape. Without this a
    // ladder left behind by a rally never trades again. It never follows a fall (it holds there).
    if (trail && +c.c > top() && rigs.every(x => x.liquidated || (inventoryOf(x.r.state).sz < 1e-9 && Math.abs(x.sim.pos) < 1e-9))) {
      const k = +c.c / mid0(), r5 = (v) => +(v * k).toPrecision(5)
      for (const x of rigs) {
        if (x.liquidated) continue
        await x.r.stop('cancel'); await x.r.idle()
        x.done.realized += x.r.state.realized; x.done.cycles += x.r.state.cycles
        x.offs.forEach(o => o())
        const moved = { ...x.cfg, low: r5(+x.cfg.low), high: r5(+x.cfg.high) }
        moved.usd = Math.max(+x.cfg.usd, minUsdPerLevel(moved, szDecimals))
        await attach(x, moved)
      }
      recentres++
    }
    let eq = 0
    for (const x of rigs) eq += await x.sim.accountValue()
    curve.push({ t, eq, px: +c.c })
    peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0)
  }

  const end = +candles.at(-1).c
  const per = []
  for (const x of rigs) {
    const st = x.r.state, s = x.r.stats({ funding: x.sim.fundingPaid })
    const eq = await x.sim.accountValue()
    per.push({
      id: x.cfg.id, range: `${x.cfg.low}–${x.cfg.high}`, cash: x.cash, equity: eq, pnl: eq - x.cash,
      realized: st.realized + (st.lifetime?.realized ?? 0) + x.done.realized, cycles: st.cycles + (st.lifetime?.cycles ?? 0) + x.done.cycles,
      fees: x.sim.feesPaid, funding: x.sim.fundingPaid, inventory: inventoryOf(st).sz, unrealized: s.unrealized,
      liquidated: x.liquidated,
    })
  }
  const final = per.reduce((s, b) => s + b.equity, 0)
  return {
    from: t0, to: +candles.at(-1).t, startPx: start, endPx: end, capital, final,
    pnl: final - capital, ret: final / capital - 1, maxDrawdown: maxDD,
    // The same capital simply held in HYPE, unlevered, over the same period.
    hold: { pnl: capital * (end / start - 1), ret: end / start - 1 },
    realized: per.reduce((s, b) => s + b.realized, 0), cycles: per.reduce((s, b) => s + b.cycles, 0),
    fees: per.reduce((s, b) => s + b.fees, 0), funding: per.reduce((s, b) => s + b.funding, 0),
    liquidations: per.filter(b => b.liquidated).length, recentres,
    bots: per, curve,
  }
}

/**
 * Three regimes picked from the data, each a `days`-long window of candles: the strongest rise
 * (trending), the deepest peak-to-trough fall (crash), and the most range for the least net
 * move (choppy).
 */
export function pickRegimes(candles, days = 30) {
  if (!candles.length) return {}
  const span = +candles[1]?.t - +candles[0]?.t || 3_600_000
  const n = Math.max(2, Math.round((days * 86_400_000) / span))
  let trend = null, crash = null, chop = null
  for (let a = 0; a + n <= candles.length; a += Math.max(1, Math.floor(n / 10))) {
    const w = candles.slice(a, a + n)
    const ret = +w.at(-1).c / +w[0].o - 1
    let pk = -Infinity, dd = 0, hi = -Infinity, lo = Infinity
    for (const c of w) { pk = Math.max(pk, +c.h); dd = Math.max(dd, 1 - +c.l / pk); hi = Math.max(hi, +c.h); lo = Math.min(lo, +c.l) }
    const range = hi / lo - 1
    if (!trend || ret > trend.score) trend = { a, score: ret }
    if (!crash || dd > crash.score) crash = { a, score: dd }
    const chopScore = range > 0.15 ? range / (Math.abs(ret) + 0.02) : 0
    if (!chop || chopScore > chop.score) chop = { a, score: chopScore }
  }
  const win = (x) => x && { from: +candles[x.a].t, to: +candles[Math.min(candles.length - 1, x.a + n - 1)].t }
  return { trending: win(trend), choppy: win(chop), crash: win(crash) }
}
