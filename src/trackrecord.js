/**
 * INSOLVENT TERMINAL — a wallet's track record, for deciding whether to copy it.
 *
 * Asked for on the leaderboard: "add more info like the profit factor … this would allow users
 * to see if a wallet they want to copy trade has been profitable in the past". Win rate was
 * already there, and on its own it is the number most likely to mislead a copier: a wallet that
 * wins 85% of its trades by taking $5 profits and $200 losses has a great win rate and a losing
 * strategy. What answers the question is how BIG the wins and losses are, how deep it has
 * drawn down, how long the record is, and whether it is still trading at all.
 *
 * Pure. The server computes it for every board row (server.js lbRefreshOne) and the browser
 * computes the same thing when it has to build rows itself, so the two can never disagree.
 * NOTE: server.js imports this file, but a deploy restarts the bot server only when server.js
 * or strategies/ change — an edit here alone reaches the server's rows on its next restart.
 *
 * ─── WHAT "A TRADE" MEANS HERE ───────────────────────────────────────────────────────────
 * The same unit win rate already uses: every closing fill in one coin within one clock hour,
 * summed, net of those fills' fees. A position closed in 40 pieces is one trade, not 40 — which
 * is what stops a market maker's thousands of fills from reading as thousands of decisions.
 * Opening fees are not in it, so these figures are slightly kinder than the account's net PnL.
 *
 * ─── WHAT COMES FROM HYPERLIQUID DIRECTLY ────────────────────────────────────────────────
 * 7D / 30D P&L and the drawdown are read from HL's own `portfolio` P&L history, PERP series,
 * because copy trading copies perps only. Each series restarts at 0 at the start of its window,
 * so its last point IS the window's P&L — no subtraction, no deposits to correct for.
 */

const HOUR = 3_600_000
const DAY  = 86_400_000

// Below this, the ratios describe luck more than skill. Said on screen, not hidden.
export const SMALL_SAMPLE_TRADES = 20
export const SMALL_SAMPLE_DAYS   = 14

/** The last point of one of HL's portfolio series, or null when that series is absent. */
function seriesLast(portfolio, names) {
  for (const n of names) {
    const s = (portfolio ?? []).find(p => p?.[0] === n)?.[1]?.pnlHistory
    if (Array.isArray(s) && s.length) {
      const v = parseFloat(s.at(-1)[1])
      if (Number.isFinite(v)) return v
    }
  }
  return null
}

/**
 * Worst peak-to-trough fall of the all-time perp P&L curve.
 *
 * Measured on P&L, not on account value: account value falls on every withdrawal, and a wallet
 * that took profits out would read as having crashed.
 *
 * The percentage is the fall against the MOST the account held at any point during it. Not
 * the value at the peak: a real wallet on the board lost $846 from a peak where the account
 * held $277, because it kept depositing to cover — and "305% drawdown" helps nobody. The
 * largest balance in the stretch is the capital that was actually exposed to the fall. Left
 * null when even that gives a ratio over 100% (money kept arriving faster than it was lost)
 * or the account was too small for a ratio to mean anything.
 */
function drawdown(portfolio) {
  const series = (name) => (portfolio ?? []).find(p => p?.[0] === name)?.[1]
  const pnlSrc = series('perpAllTime') ?? series('allTime')
  const pnl = (pnlSrc?.pnlHistory ?? [])
    .map(([t, v]) => [+t, parseFloat(v)]).filter(([t, v]) => t > 0 && Number.isFinite(v))
  if (pnl.length < 2) return null
  const av = ((series('allTime') ?? pnlSrc)?.accountValueHistory ?? [])
    .map(([t, v]) => [+t, parseFloat(v)]).filter(([t, v]) => t > 0 && Number.isFinite(v))

  let peak = pnl[0], worst = 0, at = null
  for (const p of pnl) {
    if (p[1] > peak[1]) peak = p
    const fall = peak[1] - p[1]
    if (fall > worst) { worst = fall; at = { peakT: peak[0], troughT: p[0] } }
  }
  if (!(worst > 0)) return { usd: 0, pct: 0 }
  let base = null
  for (const [t, v] of av) {
    if (t >= at.peakT && t <= at.troughT && (base === null || v > base)) base = v
  }
  const raw = base != null && base >= 50 ? (worst / base) * 100 : null
  const pct = raw != null && raw <= 100 ? raw : null
  return { usd: worst, pct, peakAt: at.peakT, troughAt: at.troughT }
}

/**
 * @param {object} p
 * @param {Object<string, number>} p.windows  `COIN_hourIndex` → net P&L of that hour's closes
 * @param {Array} [p.portfolio]  HL `portfolio` response
 * @param {number} [p.lastFillAt] time of the most recent fill of any kind (opens included)
 * @param {number} [p.openLoss]   sum of the LOSING open positions' unrealized P&L, as a
 *                                positive number (see openLossOf). Omit when unknown.
 */
export function trackRecord({ windows, portfolio, lastFillAt, openLoss } = {}) {
  const entries = Object.entries(windows ?? {})
    .map(([k, v]) => [Number(String(k).slice(String(k).lastIndexOf('_') + 1)), Number(v)])
    .filter(([h, v]) => Number.isFinite(h) && Number.isFinite(v))

  let grossWin = 0, grossLoss = 0, wins = 0, losses = 0, best = null, worst = null
  let firstHour = Infinity
  const days = new Set()
  for (const [h, v] of entries) {
    if (v > 0) { grossWin += v; wins++ }
    else if (v < 0) { grossLoss += -v; losses++ }
    if (best === null || v > best) best = v
    if (worst === null || v < worst) worst = v
    if (h < firstHour) firstHour = h
    days.add(Math.floor((h * HOUR) / DAY))
  }
  const trades = entries.length

  return {
    trades,
    wins, losses,
    grossWin, grossLoss,
    // No losses is not "infinite": it is a record too short or too lucky to have one, and the
    // UI says that in words. Null when there is nothing to divide at all.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    noLosses: trades > 0 && losses === 0 && wins > 0,
    // Profit factor only sees CLOSED trades, and a grid bot never closes a losing level — it
    // holds it. A real wallet read 914 on $555.53 won against $0.61 lost, while $76 sat in
    // two losing open positions. Counting those as if closed now, the same wallet is ~7.
    // Reported beside the closed figure, not instead of it: both are true, and the gap
    // between them is the thing a copier needs to see.
    openLoss: Number(openLoss) > 0 ? Number(openLoss) : 0,
    profitFactorOpen: Number(openLoss) > 0 && grossWin > 0
      ? grossWin / (grossLoss + Number(openLoss)) : null,
    avgWin:  wins   ? grossWin  / wins   : null,
    avgLoss: losses ? grossLoss / losses : null,
    // Per trade, after fees: what following every one of its trades averaged.
    expectancy: trades ? (grossWin - grossLoss) / trades : null,
    best, worst,
    tradingDays: days.size,
    firstTradeAt: Number.isFinite(firstHour) ? firstHour * HOUR : null,
    lastFillAt: Number(lastFillAt) > 0 ? Number(lastFillAt) : null,
    pnl7d:  seriesLast(portfolio, ['perpWeek', 'week']),
    pnl30d: seriesLast(portfolio, ['perpMonth', 'month']),
    maxDrawdown: drawdown(portfolio),
  }
}

/**
 * The open positions that are losing, summed as a positive number.
 *
 * Only the losers: a winning open position does not offset a losing one here, because the
 * question is "how much loss is being held instead of taken", and netting would hide it.
 * Accepts Hyperliquid's `{ position: {...} }` wrapper or the bare position.
 */
export function openLossOf(positions) {
  let loss = 0
  for (const ap of (positions ?? [])) {
    const u = parseFloat((ap?.position ?? ap)?.unrealizedPnl ?? 0)
    if (Number.isFinite(u) && u < 0) loss -= u
  }
  return loss
}

/** True when the record is too thin for the ratios above to be read as skill. */
export function isSmallSample(tr, now = Date.now()) {
  if (!tr || !tr.trades) return true
  const span = tr.firstTradeAt ? (now - tr.firstTradeAt) / DAY : 0
  return tr.trades < SMALL_SAMPLE_TRADES || span < SMALL_SAMPLE_DAYS
}
