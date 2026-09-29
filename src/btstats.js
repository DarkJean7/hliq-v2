/**
 * Backtest statistics: what a run's trades say once they are added up properly.
 *
 * Pure. A result from backtest.js in, numbers out -- no DOM, no fetching. Kept apart from
 * the engine because none of this changes what a strategy DID; it only reads it, and a
 * reading that can be tested on its own is one that can be trusted on its own.
 *
 * Two rules that run through all of it:
 *
 *   UNKNOWN IS NULL. A profit factor with no losing trade, a Sharpe ratio over three days, an
 *     annual growth rate extrapolated from a week -- each would be a number, and each would
 *     be believed. They come back null and the view prints a dash.
 *   THE CURVE IS THE BALANCE. Grid and DCA runs carry a curve marked to every close, because
 *     their losing lives in inventory that never closes. Everything else steps at the trades
 *     that closed, which is the only moment its balance changed.
 */

const DAY = 86400e3

/** Keep at most `max` points, always including the first, the last, and every extreme. */
export function downsample(pts, max = 400) {
  if (!Array.isArray(pts) || pts.length <= max) return pts ?? []
  const out = [pts[0]]
  const bucket = (pts.length - 2) / (max - 2)
  for (let b = 0; b < max - 2; b++) {
    const a = 1 + Math.floor(b * bucket), z = Math.min(pts.length - 1, 1 + Math.floor((b + 1) * bucket))
    // The low of each bucket, not its average: a drawdown smoothed away is a drawdown hidden.
    let lo = a
    for (let k = a; k < z; k++) if (pts[k][1] < pts[lo][1]) lo = k
    out.push(pts[lo])
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * [[t, balance]] from the start of the run to its end.
 *
 * Starts at the starting balance on the first candle and ends on the last one, so two runs
 * over the same window share an x-axis however many trades each took.
 */
export function equityCurve(r) {
  if (!r) return []
  if (Array.isArray(r.curve) && r.curve.length) {
    return [[r.from ?? r.curve[0][0], r.startBalance], ...r.curve]
  }
  const pts = [[r.from ?? 0, r.startBalance]]
  const closed = (r.trades ?? []).filter(t => t.outcome !== 'open' && Number.isFinite(t.balance))
  for (const t of closed) pts.push([t.exitAt ?? t.time, t.balance])
  pts.sort((a, b) => a[0] - b[0])
  // Ends at the BALANCE, not the last closed trade: a portfolio of grids or DCA deals carries
  // the inventory it is still holding, and a curve that stopped before it ended green on a run
  // that lost money.
  if (r.to != null) pts.push([Math.max(r.to, pts[pts.length - 1][0]), Number.isFinite(r.balance) ? r.balance : pts[pts.length - 1][1]])
  return pts
}

/** Percent below the running peak at each point. */
export function drawdownCurve(curve) {
  let peak = -Infinity
  return (curve ?? []).map(([t, v]) => {
    if (v > peak) peak = v
    return [t, peak > 0 ? (v - peak) / peak * 100 : 0]
  })
}

/** Balance at the end of each UTC day the curve covers, carried forward over quiet days. */
export function dailyBalances(curve) {
  if (!curve?.length) return []
  const out = []
  let k = 0, last = curve[0][1]
  const d0 = Math.floor(curve[0][0] / DAY), d1 = Math.floor(curve[curve.length - 1][0] / DAY)
  for (let d = d0; d <= d1; d++) {
    const end = (d + 1) * DAY
    while (k < curve.length && curve[k][0] < end) { last = curve[k][1]; k++ }
    out.push([d * DAY, last])
  }
  return out
}

/**
 * Risk-adjusted numbers from the daily balance.
 *
 * Annualised over 365 days, not 252 -- crypto does not close at the weekend. Nothing is
 * annualised from less than a month of data: a +4% week is not a +600% year, and printing
 * it as one is exactly the kind of number that gets believed.
 */
export function riskStats(curve) {
  const days = dailyBalances(curve)
  const rets = []
  for (let i = 1; i < days.length; i++) {
    const a = days[i - 1][1]
    if (a > 0) rets.push(days[i][1] / a - 1)
  }
  const spanDays = curve?.length ? (curve[curve.length - 1][0] - curve[0][0]) / DAY : 0
  const start = curve?.[0]?.[1], end = curve?.[curve.length - 1]?.[1]
  const mean = rets.length ? rets.reduce((a, v) => a + v, 0) / rets.length : null
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, v) => a + (v - mean) ** 2, 0) / (rets.length - 1)) : null
  const down = rets.filter(v => v < 0)
  const dsd = rets.length > 1 ? Math.sqrt(down.reduce((a, v) => a + v * v, 0) / rets.length) : null
  const enough = rets.length >= 14
  let maxDD = 0
  for (const [, d] of drawdownCurve(curve)) if (-d > maxDD) maxDD = -d
  const cagr = spanDays >= 30 && start > 0 && end > 0 ? (Math.pow(end / start, 365 / spanDays) - 1) * 100 : null
  return {
    spanDays,
    sharpe: enough && sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
    sortino: enough && dsd > 0 ? (mean / dsd) * Math.sqrt(365) : null,
    volatility: enough && sd != null ? sd * Math.sqrt(365) * 100 : null,
    cagr,
    maxDD,
    calmar: cagr != null && maxDD > 0 ? cagr / maxDD : null,
    bestDay: rets.length ? Math.max(...rets) * 100 : null,
    worstDay: rets.length ? Math.min(...rets) * 100 : null,
  }
}

/**
 * Per-trade numbers. Scored on what each trade did to the balance (`delta`), so a win is
 * whatever made money -- including a timeout that ended above entry -- rather than a label.
 */
export function tradeStats(r) {
  const closed = (r?.trades ?? []).filter(t => t.outcome !== 'open' && Number.isFinite(t.delta))
  const wins = closed.filter(t => t.delta > 0), losses = closed.filter(t => t.delta < 0)
  const gw = wins.reduce((a, t) => a + t.delta, 0)
  const gl = losses.reduce((a, t) => a + t.delta, 0)
  let cw = 0, cl = 0, mcw = 0, mcl = 0
  for (const t of closed) {
    if (t.delta > 0) { cw++; cl = 0 } else if (t.delta < 0) { cl++; cw = 0 } else { cw = 0; cl = 0 }
    if (cw > mcw) mcw = cw
    if (cl > mcl) mcl = cl
  }
  const side = (s) => {
    const x = closed.filter(t => t.side === s)
    return { n: x.length, net: x.reduce((a, t) => a + t.delta, 0),
      winRate: x.length ? x.filter(t => t.delta > 0).length / x.length * 100 : null }
  }
  const avgWin = wins.length ? gw / wins.length : null
  const avgLoss = losses.length ? gl / losses.length : null
  return {
    closed: closed.length,
    grossWin: gw, grossLoss: gl,
    // No losing trade: the ratio is unbounded, and "infinite" is not a number to rank by.
    profitFactor: gl < 0 ? gw / -gl : null,
    expectancy: closed.length ? (gw + gl) / closed.length : null,
    avgWin, avgLoss,
    payoff: avgWin != null && avgLoss != null && avgLoss < 0 ? avgWin / -avgLoss : null,
    largestWin: wins.length ? Math.max(...wins.map(t => t.delta)) : null,
    largestLoss: losses.length ? Math.min(...losses.map(t => t.delta)) : null,
    maxConsecWins: mcw, maxConsecLosses: mcl,
    liquidations: closed.filter(t => t.liq).length,
    long: side('long'), short: side('short'),
  }
}

/** Share of the candles a position was open for. A strategy always in the market is ~100%. */
export function exposurePct(r) {
  if (!r?.candles) return null
  const held = (r.trades ?? []).reduce((a, t) => a + (Number.isFinite(t.heldFor) ? t.heldFor : 0), 0)
  if (r.grid) return r.grid.inRangePct
  return Math.min(100, held / r.candles * 100)
}

/**
 * Return for each calendar month the curve touches: the balance at the month's end against
 * the balance at the end of the one before. The first month is measured from the start.
 */
export function monthlyReturns(curve) {
  if (!curve?.length) return []
  const out = []
  let prevEnd = curve[0][1], cur = null, last = curve[0][1]
  const key = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth() }
  for (const [t, v] of curve) {
    const k = key(t)
    if (cur == null) cur = k
    if (k !== cur) {
      out.push({ ym: cur, ret: prevEnd > 0 ? (last / prevEnd - 1) * 100 : null })
      prevEnd = last
      cur = k
    }
    last = v
  }
  out.push({ ym: cur, ret: prevEnd > 0 ? (last / prevEnd - 1) * 100 : null })
  return out.map(m => ({ ...m, year: Math.floor(m.ym / 12), month: m.ym % 12 }))
}

/**
 * Buying the markets at the first candle and doing nothing: the number every strategy has to
 * beat before it is worth running. Equal weight across the markets, rebalanced never.
 *
 * `bars` is { coin: [{t, c}] }. Each market is valued at its own last close on or before a
 * timestamp, so markets with different histories line up by time rather than by position.
 */
export function buyHold(bars, coins, startBalance) {
  const list = (coins ?? []).filter(c => (bars?.[c]?.length ?? 0) > 1)
  if (!list.length || !(startBalance > 0)) return null
  const times = [...new Set(list.flatMap(c => bars[c].map(r => r.t)))].sort((a, b) => a - b)
  const idx = Object.fromEntries(list.map(c => [c, 0]))
  const per = startBalance / list.length
  const curve = []
  for (const t of times) {
    let v = 0
    for (const c of list) {
      const rows = bars[c]
      while (idx[c] + 1 < rows.length && rows[idx[c] + 1].t <= t) idx[c]++
      // Before a market's first candle its slice is still cash.
      v += rows[idx[c]].t <= t ? per * rows[idx[c]].c / rows[0].c : per
    }
    curve.push([t, v])
  }
  const end = curve[curve.length - 1][1]
  let maxDD = 0
  for (const [, d] of drawdownCurve(curve)) if (-d > maxDD) maxDD = -d
  return { curve, retPct: (end / startBalance - 1) * 100, net: end - startBalance, maxDD }
}

/**
 * Everything the report prints, from one result. `bars` and `coins` are optional; without
 * them there is no benchmark, which is shown as missing rather than as zero.
 */
export function summarize(r, bars = null, coins = null) {
  const curve = equityCurve(r)
  const risk = riskStats(curve)
  const bench = bars ? buyHold(bars, coins ?? Object.keys(bars), r?.startBalance) : null
  return {
    curve, risk, bench,
    trades: tradeStats(r),
    exposure: exposurePct(r),
    months: monthlyReturns(curve),
    // The engine's own drawdown for grid and DCA is already marked to market; for the rest
    // the curve's is the same number measured the same way, so either is the drawdown.
    maxDD: Math.max(r?.maxDrawdown ?? 0, risk.maxDD),
    // Beat buy-and-hold by this many percentage points, or trailed it.
    edge: bench && r?.roe != null ? r.roe - bench.retPct : null,
  }
}

/**
 * One number to rank strategies by in a comparison: return per unit of drawdown. Raw
 * return alone ranks a 20x coin-flip first. Null when there is no drawdown to divide by
 * AND nothing was made -- a strategy that never traded is not the safest one.
 */
export function score(roe, maxDD) {
  if (roe == null) return null
  if (!(maxDD > 0)) return roe > 0 ? roe : roe === 0 ? null : roe
  return roe / Math.max(1, maxDD)
}
