/**
 * The Grid Ladder as a /portfolios trading strategy — "Grid ladder (bot)".
 *
 * Each holding gets its own ladder with its share of the capital: `bots` long-only grids,
 * stacked around the holding's first price in the window, exactly as the Grid Ladder panel's
 * "Centre on price" lays out the default $50–$110 ladder around $80 (five 25%-wide ranges, each
 * 12.5% above the last). The simulation is src/gridbacktest.js — the live bot's own engine and
 * runner against a simulated account — not a re-implementation, so the page tests what the
 * bot would trade: post-only rungs, reduce-only sells, a sell only after its level fully fills,
 * maker fees, hourly funding, and a bot LIQUIDATED if its equity falls under maintenance.
 *
 * Long-only: a holding the basket shorts sits in cash (counted as refused), unless "Trade both
 * directions" is on, when it gets a long ladder like the rest. A holding whose share is too
 * small for Hyperliquid's $10 minimum on every rung is refused too, and stays cash.
 */
import { backtestLadder } from './gridbacktest.js'
import { validateBot, DEFAULT_BOT } from './gridladder.js'
import { normalizeWeights, metrics, DAY } from './pfbacktest.js'
import { rateOn } from './pffunding.js'

export const LADDER_DEFAULTS = { ladderBots: 5, ladderWidthPct: 25, ladderStepPct: 12.5, ladderLevels: 10, ladderTrail: '1', ladderLiq: '1' }

/** The settings card for it on /portfolios. */
export const LADDER_FIELDS = [
  { key: 'ladderBots', label: 'Bots', step: '1', hint: 'How many grids are stacked, each with an equal share of the holding\'s capital.' },
  { key: 'ladderWidthPct', label: 'Each range', unit: '%', step: '0.5', hint: 'How wide each bot\'s range is, as a share of the first price.' },
  { key: 'ladderStepPct', label: 'Gap between ranges', unit: '%', step: '0.5', hint: 'How far each bot\'s range sits above the one below it. Half the width overlaps them, as in the default ladder.' },
  { key: 'ladderLevels', label: 'Levels per bot', step: '1', hint: 'Price levels in each bot\'s range; a bot trades one fewer pairs than this.' },
  { key: 'ladderTrail', label: 'Follow the price', type: 'select', options: [['1', 'Up, once sold out'], ['', 'Stay where it started']],
    hint: 'When the price rallies above the whole ladder and every bot has sold, move the ladder up to centre on the price. It never follows a fall — there it holds what it bought.' },
  { key: 'ladderLiq', label: 'Liquidations', type: 'select', options: [['1', 'On — then restart with what is left'], ['', 'Off — hold through any drop']],
    hint: 'On: a bot whose equity falls to maintenance margin is closed, as Hyperliquid would, then starts again around the price with what its account has left. Off: it never is — as if you keep its margin topped up from elsewhere, so a deep fall can cost more than its share.' },
]
export const LADDER_DESC = 'Several long-only grids stacked around the price, each in its own account — the Grid Ladder bots. ' +
  'Each buys at one level and sells one level up, post-only, and sells only after a level fully fills. ' +
  'Earns in a range, lags a strong rise (it sells on the way up), and holds a full bag in a fall — leveraged, a crash can liquidate a bot.'

/** The ladder for one holding: `n` ranges stacked around `px`. */
export function ladderAround(px, p = {}) {
  const n = Math.max(1, Math.min(10, Math.round(p.bots ?? p.ladderBots ?? LADDER_DEFAULTS.ladderBots)))
  const w = (p.ladderWidthPct ?? LADDER_DEFAULTS.ladderWidthPct) / 100
  const s = (p.ladderStepPct ?? LADDER_DEFAULTS.ladderStepPct) / 100
  const r5 = (v) => +v.toPrecision(5)
  return Array.from({ length: n }, (_, i) => {
    const c = 1 + (i - (n - 1) / 2) * s
    return { id: i + 1, low: r5(px * (c - w / 2)), high: r5(px * (c + w / 2)) }
  }).filter(b => b.low > 0 && b.high > b.low)
}

/**
 * Size decimals when the market's own are not known: Hyperliquid sets them so one size step is
 * worth roughly $0.1–$2 (BTC 5 at $100k, ETH 4, HYPE 2 at $50, DOGE 0) — about the digits of the
 * price. The old guess here went the other way and gave BTC a 1-BTC step, so no order could round
 * to $10 and every BTC ladder sat in cash.
 */
export const szDecOf = (px) => Math.max(0, Math.min(5, Math.ceil(Math.log10(Math.max(1e-9, px)))))

/**
 * Same shape as pfbacktest.js botRun: a daily equity curve summed over the holdings, fees,
 * funding and the per-holding PnL. `progress(k, n)` is called as each holding finishes.
 */
/**
 * One market's ladder with `bal` dollars: laid out around its first price, sized to Hyperliquid's
 * $10 minimum, run by the live bot's engine. Shared by /portfolios (per holding, below) and the
 * Trade Simulator (src/simladder.js). Returns null when `bal` cannot fund even one 3-level bot.
 *
 * A share too small for $10 on every level ADAPTS rather than sitting out: fewer BOTS first,
 * keeping each bot's levels as dense as asked — the gap between levels is what lets a grid
 * complete cycles, and it depends only on levels per bot. Only after a single bot cannot afford
 * them does it thin the levels (down to 3). Ranges stay in % of the price.
 */
export async function ladderOnOne({ rows, bal, lev = 1, params = {}, szDecimals = null, funding = [], feeRates = null, margin = 'isolated' }) {
  const px0 = +rows[0].o || +rows[0].c
  const szd = Number.isInteger(szDecimals) ? szDecimals : szDecOf(px0)
  const wantBots = Math.max(1, Math.min(10, Math.round(params.ladderBots ?? LADDER_DEFAULTS.ladderBots)))
  const wantLv = Math.max(2, Math.min(100, Math.round(params.ladderLevels ?? LADDER_DEFAULTS.ladderLevels)))
  let bots = null
  for (let lv = wantLv; lv >= Math.min(3, wantLv) && !bots; lv--) {
    for (let nb = wantBots; nb >= 1 && !bots; nb--) {
      // The ladder's full value is the share; leverage lowers the margin it ties up (and so how
      // far it can fall before an isolated liquidation) — as Grid (bot) is sized.
      const usd = (bal / nb) / (lv - 1)
      const set = ladderAround(px0, { ...params, bots: nb }).map(r => ({ ...DEFAULT_BOT, ...r, levels: lv, usd, leverage: lev, margin, killPrice: 0 }))
      if (set.every(b => !validateBot(b, { szDecimals: szd, maxLeverage: Math.max(lev, 50) }).length)) bots = set
    }
  }
  if (!bots) return null
  const r = await backtestLadder({
    candles: rows.map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c })), funding, bots,
    // Maintenance for the liquidation check: Hyperliquid's 1 / (2 × max leverage), taken at the
    // larger of the leverage used and 10× when the market's own maximum is not known.
    szDecimals: szd, maxLeverage: Math.max(lev, +params.maxLev || 10), cashMult: 1, stepPct: 0.006,
    trail: (params.ladderTrail ?? LADDER_DEFAULTS.ladderTrail) !== '',
    liquidate: (params.ladderLiq ?? LADDER_DEFAULTS.ladderLiq) !== '',
    sizing: 'notional', feeRates,
  })
  return { r, bots, adapted: bots.length < wantBots || bots[0].levels < wantLv }
}

export async function ladderRun(ohlc, items, days, opts = {}) {
  const { capital = 10_000, leverage = 1, feeBps = 4.5, both = false, funding = null, levBy = null, szBy = null, params = {}, progress = null } = opts
  const w = normalizeWeights(items)
  const start = days[0], end = days[days.length - 1] + DAY - 1
  const curves = [], pnlBy = {}
  let fees = 0, fundPaid = 0, cycles = 0, refused = 0, liqAt = null, k0 = 0, adapted = 0, recentres = 0
  const failed = []
  let tooSmall = 0, liqCount = 0
  const keys = Object.keys(w)
  for (const k of keys) {
    const bal = capital * Math.abs(w[k])
    const flat = days.map(() => bal)
    const rows = (ohlc[k] ?? []).filter(c => c.t >= start && c.t <= end)
    progress?.(++k0, keys.length)
    if ((w[k] < 0 && !both) || rows.length < 2 || !(bal > 0)) { if (w[k] < 0 && !both) refused++; curves.push(flat); pnlBy[k] = 0; continue }
    const lev = Math.max(1, levBy && levBy[k] > 0 ? levBy[k] : leverage)
    // The page's funding is a daily sum of the hourly rates; the ladder charges it by the hour.
    const hourly = []
    if (funding?.[k]) for (let d = start; d <= end; d += DAY) { const [rate] = rateOn(funding[k], d); if (rate) for (let h = 0; h < 24; h++) hourly.push({ time: d + h * 3_600_000, fundingRate: rate / 24 }) }
    let one
    try {
      one = await ladderOnOne({ rows, bal, lev, params, szDecimals: szBy?.[k], funding: hourly, feeRates: { maker: Math.min(feeBps, 1.5) / 1e4, taker: feeBps / 1e4 } })
    } catch (e) {
      // One holding's ladder failing must not take the whole run with it: it is counted as cash.
      failed.push(`${k}: ${e?.message ?? e}`); refused++; curves.push(flat); pnlBy[k] = 0; continue
    }
    if (!one) { refused++; tooSmall++; curves.push(flat); pnlBy[k] = 0; continue }
    if (one.adapted) adapted++
    const r = one.r
    const scale = r.capital > 0 ? bal / r.capital : 1
    let j = 0, v = bal
    const eq = days.map(d => {
      while (j < r.curve.length && r.curve[j].t <= d + DAY - 1) v = r.curve[j++].eq * scale
      return Math.max(0, v)
    })
    curves.push(eq)
    fees += r.fees * scale; fundPaid += r.funding * scale; cycles += r.cycles; recentres += r.recentres
    for (const b of r.bots) if (b.liquidated && (liqAt == null || b.liquidated.t < liqAt)) liqAt = b.liquidated.t
    liqCount += r.liquidations
    pnlBy[k] = eq.at(-1) - bal + r.fees * scale + r.funding * scale
  }
  const equity = days.map((_, i) => curves.reduce((a, c) => a + c[i], 0))
  return {
    // A cycle is one buy and its sell, always at a profit before costs, so a win rate would be
    // 100% and mean nothing: the Trades column says cycles instead. What a ladder still holds at
    // the end is marked to market in the curve, so nothing is "open and not counted".
    id: 'bot:gridladder', equity, fees, feesEstimated: false, trades: cycles, won: null, lost: null, open: 0, refused,
    rebalances: null, liquidated: liqAt, liqCount, pnlBy, cycles, adapted, tooSmall, recentres, failed,
    funding: funding ? fundPaid : null, slippage: null, fundDays: 0, fundEstDays: 0, ...metrics(equity, capital),
  }
}
