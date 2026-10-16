/**
 * The Grid Ladder in the Trade Simulator — "Grid Ladder (bot)".
 *
 * The Simulator's engine (src/backtest.js runBacktest) is synchronous and has its own grid; the
 * ladder is the live bot's engine (src/gridladder.js → gridrunner → gridsim, via
 * src/pfladder.js ladderOnOne), which is async. This turns one market's ladder run into the result
 * the Simulator already draws for a grid — the balance, the curve, the trade list, and the
 * `grid` block its summary reads — so every screen it has (results, replay, compare, sweep) works
 * on it unchanged.
 *
 * The books: each completed cycle and each forced close (a liquidation) is a trade, in dollars.
 * Everything else — what the bots still hold against what it cost, fees on inventory bought,
 * funding — is `grid.unrealized`, so the trades plus it are exactly the final balance, which is
 * what the Simulator's several-market view adds up (src/backtest.js runPortfolio).
 */
import { ladderOnOne } from './pfladder.js'

/** Thrown when the balance cannot fund even one 3-level bot at Hyperliquid's $10 minimum. */
export class LadderTooSmall extends Error {}

const atOrBefore = (rows, t) => { let lo = 0, hi = rows.length - 1, k = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].t <= t) { k = m; lo = m + 1 } else hi = m - 1 } return k }

export async function runLadderSim(rows, p) {
  const bal = +p.startBalance || 0
  const lev = Math.max(1, Math.min(+p.leverage || 1, +p.maxLev || 50))
  const feeRates = p.useFees === false ? { maker: 0, taker: 0 } : { maker: (+p.makerFeePct || 0) / 100, taker: (+p.takerFeePct || 0) / 100 }
  const one = await ladderOnOne({ rows, bal, lev, params: p, szDecimals: p.szDecimals, feeRates, margin: p.marginMode === 'cross' ? 'cross' : 'isolated' })
  if (!one) throw new LadderTooSmall(`$${bal.toFixed(0)} cannot fund even one 3-level grid at Hyperliquid's $10 minimum`)
  const { r, bots } = one
  const k = r.capital > 0 ? bal / r.capital : 1
  const last = +rows.at(-1).c

  let balance = bal
  const trades = r.trades.map(t => {
    const delta = t.delta * k, before = balance
    balance += delta
    const i0 = atOrBefore(rows, t.time), i1 = atOrBefore(rows, t.exitAt)
    return {
      i: i1, bot: t.bot, time: t.time, side: 'long', entry: t.entry, tp: t.kind === 'cycle' ? t.exitPx : null, sl: null,
      outcome: t.kind === 'cycle' ? 'win' : 'loss', exitAt: t.exitAt, exitPx: t.exitPx, heldFor: i1 - i0,
      balance, delta, q: t.q * k, liq: t.kind === 'liquidation', liqPx: t.kind === 'liquidation' ? t.exitPx : undefined,
      sized: true, ret: before > 0 ? delta / before : 0,
    }
  })
  const final = r.final * k
  const lower = Math.min(...bots.map(b => +b.low)), upper = Math.max(...bots.map(b => +b.high))
  const invSz = r.bots.reduce((a, b) => a + b.inventory, 0) * k
  const invUnreal = r.bots.reduce((a, b) => a + b.unrealized, 0) * k
  const curve = r.curve.map(c => [c.t, c.eq * k])
  const peak = Math.max(bal, ...curve.map(c => c[1]))
  const net = final - bal
  const cycles = trades.filter(t => !t.liq)
  return {
    params: p, candles: rows.length, from: rows[0]?.t ?? null, to: rows.at(-1)?.t ?? null,
    trades, tradesMade: trades.length, won: cycles.length, lost: trades.length - cycles.length,
    unresolved: r.bots.filter(b => b.inventory > 0).length, timedOut: 0, halted: false, refused: 0,
    // Every completed cycle profits by construction, so a win rate would read 100% and mean nothing.
    winRate: null,
    startBalance: bal, balance: final, netPnl: net, roe: bal > 0 ? (net / bal) * 100 : null,
    peak, maxDrawdown: r.maxDrawdown * 100,
    avgPerTrade: trades.length ? net / trades.length : 0,
    avgHeld: cycles.length ? cycles.reduce((a, t) => a + t.heldFor, 0) / cycles.length : 0,
    signalsSeen: cycles.length,
    grid: {
      ladder: true, bots: bots.length, levelsPerBot: bots[0].levels,
      lower, upper, levels: bots.reduce((a, b) => a + b.levels, 0), prices: [],
      cycles: cycles.length, buys: cycles.length, sells: cycles.length,
      realized: cycles.reduce((a, t) => a + t.delta, 0), fees: r.fees * k,
      // Everything not in a closed trade, so trades + this = the final balance exactly.
      unrealized: final - balance,
      inventorySize: invSz, inventoryCost: invSz * last - invUnreal, inventoryValue: invSz * last,
      maxInventory: null, maxNotional: null, maxMargin: r.maxMargin * k,
      refused: 0, liquidations: r.liquidations, closestLiq: r.closestLiq, liqNow: null, lev,
      inRangePct: rows.length ? (rows.filter(c => +c.h >= lower && +c.l <= upper).length / rows.length) * 100 : null,
      openSlots: r.bots.filter(b => b.inventory > 0).length, recentres: r.recentres,
    },
    curve,
  }
}
