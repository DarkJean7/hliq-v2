import { fmtUSD, fmtPrice, fmtSize, fmtPnL, fmtPct, fmtCompact, fmtTime, esc } from './format.js'
import { aggregateFillsByCoin, coinLabel } from './api.js'
import { renderOverviewChart } from './charts.js'

// Outcome-aware coin label: resolves prediction-market "#N"/"+N" codes to their
// market name + side via main.js's ocTokenMap (window._ocCoinLabel). Falls back to
// the plain HIP-3-stripped label. Use this for any user-facing coin name.
function _lbl(coin) {
  return (typeof window !== 'undefined' && window._ocCoinLabel) ? window._ocCoinLabel(coin) : coinLabel(coin)
}
// Escape for a single-quoted JS string inside a double-quoted HTML onclick attr.
const _jss = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;')

// Overview hero chart period/type + cached data for the switchers
let _ovPeriod = 'week'
let _ovChartType = 'value'   // 'value' | 'accumulated' | 'realized'
let _ovPortfolio = []
let _ovFills = []
let _ovPosTab = 'positions'   // 'positions' | 'orders' (shown one at a time)
let _ovPosBody = ''
let _ovOrdBody = ''
let _ovPosSortKey = 'pnl', _ovPosSortDir = -1   // default: unrealized PnL, descending
let _ovPosData = null                          // { positions, allMids, tpslMap } for re-sort without full re-render
let _ovOrdSortKey = null, _ovOrdSortDir = -1
let _ovOrdData = null                          // { orders, allMids } for re-sort without full re-render
const _ovExpanded = new Set()   // sanitized coin ids whose action row is open (survives re-renders)
const _OV_PERIOD_KEY = { '1D': 'day', '1W': 'week', '1M': 'month', 'All': 'allTime' }

// ─── SORT / EXPAND STATE ─────────────────────────────────────────────────────
let _tradesPage = 0
let _lastUnrealPnl  = null
let _ordSortKey  = null, _ordSortDir  = 1
let _mPosSortKey = null, _mPosSortDir = 1
let _mOrdSortKey  = null, _mOrdSortDir  = 1

export function setSortOrd(key) {
  if (_ordSortKey === key) _ordSortDir *= -1
  else { _ordSortKey = key; _ordSortDir = 1 }
}
export function setSortMPos(key) {
  if (_mPosSortKey === key) _mPosSortDir *= -1
  else { _mPosSortKey = key; _mPosSortDir = 1 }
}
export function setSortMOrd(key) {
  if (_mOrdSortKey === key) _mOrdSortDir *= -1
  else { _mOrdSortKey = key; _mOrdSortDir = 1 }
}
export function setTradesPage(p) { _tradesPage = p }
export function getTradesPage()  { return _tradesPage }

export function renderSummaryCards(fills, perpState) {
  const el = document.getElementById('tradesSummary')
  if (!el) return
  const positions   = perpState?.assetPositions ?? []
  const totalUnreal = positions.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
  const totalVolume = fills.reduce((s, f) => s + f.notional, 0)
  const totalFees   = fills.reduce((s, f) => s + f.fee, 0)
  const ONE_HOUR_T  = 60 * 60 * 1000
  const tradeWindows = {}
  for (const f of fills.filter(f => f.closedPnl !== 0)) {
    const bucket = Math.floor(f.time / ONE_HOUR_T)
    const key    = `${f.coin}_${bucket}`
    if (!tradeWindows[key]) tradeWindows[key] = { netPnl: 0 }
    tradeWindows[key].netPnl += f.closedPnl - f.fee
  }
  const twList  = Object.values(tradeWindows)
  const winners = twList.filter(w => w.netPnl > 0).length
  const winRate = twList.length > 0 ? (winners / twList.length * 100).toFixed(1) : '—'
  const unreal  = fmtPnL(totalUnreal)
  el.innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Volume</div><div class="stat-value neu">$${fmtCompact(totalVolume)}</div></div>
    <div class="stat-card"><div class="stat-label">Unrealized PnL</div><div class="stat-value ${unreal.cls}">${unreal.text}</div></div>
    <div class="stat-card"><div class="stat-label">Total Fees</div><div class="stat-value neg">-$${fmtUSD(totalFees)}</div></div>
    <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value neu">${winRate}${twList.length > 0 ? '%' : ''}</div></div>`
}

function _sortArrow(key, activeKey, dir) {
  if (key !== activeKey) return `<span style="color:var(--muted);font-size:9px;margin-left:3px;opacity:0.4">^</span>`
  return `<span style="color:var(--accent);font-size:9px;margin-left:3px">${dir === 1 ? '^' : 'v'}</span>`
}
function _thOrd(key, label, activeKey, dir) {
  return `<th style="cursor:pointer;user-select:none" onclick="window.__sortOrders('${key}')">${label}${_sortArrow(key, activeKey, dir)}</th>`
}
function _thMPos(key, label, activeKey, dir) {
  return `<th style="cursor:pointer;user-select:none" onclick="window.__sortMPos('${key}')">${label}${_sortArrow(key, activeKey, dir)}</th>`
}
function _thMOrd(key, label, activeKey, dir) {
  return `<th style="cursor:pointer;user-select:none" onclick="window.__sortMOrd('${key}')">${label}${_sortArrow(key, activeKey, dir)}</th>`
}

// ─── DURATION & STREAK HELPERS ────────────────────────────────────────────────

function computeAvgHoldTime(coinFills) {
  const sorted   = [...coinFills].sort((a, b) => a.time - b.time)
  const durations = []
  const openTimes = { long: [], short: [] }
  for (const f of sorted) {
    const dir = (f.dir ?? '').toLowerCase()
    if      (dir.includes('open long'))        { openTimes.long.push(f.time) }
    else if (dir.includes('open short'))       { openTimes.short.push(f.time) }
    else if (dir.includes('close long')  && openTimes.long.length)  { durations.push(f.time - openTimes.long.shift()) }
    else if (dir.includes('close short') && openTimes.short.length) { durations.push(f.time - openTimes.short.shift()) }
  }
  return durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—'
  const mins  = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days  = Math.floor(hours / 24)
  if (days > 0)  return days + 'd ' + (hours % 24) + 'h'
  if (hours > 0) return hours + 'h ' + (mins % 60) + 'm'
  return mins + 'm'
}

export function computeCurrentStreak(fills) {
  const ONE_HOUR = 60 * 60 * 1000
  const windows  = {}
  for (const f of fills.filter(f => f.closedPnl !== 0)) {
    const bucket = Math.floor(f.time / ONE_HOUR)
    const key    = `${f.coin}_${bucket}`
    if (!windows[key]) windows[key] = { time: f.time, netPnl: 0 }
    windows[key].netPnl += f.closedPnl - f.fee
    if (f.time > windows[key].time) windows[key].time = f.time
  }
  const sorted = Object.values(windows).sort((a, b) => b.time - a.time)
  if (!sorted.length) return 0
  const isWin = sorted[0].netPnl > 0
  let streak = 0
  for (const w of sorted) {
    if ((w.netPnl > 0) === isWin) streak++
    else break
  }
  return isWin ? streak : -streak
}

// ─── SKELETON HELPERS ─────────────────────────────────────────────────────────
export function skeletonStatCards(n) {
  return Array.from({ length: n }, () => `
    <div class="stat-card skeleton-card">
      <div class="skeleton-line" style="height:9px;width:45%"></div>
      <div class="skeleton-line" style="height:22px;width:70%;margin-top:2px"></div>
      <div class="skeleton-line" style="height:9px;width:55%;margin-top:2px"></div>
    </div>`
  ).join('')
}

export function skeletonRows(cols, n = 5) {
  const widths = [60, 80, 50, 70, 55, 65, 75]
  return Array.from({ length: n }, (_, row) =>
    `<tr>${Array.from({ length: cols }, (__, col) =>
      `<td><div class="skeleton-line" style="height:11px;width:${widths[(row * cols + col) % widths.length]}%"></div></td>`
    ).join('')}</tr>`
  ).join('')
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function portfolioLatest(portfolio, period, key) {
  const entry   = (portfolio ?? []).find(p => p[0] === period)
  const history = entry?.[1]?.[key] ?? []
  const last    = history.at(-1)
  return last ? parseFloat(last[1]) : null
}

// Live unified account value. The portfolio endpoint is HL's own "Portfolio
// Value" but the app only refetches it once a minute — meanwhile uPnL flows
// 1:1 into the unified balance, so add the perp-equity delta since the
// snapshot (_perpAnchor is stamped on the portfolio at fetch time in main.js).
function liveAccountValue(portfolio, perpAcctVal, spotUSDCTotal) {
  const snap = portfolioLatest(portfolio, 'allTime', 'accountValueHistory')
  if (snap == null) return perpAcctVal + spotUSDCTotal
  const anchor = portfolio?._perpAnchor
  return anchor != null ? snap + (perpAcctVal - anchor) : snap
}

// ─── ACCOUNT STATS ───────────────────────────────────────────────────────────
export function computeAcctStats(perpState, spotState, fills, portfolio = []) {
  const margin     = perpState?.marginSummary ?? {}
  const positions  = perpState?.assetPositions ?? []

  const totalNtl      = parseFloat(margin.totalNtlPos      ?? 0)
  const maintMargin   = parseFloat(perpState?.crossMaintenanceMarginUsed ?? margin.totalMarginUsed ?? 0)
  const perpWithdraw  = parseFloat(perpState?.withdrawable  ?? 0)
  const spotUSDC      = (spotState?.balances ?? []).find(b => b.coin === 'USDC')
  const spotUSDCFree  = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
  const spotUSDCTotal = spotUSDC ? parseFloat(spotUSDC.total ?? 0) : 0
  const withdrawable  = perpWithdraw + spotUSDCFree
  const perpAcctVal   = parseFloat(margin.accountValue ?? 0)
  // HL "Portfolio Value": unified account value (on unified accounts the USDC
  // balance already contains perp equity, so perp+spot would double-count).
  const accountValue  = liveAccountValue(portfolio, perpAcctVal, spotUSDCTotal)

  const unrealizedPnl = positions.reduce((s, p) => s + parseFloat(p.position?.unrealizedPnl ?? 0), 0)
  const realizedPnl   = (fills ?? []).reduce((s, f) => s + (f.closedPnl ?? 0), 0)
  const netPnl        = realizedPnl + unrealizedPnl

  // HL "Unified Account Ratio" = perps maintenance margin / unified USDC balance.
  // Health = 100 − that ratio. Falls back to perp equity for non-unified accounts.
  const marginBase = spotUSDCTotal > 0 ? spotUSDCTotal : perpAcctVal
  const healthPct  = marginBase > 0 ? Math.max(0, (1 - maintMargin / marginBase) * 100) : 0
  const healthCls  = healthPct > 60 ? 'pos' : healthPct > 30 ? 'warn' : 'neg'
  const healthStr  = accountValue > 0 ? healthPct.toFixed(1) + '%' : '—'

  const accountLeverage = accountValue > 0 ? totalNtl / accountValue : 0

  return { accountValue, unrealizedPnl, realizedPnl, netPnl, maintMargin, withdrawable, healthPct, healthStr, healthCls, accountLeverage }
}

// ─── OVERVIEW ────────────────────────────────────────────────────────────────
export function renderOverview({ perpState, spotState, fills, funding = [], openOrders, allMids = {}, portfolio = [], webData = null, sessionStart = null, firstFillTime = null, addr = null }) {
  const margin    = perpState.marginSummary ?? {}
  const positions = perpState.assetPositions ?? []

  const totalNtl    = parseFloat(margin.totalNtlPos    ?? 0)
  const marginUsed  = parseFloat(margin.totalMarginUsed ?? 0)

  // Withdrawable: perp + any free spot USDC
  const perpWithdrawable = parseFloat(perpState.withdrawable ?? 0)
  const spotUSDC         = (spotState?.balances ?? []).find(b => b.coin === 'USDC')
  const spotUSDCFree     = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
  const spotUSDCTotal    = spotUSDC ? parseFloat(spotUSDC.total ?? 0) : 0
  const withdrawable     = perpWithdrawable + spotUSDCFree
  const perpAcctVal      = parseFloat(margin.accountValue ?? 0)
  // HL "Portfolio Value" — see liveAccountValue; unified USDC already contains perp equity
  const accountValue     = liveAccountValue(portfolio, perpAcctVal, spotUSDCTotal)

  const totalUnrPnl = positions.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
  const totalVolume = fills.reduce((s, f) => s + f.notional, 0)

  // Convert fees to USD — Hyperliquid can charge in USDC or HYPE
  const totalFees = fills.reduce((s, f) => {
    if (!f.fee) return s
    if (f.feeToken === 'USDC' || !f.feeToken) return s + f.fee
    const tokenPx = parseFloat(allMids[f.feeToken] ?? 0)
    return s + (tokenPx > 0 ? f.fee * tokenPx : 0)
  }, 0)

  // ── Net deposited from webData2.cumLedger ────────────────────────────────
  // cumLedger = total USDC bridged IN minus total USDC bridged OUT (Arbitrum ↔ HL).
  // This is the authoritative value HL tracks internally.
  const cumLedger = parseFloat(webData?.cumLedger ?? 0)

  // Realized PnL = literal sum of all closed trade PnL from fills
  const totalClosedPnl = fills.reduce((s, f) => s + f.closedPnl, 0)

  // All Time PnL = equity − net deposits (matches what HL shows on their portfolio page)
  const allTimePnl = cumLedger !== 0
    ? accountValue - cumLedger
    : portfolioLatest(portfolio, 'allTime', 'pnlHistory') ?? totalClosedPnl

  const allTimeFunding = funding.reduce((s, f) => s + f.usdc, 0)

  // Net PnL = realized + unrealized + funding − fees
  const netPnl = totalClosedPnl + totalUnrPnl + allTimeFunding - totalFees

  // ── Biggest loss: aggregate closing fills per asset per 1h window ─────────
  // Groups all closing fills for the same coin within a 1-hour bucket,
  // sums their net PnL (closedPnl - fee), finds the worst bucket.
  const ONE_HOUR = 60 * 60 * 1000
  const closingFills = fills.filter(f => f.closedPnl !== 0)
  const lossWindows  = {}   // key: "COIN_hourBucket" → { coin, time, netPnl }
  for (const f of closingFills) {
    const bucket = Math.floor(f.time / ONE_HOUR)
    const key    = `${f.coin}_${bucket}`
    if (!lossWindows[key]) lossWindows[key] = { coin: f.coin, time: f.time, netPnl: 0 }
    lossWindows[key].netPnl += f.closedPnl - f.fee
  }
  // Win rate: count grouped trade windows, not raw fills
  const allWindows    = Object.values(lossWindows)
  const closedTrades  = allWindows.length
  const winningTrades = allWindows.filter(w => w.netPnl > 0).length
  const winRate       = closedTrades > 0 ? (winningTrades / closedTrades * 100).toFixed(1) : '—'

  // ── Current streak & profit factor ───────────────────────────────────────
  const currentStreak = computeCurrentStreak(fills)
  const _grossWin  = fills.reduce((s, f) => f.closedPnl > 0 ? s + f.closedPnl : s, 0)
  const _grossLoss = fills.reduce((s, f) => f.closedPnl < 0 ? s + Math.abs(f.closedPnl) : s, 0)
  const profitFactor = _grossLoss > 0 ? _grossWin / _grossLoss : _grossWin > 0 ? Infinity : 0

  const worstWindow = allWindows.reduce(
    (worst, w) => w.netPnl < worst.netPnl ? w : worst,
    { coin: '', time: 0, netPnl: 0 }
  )
  const biggestLoss     = worstWindow.netPnl
  const biggestLossCoin = worstWindow.coin
  const biggestLossTime = worstWindow.time
    ? new Date(worstWindow.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : ''

  const bestWindow = Object.values(lossWindows).reduce(
    (best, w) => w.netPnl > best.netPnl ? w : best,
    { coin: '', time: 0, netPnl: 0 }
  )
  const biggestWin     = bestWindow.netPnl
  const biggestWinCoin = bestWindow.coin
  const biggestWinTime = bestWindow.time
    ? new Date(bestWindow.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : ''

  // ── Member since: earliest activity ──────────────────────────────────────
  // firstFillTime is cached from a full desktop load — keeps mobile (90-day) accurate
  const earliestFill   = firstFillTime ?? (fills.length > 0 ? fills[fills.length - 1].time : null)
  const earliestTs     = earliestFill ?? Infinity
  const memberSince    = isFinite(earliestTs)
    ? new Date(earliestTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—'


  // ── Inline % helpers ─────────────────────────────────────────────────────
  const pctEq  = (n) => accountValue > 0 ? '(' + (n / accountValue * 100).toFixed(2) + '%)' : ''

  // ── Hero row: the 3 numbers that matter most ──────────────────────────────
  const heroStats = [
    {
      label: 'Account Value',
      value: '$' + fmtUSD(accountValue),
      sub:   'Perp equity (cross + isolated)',
      cls:   'neu',
    },
    {
      label: 'Unrealized PnL',
      value: fmtPnL(totalUnrPnl).text,
      sub:   positions.length + ' open position' + (positions.length !== 1 ? 's' : '')
           + (accountValue > 0 ? ' · ' + (totalUnrPnl / accountValue * 100).toFixed(2) + '%' : ''),
      cls:   fmtPnL(totalUnrPnl).cls,
    },
    {
      label: 'Withdrawable',
      value: '$' + fmtUSD(withdrawable),
      sub:   (marginUsed > 0 ? '$' + fmtUSD(marginUsed) + ' in margin' : 'Free USDC')
           + (accountValue > 0 ? ' · ' + (withdrawable / accountValue * 100).toFixed(1) + '%' : ''),
      cls:   'pos',
    },
  ]

  // ── Stats row: performance breakdown ─────────────────────────────────────
  const netDeposited = cumLedger >= 0 ? cumLedger : 0
  const netWithdrawn = cumLedger < 0  ? Math.abs(cumLedger) : 0
  const roiStr       = cumLedger > 0  ? '(' + (allTimePnl / cumLedger * 100).toFixed(2) + '%)' : ''

  const perfStats = [
    // ── PnL ──────────────────────────────────────────────────────────────────
    {
      label: 'All Time PnL',
      value: fmtPnL(allTimePnl).text + roiStr,
      sub:   'Current equity minus net deposits',
      cls:   fmtPnL(allTimePnl).cls,
    },
    {
      label: 'Realized PnL',
      value: fmtPnL(totalClosedPnl).text + pctEq(totalClosedPnl),
      sub:   closedTrades + ' closed trade' + (closedTrades !== 1 ? 's' : ''),
      cls:   fmtPnL(totalClosedPnl).cls,
    },
    {
      label: 'Net PnL',
      value: fmtPnL(netPnl).text + pctEq(netPnl),
      sub:   'Realized + unrealized + funding − fees',
      cls:   fmtPnL(netPnl).cls,
    },
    // ── Fees & Funding ───────────────────────────────────────────────────────
    {
      label: 'Profit Factor',
      value: profitFactor === Infinity ? 'No losses' : profitFactor > 0 ? profitFactor.toFixed(2) : '—',
      sub:   'Gross wins ÷ gross losses',
      cls:   profitFactor >= 1 ? 'pos' : profitFactor > 0 ? 'neg' : 'neu',
    },
    {
      label: 'All Time Funding',
      value: fmtPnL(allTimeFunding).text,
      sub:   funding.length + ' payments in last 30 days',
      cls:   allTimeFunding >= 0 ? 'pos' : 'neg',
    },
    {
      label: 'Total Fees Paid',
      value: '-$' + fmtUSD(totalFees),
      sub:   'Paid to exchange across all fills',
      cls:   'neg',
    },
    // ── Win rate & streak ────────────────────────────────────────────────────
    {
      label: 'Current Streak',
      value: currentStreak === 0 ? '—'
        : currentStreak > 0
          ? '+' + currentStreak + ' win' + (currentStreak !== 1 ? 's' : '')
          : Math.abs(currentStreak) + ' loss' + (Math.abs(currentStreak) !== 1 ? 'es' : ''),
      sub:   currentStreak > 0 ? 'Consecutive winning trades'
           : currentStreak < 0 ? 'Consecutive losing trades'
           : 'No closed trades yet',
      cls:   currentStreak > 0 ? 'pos' : currentStreak < 0 ? 'neg' : 'neu',
    },
    {
      label: 'Win Rate',
      value: winRate + (closedTrades > 0 ? '%' : ''),
      sub:   winningTrades + ' of ' + closedTrades + ' closed',
      cls:   'neu',
    },
    // ── Best / worst ─────────────────────────────────────────────────────────
    {
      label: 'Biggest Win',
      value: biggestWin > 0 ? fmtPnL(biggestWin).text : '—',
      sub:   biggestWin > 0 ? biggestWinCoin + ' · ' + biggestWinTime : 'No winning trades yet',
      cls:   biggestWin > 0 ? 'pos' : 'neu',
    },
    {
      label: 'Biggest Loss',
      value: biggestLoss < 0 ? fmtPnL(biggestLoss).text : '—',
      sub:   biggestLoss < 0 ? biggestLossCoin + ' · ' + biggestLossTime : 'No losing trades yet',
      cls:   biggestLoss < 0 ? 'neg' : 'neu',
    },
    // ── Account ──────────────────────────────────────────────────────────────
    {
      label: 'Net Deposited',
      value: cumLedger !== 0 ? '$' + fmtUSD(netDeposited) : '—',
      sub:   'Total deposited minus withdrawals',
      cls:   'neu',
    },
    {
      label: 'Total Withdrawn',
      value: cumLedger !== 0 ? '$' + fmtUSD(netWithdrawn) : '—',
      sub:   'Net USDC bridged out',
      cls:   netWithdrawn > 0 ? 'neg' : 'neu',
    },
    {
      label: 'Total Volume',
      value: '$' + fmtCompact(totalVolume),
      sub:   fills.length + ' fills',
      cls:   'neu',
      id:    'statTotalVolume',
    },
    {
      label: 'Member Since',
      value: memberSince,
      sub:   isFinite(earliestTs) ? Math.floor((Date.now() - earliestTs) / (1000 * 60 * 60 * 24)) + ' days ago' : '—',
      cls:   'neu',
    },
  ]

  const maintMargin = parseFloat(perpState.crossMaintenanceMarginUsed ?? 0)
  // Health = 100 − HL's Unified Account Ratio (maint margin / unified USDC balance)
  const _healthBase = spotUSDCTotal > 0 ? spotUSDCTotal : perpAcctVal
  const health      = _healthBase > 0
    ? Math.max(0, Math.min(100, (1 - maintMargin / _healthBase) * 100))
    : 100
  const healthColor = health > 50 ? 'var(--green)' : health > 25 ? 'var(--yellow)' : health > 10 ? '#ff9444' : 'var(--red)'

  // ── Period change for the hero (from portfolio account-value history) ──────
  _ovPortfolio = portfolio
  _ovFills = fills
  const periodChg = _ovComputeChange(_ovPeriod)
  const chgCls    = periodChg.diff >= 0 ? 'pos' : 'neg'
  const chgArrow  = periodChg.diff >= 0 ? '▲' : '▼'
  const chgTxt    = (periodChg.diff >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(periodChg.diff))
  const chgPctTxt = (periodChg.diff >= 0 ? '+' : '') + periodChg.pct.toFixed(2) + '%'

  const inMarginPct = accountValue > 0 ? (marginUsed / accountValue * 100) : 0

  // ── Selected stats for the strip (the 6 from the mockup) ──────────────────
  const ringColor = health > 70 ? 'var(--green)' : health > 40 ? 'var(--yellow)' : health > 20 ? '#ff9444' : 'var(--red)'
  const strip = [
    { label: 'All-Time PnL',  value: fmtPnL(allTimePnl).text,   sub: roiStr || 'vs net deposits', cls: fmtPnL(allTimePnl).cls },
    { label: 'Net PnL',       value: fmtPnL(netPnl).text,       sub: pctEq(netPnl) || 'incl. funding', cls: fmtPnL(netPnl).cls },
    { label: 'Win Rate',      value: winRate + (closedTrades > 0 ? '%' : ''), sub: winningTrades + ' / ' + closedTrades, cls: 'neu' },
    { label: 'Profit Factor', value: profitFactor === Infinity ? '∞' : profitFactor > 0 ? profitFactor.toFixed(2) : '—', sub: 'wins ÷ losses', cls: profitFactor >= 1 ? 'pos' : profitFactor > 0 ? 'neg' : 'neu' },
    { label: 'Total Volume',  value: '$' + fmtCompact(totalVolume), sub: fills.length + ' fills', cls: 'neu', id: 'statTotalVolume' },
    { label: 'Current Streak', value: currentStreak === 0 ? '—' : Math.abs(currentStreak) + (currentStreak > 0 ? ' win' : ' loss') + (Math.abs(currentStreak) !== 1 ? (currentStreak > 0 ? 's' : 'es') : ''), sub: 'consecutive', cls: currentStreak > 0 ? 'pos' : currentStreak < 0 ? 'neg' : 'neu' },
  ]

  // TP/SL map from open orders (for the per-position Edit modal)
  const tpslMap = {}
  for (const o of (openOrders ?? [])) {
    const ot = o.orderType ?? ''
    const isTp = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = ot.startsWith('Stop')        || o.triggerCondition === 'sl'
    if (!isTp && !isSl) continue
    const px = parseFloat(o.triggerPx ?? 0) > 0 ? parseFloat(o.triggerPx) : parseFloat(o.limitPx ?? 0)
    if (!tpslMap[o.coin]) tpslMap[o.coin] = {}
    if (isTp) { tpslMap[o.coin].tpPx = px; tpslMap[o.coin].tpOid = o.oid }
    if (isSl) { tpslMap[o.coin].slPx = px; tpslMap[o.coin].slOid = o.oid }
  }

  // Position / Order tab bodies (one shown at a time via __ovSetPosTab)
  _ovPosData = { positions, allMids, tpslMap }
  _ovPosBody = _ovBuildPosBody(positions, allMids, tpslMap)
  _ovOrdData = { orders: openOrders ?? [], allMids }
  _ovOrdBody = _ovBuildOrdBody(openOrders ?? [], allMids)

  // ── Recent activity from fills ────────────────────────────────────────────
  const activity = _ovRecentActivity(fills)

  const rangeBtns = ['1D','1W','1M','All'].map(r => {
    const active = _OV_PERIOD_KEY[r] === _ovPeriod
    return `<button class="ov-range-btn${active ? ' active' : ''}" onclick="window.__ovSetRange('${r}')">${r}</button>`
  }).join('')

  // Preserve scroll across the full re-render (a live PnL update re-runs this and
  // would otherwise snap the page — and the positions list — back to the top).
  const _ovStatsEl = document.getElementById('overviewStats')
  const _ovWinY    = window.scrollY
  const _ovPosTop  = _ovStatsEl?.querySelector('.ov-pos-scroll')?.scrollTop ?? 0

  _ovStatsEl.innerHTML = `
    <div class="ov-grid">
      <div class="ov-main">

        <div class="ov-top-row">
          <div class="ov-card ov-equity">
            <div class="ov-eq-head">
              <div style="display:flex;align-items:flex-start;gap:12px;min-width:0">
                <div class="ov-acct-av">${(typeof window !== 'undefined' && window._mobVAvatarHtml) ? window._mobVAvatarHtml(addr, 44) : ''}</div>
                <div style="min-width:0">
                <div class="ov-label">Account Value · Perp Equity</div>
                <div class="ov-eq-val">$${fmtUSD(accountValue)}</div>
                <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
                  <span class="ov-chg ${chgCls}" id="ovChgPill">${chgArrow} ${chgTxt} · ${chgPctTxt}</span>
                </div>
                <div class="ov-eq-sub">${positions.length} open position${positions.length !== 1 ? 's' : ''} · cross + isolated · today</div>
                </div>
              </div>
              <div class="ov-range" id="ovRange">${rangeBtns}</div>
            </div>
            <div class="ov-chart-tabs" id="ovChartTabs">
              ${[['value','Equity'],['accumulated','Acc. PnL'],['realized','Realized']].map(([t,l]) =>
                `<button class="ov-ct-btn${_ovChartType===t?' active':''}" data-ct="${t}" onclick="window.__ovSetChartType('${t}')">${l}</button>`).join('')}
            </div>
            <div class="ov-chart-wrap"><canvas id="overviewChart"></canvas></div>
          </div>

          <div class="ov-card ov-health">
            <div class="ov-health-head"><span class="ov-label">Account Health</span></div>
            <div class="ov-ring-wrap">
              ${_ovRing(health, ringColor)}
            </div>
            <div class="ov-health-rows">
              <div class="ov-hr"><span>Unrealized PnL</span><b class="${totalUnrPnl >= 0 ? 'pos' : 'neg'}">${fmtPnL(totalUnrPnl).text}</b></div>
              <div class="ov-hr"><span>Leverage</span><b>${(accountValue > 0 ? totalNtl / accountValue : 0).toFixed(2)}×</b></div>
              <div class="ov-hr"><span>Withdrawable</span><b class="pos">$${fmtUSD(withdrawable)}</b></div>
              <div class="ov-hr"><span>In margin · ${inMarginPct.toFixed(1)}%</span><b>$${fmtUSD(marginUsed)}</b></div>
              <div class="ov-hr"><span>Maint. margin</span><b>$${fmtUSD(maintMargin)}</b></div>
            </div>
          </div>
        </div>

        <div class="ov-stat-strip">
          ${strip.map(s => `
            <div class="ov-stat">
              <div class="ov-stat-label">${esc(s.label)}</div>
              <div class="ov-stat-val ${s.cls}"${s.id ? ` id="${s.id}"` : ''}>${esc(s.value)}</div>
              <div class="ov-stat-sub">${esc(s.sub)}</div>
            </div>`).join('')}
        </div>

        <div class="ov-card ov-positions">
          <div class="ov-card-head">
            <div class="ov-postabs">
              <button class="ov-postab${_ovPosTab === 'positions' ? ' active' : ''}" data-pt="positions" onclick="window.__ovSetPosTab('positions')">Positions <span class="count-pill">${positions.length}</span></button>
              <button class="ov-postab${_ovPosTab === 'orders' ? ' active' : ''}" data-pt="orders" onclick="window.__ovSetPosTab('orders')">Orders <span class="count-pill">${(openOrders ?? []).length}</span></button>
              <button class="ov-postab${_ovPosTab === 'outcomes' ? ' active' : ''}" data-pt="outcomes" onclick="window.__ovSetPosTab('outcomes')">Outcomes <span class="count-pill">${_ovOcCount()}</span></button>
            </div>
            <button class="manage-btn close" id="ovPosAction" style="padding:4px 12px;font-size:11px;display:${_ovPosTab === 'outcomes' ? 'none' : ''}" onclick="window.__ovPosAction()">${_ovPosTab === 'positions' ? 'Close all' : 'Cancel all'}</button>
          </div>
          <div id="ovPosBody">${_ovTabBody(_ovPosTab)}</div>
        </div>

      </div>

      <div class="ov-side">
        <div class="ov-winloss">
          <div class="ov-card ov-wl">
            <div class="ov-stat-label">Biggest Win</div>
            <div class="ov-wl-val pos">${biggestWin > 0 ? fmtPnL(biggestWin).text : '—'}</div>
            <div class="ov-stat-sub">${biggestWin > 0 ? esc(biggestWinCoin) + ' · ' + esc(biggestWinTime) : 'No wins yet'}</div>
          </div>
          <div class="ov-card ov-wl">
            <div class="ov-stat-label">Biggest Loss</div>
            <div class="ov-wl-val neg">${biggestLoss < 0 ? fmtPnL(biggestLoss).text : '—'}</div>
            <div class="ov-stat-sub">${biggestLoss < 0 ? esc(biggestLossCoin) + ' · ' + esc(biggestLossTime) : 'No losses yet'}</div>
          </div>
        </div>

        <div class="ov-card ov-activity">
          <div class="ov-card-head">
            <div class="ov-card-title">Recent activity</div>
            <span class="ov-link" onclick="window.switchTab('trades',null)">History →</span>
          </div>
          ${activity || '<div class="ov-empty">No recent activity</div>'}
        </div>

        <div class="ov-card ov-footer">
          <div class="ov-hr"><span>Net deposited</span><b>${cumLedger !== 0 ? '$' + fmtUSD(netDeposited) : '—'}</b></div>
          <div class="ov-hr"><span>All-time funding</span><b class="${allTimeFunding >= 0 ? 'pos' : 'neg'}">${fmtPnL(allTimeFunding).text}</b></div>
          <div class="ov-hr"><span>Member since</span><b>${esc(memberSince)}</b></div>
        </div>
      </div>
    </div>`

  // Restore scroll (window + inner positions list) after the innerHTML swap.
  const _newPosScroll = _ovStatsEl.querySelector('.ov-pos-scroll')
  if (_newPosScroll && _ovPosTop) _newPosScroll.scrollTop = _ovPosTop
  if (_ovWinY) window.scrollTo(0, _ovWinY)

  if (_ovPosTab === 'outcomes') _ovRefreshOcMarks()   // fetch live marks for the outcomes body

  // Draw / update the hero chart
  try { renderOverviewChart(portfolio, _ovPeriod, _ovChartType, fills) } catch (e) { console.warn('overview chart', e) }

  const wrap = document.getElementById('overviewPositionsWrap')
  if (wrap) wrap.innerHTML = ''
}

// Period change from cached portfolio account-value history
function _ovComputeChange(period) {
  const entry = (_ovPortfolio || []).find(p => p[0] === period) ?? (_ovPortfolio || []).find(p => p[0] === 'allTime')
  const hist  = entry?.[1]?.accountValueHistory ?? []
  if (hist.length < 2) return { diff: 0, pct: 0 }
  const first = parseFloat(hist[0][1]), last = parseFloat(hist[hist.length - 1][1])
  const diff  = last - first
  return { diff, pct: first !== 0 ? diff / first * 100 : 0 }
}

// SVG donut ring for account health — starts at 12 o'clock and sweeps CLOCKWISE
// (top → right → bottom → left). Parametrized so direction is unambiguous:
//   x = cx + r·sin(θ),  y = cy − r·cos(θ),  θ = 2π·fraction  (θ=0 → top, θ grows clockwise)
function _ovRing(pct, color) {
  const p = Math.max(0, Math.min(100, pct)) / 100
  const cx = 65, cy = 65, r = 52
  let arc
  if (p >= 0.999) {
    arc = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10"/>`
  } else {
    const end = 2 * Math.PI * p
    const x1 = cx - r * Math.sin(end), y1 = cy - r * Math.cos(end)
    const large = p > 0.5 ? 1 : 0
    arc = `<path d="M ${cx} ${(cy - r).toFixed(2)} A ${r} ${r} 0 ${large} 0 ${x1.toFixed(2)} ${y1.toFixed(2)}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round"/>`
  }
  return `<svg viewBox="0 0 130 130" width="150" height="150" class="ov-ring">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="10"/>
    ${arc}
    <text x="65" y="72" text-anchor="middle" fill="${color}" font-size="27" font-weight="800" font-family="var(--font-mono)">${(p * 100).toFixed(1)}%</text>
  </svg>`
}

// Real token icon (same renderer as mobile), wrapped in a sized circle.
function _ovCoinIcon(coin) {
  const inner = (typeof window !== 'undefined' && window._coinIconHtml)
    ? window._coinIconHtml(coin)
    : esc((String(coin)[0] || '?').toUpperCase())
  return `<div class="ov-av-img">${inner}</div>`
}

function _ovPositionRow(p, allMids, tpslMap = {}) {
  const szi    = parseFloat(p.szi ?? 0)
  const isLong = szi > 0
  const mark   = parseFloat(allMids?.[p.coin] ?? 0)
  const entry  = parseFloat(p.entryPx ?? 0)
  const liq    = parseFloat(p.liquidationPx ?? 0)
  const uPnl   = parseFloat(p.unrealizedPnl ?? 0)
  const roe    = parseFloat(p.returnOnEquity ?? 0) * 100
  const lev    = p.leverage?.value ?? 1
  const isIso  = (p.leverage?.type ?? 'cross') === 'isolated'
  const levT   = isIso ? 'iso' : 'cross'
  const side   = isLong ? 'LONG' : 'SHORT'
  const sideCls = isLong ? 'pos' : 'neg'
  const notional = parseFloat(p.positionValue ?? 0) || Math.abs(szi) * mark
  const margin   = parseFloat(p.marginUsed ?? 0)
  const funding  = -parseFloat(p.cumFunding?.sinceOpen ?? 0)   // positive = received
  // Health: liq-distance (100% at entry → 0% at liq)
  let hp = 100
  if (liq > 0 && entry > 0 && mark > 0) {
    if (isLong && entry > liq)       hp = Math.max(0, Math.min(100, (mark - liq) / (entry - liq) * 100))
    else if (!isLong && liq > entry) hp = Math.max(0, Math.min(100, (liq - mark) / (liq - entry) * 100))
  }
  const hpColor = hp > 70 ? 'var(--green)' : hp > 40 ? 'var(--yellow)' : hp > 20 ? '#ff9444' : 'var(--red)'
  const pnlCls  = uPnl >= 0 ? 'pos' : 'neg'
  const sid = String(p.coin).replace(/[^a-z0-9]/gi, '_')
  const t   = tpslMap[p.coin] ?? {}
  const px  = mark || entry
  const open = _ovExpanded.has(sid)
  const actions = `
    <div class="ov-pos-actions" id="ovpa-${sid}" style="display:${open ? 'flex' : 'none'}">
      <button class="manage-btn" onclick="event.stopPropagation();window.__openEditModal('${esc(p.coin)}','${side}','${p.szi}','${p.entryPx}',${t.tpPx ?? 0},${t.slPx ?? 0},${t.tpOid ?? 0},${t.slOid ?? 0},${lev})">✏ TP/SL · Leverage</button>
      <button class="manage-btn" onclick="event.stopPropagation();window.__openShareCard({coin:'${esc(p.coin)}',title:'${esc(_lbl(p.coin))}',side:'${side}',lev:${lev},roePct:${roe.toFixed(2)},entry:'$${fmtPrice(entry)}',mark:'$${fmtPrice(mark)}'})">↗ Share PnL</button>
      ${isIso ? `<button class="manage-btn margin" onclick="event.stopPropagation();window.__openAdjustMarginModal('${esc(p.coin)}','${side}',${margin},${notional},${lev})">⊕ Margin</button>
      <button class="manage-btn" onclick="event.stopPropagation();window.__openGuardModal('liqguard','${esc(p.coin)}','${side}')">🛡 Liq Guard</button>
      <button class="manage-btn" onclick="event.stopPropagation();window.__openGuardModal('levbrake','${esc(p.coin)}','${side}')">🛑 Lev Brake</button>` : ''}
    </div>`
  return `<div class="ov-pos-item">
    <div class="ov-pos-row" onclick="window.__ovTogglePos('${sid}')">
      <span class="ov-pos-mkt">${_ovCoinIcon(p.coin)}<span class="ov-pos-info"><b>${esc(_lbl(p.coin))}</b><i>${lev}× ${levT}</i></span></span>
      <span class="ov-side-badge ${sideCls}">${side}</span>
      <span class="ov-r ov-pos-size"><b>${fmtSize(Math.abs(szi))}</b><i>$${fmtUSD(notional)}</i></span>
      <span class="ov-r mono">$${fmtPrice(entry)}</span>
      <span class="ov-r mono">$${fmtPrice(mark)}</span>
      <span class="ov-r mono neg">${liq > 0 ? '$' + fmtPrice(liq) : '—'}</span>
      <span class="ov-r mono">$${fmtUSD(margin)}</span>
      <span class="ov-r mono ${funding >= 0 ? 'pos' : 'neg'}">${funding >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(funding))}</span>
      <span class="ov-r ov-hp"><span class="ov-hp-bar"><i style="width:${hp.toFixed(0)}%;background:${hpColor}"></i></span><em>${hp.toFixed(0)}%</em></span>
      <span class="ov-r mono ${pnlCls}">${fmtPnL(uPnl).text}<i class="ov-roe">${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%</i></span>
      <span class="ov-r"><button class="ov-close-x" title="Close position" onclick="event.stopPropagation();window.__openCloseModal('${esc(p.coin)}','${side}','${p.szi}',${px})">✕</button></span>
    </div>
    ${actions}
  </div>`
}

window.__ovTogglePos = function(sid) {
  const el = document.getElementById('ovpa-' + sid)
  const open = !_ovExpanded.has(sid)
  if (open) _ovExpanded.add(sid); else _ovExpanded.delete(sid)
  if (el) el.style.display = open ? 'flex' : 'none'
}

// ── Overview positions — sortable column headers ────────────────────────────
const _OV_SORT_COLS = [
  ['market', 'Market', false], ['side', 'Side', false], ['size', 'Size', true],
  ['entry', 'Entry', true], ['mark', 'Mark', true], ['liq', 'Liq. Price', true],
  ['margin', 'Margin', true], ['funding', 'Funding', true], ['health', 'Health', true], ['pnl', 'PnL', true],
]

function _ovPosSortVal(ap, key, allMids) {
  const p    = ap.position
  const szi  = parseFloat(p.szi ?? 0)
  const mark = parseFloat(allMids?.[p.coin] ?? 0)
  const entry = parseFloat(p.entryPx ?? 0)
  const liq   = parseFloat(p.liquidationPx ?? 0)
  switch (key) {
    case 'market':  return String(_lbl(p.coin)).toUpperCase()
    case 'side':    return szi >= 0 ? 1 : 0
    case 'size':    return parseFloat(p.positionValue ?? 0) || Math.abs(szi) * mark
    case 'entry':   return entry
    case 'mark':    return mark
    case 'liq':     return liq
    case 'margin':  return parseFloat(p.marginUsed ?? 0)
    case 'funding': return -parseFloat(p.cumFunding?.sinceOpen ?? 0)
    case 'health': {
      const isLong = szi > 0; let hp = 100
      if (liq > 0 && entry > 0 && mark > 0) {
        if (isLong && entry > liq)       hp = Math.max(0, Math.min(100, (mark - liq) / (entry - liq) * 100))
        else if (!isLong && liq > entry) hp = Math.max(0, Math.min(100, (liq - mark) / (liq - entry) * 100))
      }
      return hp
    }
    case 'pnl':     return parseFloat(p.unrealizedPnl ?? 0)
    default:        return Math.abs(parseFloat(p.positionValue ?? 0))
  }
}

function _ovBuildPosBody(positions, allMids, tpslMap) {
  if (!positions.length) return `<div class="ov-empty">No open positions</div>`
  const sorted = [...positions].sort((a, b) => {
    if (!_ovPosSortKey) return Math.abs(parseFloat(b.position.positionValue ?? 0)) - Math.abs(parseFloat(a.position.positionValue ?? 0))
    const av = _ovPosSortVal(a, _ovPosSortKey, allMids), bv = _ovPosSortVal(b, _ovPosSortKey, allMids)
    if (typeof av === 'string') return av.localeCompare(bv) * _ovPosSortDir
    return (av - bv) * _ovPosSortDir
  })
  const head = `<div class="ov-pos-head">
    ${_OV_SORT_COLS.map(([k, l, r]) => `<span class="ov-sort${r ? ' ov-r' : ''}" onclick="window.__ovSortPos('${k}')">${l}${_ovSortArr(k, _ovPosSortKey, _ovPosSortDir)}</span>`).join('')}
    <span></span>
  </div>`
  return `${head}<div class="ov-pos-scroll">${sorted.map(ap => _ovPositionRow(ap.position, allMids, tpslMap)).join('')}</div>`
}

// Sort indicator: accent ▲/▼ on the active column, faint ⇅ on the rest so the
// feature is discoverable even before the user has clicked anything.
function _ovSortArr(key, activeKey, dir) {
  return key === activeKey
    ? `<i class="ov-sort-arr">${dir === 1 ? '▲' : '▼'}</i>`
    : `<i class="ov-sort-arr ov-sort-idle">⇅</i>`
}

window.__ovSortPos = function(key) {
  if (_ovPosSortKey === key) _ovPosSortDir *= -1
  else { _ovPosSortKey = key; _ovPosSortDir = (key === 'market' || key === 'side') ? 1 : -1 }
  if (!_ovPosData) return
  _ovPosBody = _ovBuildPosBody(_ovPosData.positions, _ovPosData.allMids, _ovPosData.tpslMap)
  if (_ovPosTab === 'positions') { const b = document.getElementById('ovPosBody'); if (b) b.innerHTML = _ovPosBody }
}

// ── Overview orders — sortable + extra columns (matches mobile detail) ───────
const _OV_ORD_COLS = [
  ['market', 'Market', false], ['side', 'Type', false], ['size', 'Size', true],
  ['price', 'Price', true], ['value', 'Value', true], ['pnl', 'Est. PnL', true],
]

function _ovOrdSortVal(o, key, allMids) {
  const trig = parseFloat(o.triggerPx ?? 0)
  const px   = trig > 0 ? trig : parseFloat(o.limitPx ?? 0)
  const sz   = parseFloat(o.sz ?? 0)
  switch (key) {
    case 'market': return String(_lbl(o.coin)).toUpperCase()
    case 'side': {
      const isBuy = o.side === 'B' || /buy|long/i.test(o.side ?? '')
      const ot = o.orderType ?? ''
      const isTp = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
      const isSl = ot.startsWith('Stop') || o.triggerCondition === 'sl'
      return isTp ? 3 : isSl ? 2 : (isBuy ? 1 : 0)
    }
    case 'size':  return sz
    case 'price': return px
    case 'value': return px * sz
    case 'pnl':   return _ovOrderEstPnl(o, allMids) ?? -Infinity
    default:      return px * sz
  }
}

// Estimated PnL if this order fills, vs the current open position's entry. Mirrors
// the mobile order detail: meaningful for TP/SL AND reduce-only orders (e.g. a limit
// take-profit ladder) tied to a position. Returns null otherwise.
function _ovOrderEstPnl(o, allMids) {
  const ot = o.orderType ?? ''
  const isTp = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
  const isSl = ot.startsWith('Stop') || o.triggerCondition === 'sl'
  if (!isTp && !isSl && !o.reduceOnly) return null
  const pos = _ovPosData?.positions?.find(ap => ap.position.coin === o.coin)?.position
  if (!pos) return null
  const entry = parseFloat(pos.entryPx ?? 0)
  const trig  = parseFloat(o.triggerPx ?? 0) || parseFloat(o.limitPx ?? 0)
  const sz    = parseFloat(o.sz ?? 0) || Math.abs(parseFloat(pos.szi ?? 0))
  if (!entry || !trig || !sz) return null
  const isLong = parseFloat(pos.szi ?? 0) > 0
  return (isLong ? (trig - entry) : (entry - trig)) * sz
}

function _ovBuildOrdBody(orders, allMids) {
  if (!orders?.length) return `<div class="ov-empty">No open orders</div>`
  const sorted = [...orders].sort((a, b) => {
    if (!_ovOrdSortKey) return 0
    const av = _ovOrdSortVal(a, _ovOrdSortKey, allMids), bv = _ovOrdSortVal(b, _ovOrdSortKey, allMids)
    if (typeof av === 'string') return av.localeCompare(bv) * _ovOrdSortDir
    return (av - bv) * _ovOrdSortDir
  })
  const head = `<div class="ov-ord-head">
    ${_OV_ORD_COLS.map(([k, l, r]) => `<span class="ov-sort${r ? ' ov-r' : ''}" onclick="window.__ovSortOrd('${k}')">${l}${_ovSortArr(k, _ovOrdSortKey, _ovOrdSortDir)}</span>`).join('')}
    <span class="ov-r"></span>
  </div>`
  return `${head}<div class="ov-pos-scroll">${_ovOrderRows(sorted, allMids)}</div>`
}

window.__ovSortOrd = function(key) {
  if (_ovOrdSortKey === key) _ovOrdSortDir *= -1
  else { _ovOrdSortKey = key; _ovOrdSortDir = (key === 'market' || key === 'side') ? 1 : -1 }
  if (!_ovOrdData) return
  _ovOrdBody = _ovBuildOrdBody(_ovOrdData.orders, _ovOrdData.allMids)
  if (_ovPosTab === 'orders') { const b = document.getElementById('ovPosBody'); if (b) b.innerHTML = _ovOrdBody }
}

function _ovOrderRows(orders, allMids) {
  return (orders || []).map(o => {
    const trig  = parseFloat(o.triggerPx ?? 0)
    const px    = trig > 0 ? trig : parseFloat(o.limitPx ?? 0)
    const sz    = parseFloat(o.sz ?? 0)
    const isBuy = o.side === 'B' || /buy|long/i.test(o.side ?? '')
    const ot    = o.orderType ?? 'Limit'
    const val   = px * sz
    const isTp  = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl  = ot.startsWith('Stop') || o.triggerCondition === 'sl'
    const typeLabel = isTp ? 'TP' : isSl ? 'SL' : (isBuy ? 'BUY' : 'SELL')
    const typeCls   = isTp ? 'pos' : isSl ? 'neg' : (isBuy ? 'pos' : 'neg')
    const estPnl    = _ovOrderEstPnl(o, allMids)
    const pnlHtml   = estPnl == null
      ? `<span class="ov-r mono" style="color:var(--muted)">—</span>`
      : `<span class="ov-r mono ${estPnl >= 0 ? 'pos' : 'neg'}">${fmtPnL(estPnl).text}</span>`
    return `<div class="ov-ord-row">
      <span class="ov-pos-mkt">${_ovCoinIcon(o.coin)}<span class="ov-pos-info"><b>${esc(_lbl(o.coin))}</b><i>${esc(ot)}</i></span></span>
      <span class="ov-side-badge ${typeCls}">${typeLabel}</span>
      <span class="ov-r mono">${fmtSize(sz)}</span>
      <span class="ov-r mono">$${fmtPrice(px)}</span>
      <span class="ov-r mono">$${fmtUSD(val)}</span>
      ${pnlHtml}
      <span class="ov-r"><button class="ov-cancel" onclick="event.stopPropagation();window.__cancelOrder('${esc(o.coin)}',${o.oid},false,this)">✕</button></span>
    </div>`
  }).join('')
}

function _ovRecentActivity(fills) {
  // Collapse partial fills of one order (same as the History tab) so e.g. 3 partial
  // PURR fills show as a single "Opened PURR long" row, not three.
  const grouped = aggregateByHash(fills || []).sort((a, b) => b.time - a.time)
  const items = grouped.slice(0, 5).map(f => {
    const dir   = (f.dir ?? '').toLowerCase()
    const isClose = dir.includes('close') || f.closedPnl !== 0
    const sideWord = dir.includes('long') ? 'long' : dir.includes('short') ? 'short' : (f.side === 'BUY' ? 'long' : 'short')
    const verb  = isClose ? 'Closed' : 'Opened'
    const subCls = isClose && f.closedPnl ? (f.closedPnl >= 0 ? 'pos' : 'neg') : ''
    const sub   = isClose && f.closedPnl ? fmtPnL(f.closedPnl).text + ' realized'
               : '$' + fmtUSD(f.notional) + ' notional'
    const ago   = _ovTimeAgo(f.time)
    return `<div class="ov-act-row">
      ${_ovCoinIcon(f.coin)}
      <span class="ov-act-main"><b>${verb} ${esc(_lbl(f.coin))} ${sideWord}</b><i class="${subCls}">${esc(sub)}</i></span>
      <span class="ov-act-ago">${ago}</span>
    </div>`
  })
  return items.join('')
}

function _ovTimeAgo(t) {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 90)      return Math.round(s) + 's'
  if (s < 5400)    return Math.round(s / 60) + 'm'
  if (s < 86400)   return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}

// Range switcher — re-render chart + period change only
window.__ovSetRange = function(label) {
  _ovPeriod = _OV_PERIOD_KEY[label] || 'week'
  document.querySelectorAll('#ovRange .ov-range-btn').forEach(b => b.classList.toggle('active', b.textContent === label))
  const chg = _ovComputeChange(_ovPeriod)
  const pill = document.getElementById('ovChgPill')
  if (pill) {
    const up = chg.diff >= 0
    pill.className = 'ov-chg ' + (up ? 'pos' : 'neg')
    pill.textContent = `${up ? '▲' : '▼'} ${up ? '+$' : '-$'}${fmtUSD(Math.abs(chg.diff))} · ${up ? '+' : ''}${chg.pct.toFixed(2)}%`
  }
  try { renderOverviewChart(_ovPortfolio, _ovPeriod, _ovChartType, _ovFills) } catch {}
}

// Outcome (prediction) holdings live in main.js — access via window bridges.
function _ovOcCount() { return (typeof window !== 'undefined' && window.__ovOutcomeHoldings) ? window.__ovOutcomeHoldings().length : 0 }
function _ovTabBody(tab) {
  if (tab === 'orders')   return _ovOrdBody
  if (tab === 'outcomes') return (typeof window !== 'undefined' && window.__ovBuildOcBody) ? window.__ovBuildOcBody() : `<div class="ov-empty">No outcome positions</div>`
  return _ovPosBody
}
// Fetch live outcome marks after the outcomes body is in the DOM.
function _ovRefreshOcMarks() { try { window.__ovUpdateOcMarks?.() } catch {} }

// Positions / Orders / Outcomes sub-tab switcher (one at a time)
window.__ovSetPosTab = function(tab) {
  _ovPosTab = tab
  document.querySelectorAll('.ov-postab').forEach(b => b.classList.toggle('active', b.dataset.pt === tab))
  const body = document.getElementById('ovPosBody')
  if (body) body.innerHTML = _ovTabBody(tab)
  const act = document.getElementById('ovPosAction')
  if (act) {
    act.style.display = tab === 'outcomes' ? 'none' : ''
    act.textContent = tab === 'positions' ? 'Close all' : 'Cancel all'
  }
  if (tab === 'outcomes') _ovRefreshOcMarks()
}

window.__ovPosAction = function() {
  if (_ovPosTab === 'positions') window.__closeAllPositions?.(document.getElementById('ovPosAction'))
  else                           window.__cancelAllOrders?.()
}

// Chart type switcher (Equity / Acc. PnL / Realized)
window.__ovSetChartType = function(type) {
  _ovChartType = type
  document.querySelectorAll('#ovChartTabs .ov-ct-btn').forEach(b => b.classList.toggle('active', b.dataset.ct === type))
  try { renderOverviewChart(_ovPortfolio, _ovPeriod, _ovChartType, _ovFills) } catch {}
}


// ─── SPOT TAB ────────────────────────────────────────────────────────────────
export function renderSpot(spotState, ocTokenMap = {}) {
  const bals  = (spotState.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const tbody = document.getElementById('spotTbody')

  const _sc = document.getElementById('spotCount')
  if (_sc) _sc.textContent = bals.length
  document.getElementById('spotCountBig').textContent = bals.length

  if (bals.length === 0) {
    tbody.innerHTML = emptyRow(4, '💰', 'No spot balances')
    return
  }

  tbody.innerHTML = bals.map(b => {
    const total = parseFloat(b.total)
    const hold  = parseFloat(b.hold ?? 0)
    const avail = total - hold
    return `<tr>
      <td><b>${esc(ocCoinLabel(b.coin, ocTokenMap))}</b></td>
      <td>${fmtSize(total)}</td>
      <td>${fmtSize(hold)}</td>
      <td class="pos">${fmtSize(avail)}</td>
    </tr>`
  }).join('')
}

// ─── ORDERS TAB ──────────────────────────────────────────────────────────────
// Friendly label for a coin: prediction-market "#N" codes resolve to their
// market name + side via ocTokenMap (e.g. "#2170" → "USA Yes"); else strip the
// HIP-3 dex prefix as usual.
function ocCoinLabel(coin, ocTokenMap) {
  if (typeof coin === 'string' && (coin[0] === '#' || coin[0] === '+')) {
    const t = ocTokenMap?.['#' + coin.slice(1)]
    if (t && t.name) return `${t.name} ${t.side ?? ''}`.trim()
    // Settled outcome we never cached — decode to a readable placeholder.
    if (typeof window !== 'undefined' && window._ocFallbackLabel) return window._ocFallbackLabel(coin)
  }
  return coinLabel(coin)
}

export function renderOrders(openOrders, perpState, ocTokenMap = {}) {
  const tbody = document.getElementById('ordersTbody')

  const _oc  = document.getElementById('ordCount');    if (_oc)  _oc.textContent  = openOrders.length
  const _ocb = document.getElementById('ordCountBig'); if (_ocb) _ocb.textContent = openOrders.length
  if (!tbody) return   // Orders tab removed — orders now render on the Overview

  // Update sortable headers
  const thead = document.querySelector('#ordersTable thead tr')
  if (thead) {
    const k = _ordSortKey, d = _ordSortDir
    thead.innerHTML =
      _thOrd('coin',  'Coin',  k, d) +
      '<th>Intent</th>' +
      _thOrd('size',  'Size',  k, d) +
      _thOrd('price', 'Price', k, d) +
      '<th>Margin</th><th>Expected P&amp;L</th><th>Actions</th>'
  }

  if (openOrders.length === 0) {
    tbody.innerHTML = emptyRow(7, '📋', 'No open orders')
    return
  }

  // Apply sort
  let orders = openOrders
  if (_ordSortKey) {
    orders = [...openOrders].sort((a, b) => {
      let av, bv
      if (_ordSortKey === 'coin') { av = a.coin; bv = b.coin }
      else if (_ordSortKey === 'size') { av = parseFloat(a.sz ?? 0); bv = parseFloat(b.sz ?? 0) }
      else if (_ordSortKey === 'price') {
        // triggerPx is "0.0" (string, not null) on plain limit orders — `??`
        // never falls through, so use numeric-or to pick the real price
        av = parseFloat(a.triggerPx ?? 0) || parseFloat(a.limitPx ?? 0)
        bv = parseFloat(b.triggerPx ?? 0) || parseFloat(b.limitPx ?? 0)
      }
      return typeof av === 'string'
        ? av.localeCompare(bv) * _ordSortDir
        : (av - bv) * _ordSortDir
    })
  }

  // Build a quick lookup: coin → position data
  const posMap = {}
  for (const ap of (perpState?.assetPositions ?? [])) {
    const p = ap.position ?? ap
    posMap[p.coin] = p
  }

  tbody.innerHTML = orders.map(o => {
    const isTrigger = o.isTrigger || (parseFloat(o.triggerPx ?? 0) > 0)
    const triggerPx = parseFloat(o.triggerPx ?? 0)
    const limitPx   = parseFloat(o.limitPx  ?? 0)
    const displayPx = isTrigger && triggerPx > 0 ? triggerPx : limitPx
    const sz        = parseFloat(o.sz ?? 0)

    // ── Intent badge — use frontendOpenOrders' explicit orderType ────────────
    // orderType from frontendOpenOrders: "Take Profit Market", "Take Profit Limit",
    // "Stop Market", "Stop Limit", "Limit", "Market"
    const orderType = o.orderType ?? ''
    const isTp    = orderType.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl    = orderType.startsWith('Stop')        || o.triggerCondition === 'sl'
    const isBuy   = o.side === 'B'

    let intentLabel, intentCls
    if (isTp) {
      intentLabel = 'Take Profit'; intentCls = 'badge-tp'
    } else if (isSl) {
      intentLabel = 'Stop Loss';   intentCls = 'badge-sl'
    } else if (o.reduceOnly) {
      intentLabel = isBuy ? 'Close Short' : 'Close Long'
      intentCls   = 'badge-reduce'
    } else {
      intentLabel = isBuy ? 'Open Long' : 'Open Short'
      intentCls   = isBuy ? 'badge-long' : 'badge-short'
    }

    // Use the exact orderType string HL provides (e.g. "Take Profit Limit", "Stop Market")
    const orderKind = orderType || (isTrigger
      ? (limitPx > 0 && limitPx !== triggerPx ? 'Stop Limit' : 'Stop Market')
      : 'Limit')
    // Strip "Take Profit" / "Stop" prefix for compact mobile subtitle
    const orderKindShort = orderKind.replace(/^(Take Profit|Stop)\s*/i, '') || orderKind

    const priceDetail = isTrigger && triggerPx > 0 && limitPx > 0 && limitPx !== triggerPx
      ? `<div style="color:var(--muted);font-size:9px;margin-top:2px">Entry $${fmtPrice(limitPx)}</div>`
      : ''

    // ── Margin & P&L if hit ───────────────────────────────────────────────────
    const pos      = posMap[o.coin]
    const entryPx  = pos ? parseFloat(pos.entryPx ?? 0) : 0
    const posSzi   = pos ? parseFloat(pos.szi   ?? 0) : 0
    const isLong   = posSzi > 0
    // For position-level TP/SL, HL sets sz="0.0" meaning "close entire position".
    // Use actual position size as the effective size for P&L calculation.
    const effectiveSz = sz > 0 ? sz : Math.abs(posSzi)

    // Margin: for reduce-only orders use position's marginUsed;
    // for open orders estimate from notional / leverage
    let marginHtml = '<span style="color:var(--muted)">—</span>'
    if (pos && (isTp || isSl || o.reduceOnly)) {
      marginHtml = `$${fmtUSD(parseFloat(pos.marginUsed ?? 0))}`
    }

    // P&L if hit: only meaningful for TP/SL and reduce-only orders tied to a position
    let pnlHtml = '<span style="color:var(--muted)">—</span>'
    if (entryPx > 0 && displayPx > 0 && (isTp || isSl || o.reduceOnly)) {
      const pnl = isLong
        ? (displayPx - entryPx) * effectiveSz
        : (entryPx - displayPx) * effectiveSz
      const cls  = pnl >= 0 ? 'pos' : 'neg'
      const sign = pnl >= 0 ? '+' : ''
      pnlHtml = `<span class="${cls}" style="font-family:'JetBrains Mono',monospace;font-weight:700">${sign}$${fmtUSD(Math.abs(pnl))}</span>`
      // Show % ROE on margin
      if (pos?.marginUsed) {
        const margin = parseFloat(pos.marginUsed)
        const roe    = margin > 0 ? (pnl / margin) * 100 : 0
        const rSign  = roe >= 0 ? '+' : ''
        pnlHtml += `<div style="font-size:9px;color:var(--muted);margin-top:1px">${rSign}${roe.toFixed(1)}% on margin</div>`
      }
    }

    const orderValue = effectiveSz * displayPx
    const eid = `ord-expand-${o.oid}`

    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="row-expand-btn" onclick="window.__toggleRowExpand('${eid}')" aria-label="expand">&#8964;</button>
          <b>${esc(ocCoinLabel(o.coin, ocTokenMap))}</b>
        </div>
      </td>
      <td><span class="badge ${intentCls}">${esc(intentLabel)}</span></td>
      <td>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(ocCoinLabel(o.coin, ocTokenMap))}<div style="font-size:10px;color:var(--muted);margin-top:2px">Value $${fmtUSD(orderValue)}</div></td>
      <td>$${fmtPrice(displayPx)}${priceDetail}</td>
      <td style="font-family:'JetBrains Mono',monospace">${marginHtml}</td>
      <td>${pnlHtml}</td>
      <td>
        <button class="manage-btn"
          onclick="window.__openEditOrderModal('${esc(o.coin)}',${o.oid},${o.side === 'B'},${effectiveSz},${displayPx},'${isTp ? 'tp' : isSl ? 'sl' : ''}',${isTrigger})">
          ✏ Edit
        </button>
        <button class="manage-btn close"
          onclick="window.__cancelOrder('${esc(o.coin)}', ${o.oid}, ${!!o.isPositionTpsl})">
          ✕ Cancel
        </button>
      </td>
    </tr>
    <tr class="row-expand-detail" id="${eid}">
      <td colspan="7">
        <div class="row-expand-grid">
          <div class="row-expand-item"><span>Size</span><span>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(ocCoinLabel(o.coin, ocTokenMap))}</span></div>
          <div class="row-expand-item"><span>Order Value</span><span>$${fmtUSD(orderValue)}</span></div>
          <div class="row-expand-item"><span>Margin</span><span>${marginHtml}</span></div>
          <div class="row-expand-item"><span>P&L if Hit</span><span>${pnlHtml}</span></div>
        </div>
      </td>
    </tr>`
  }).join('')
}

// ─── TRADE HISTORY TAB ───────────────────────────────────────────────────────
// Collapse partial fills of the same order (shared hash) into one trade row.
export function aggregateByHash(fills) {
  const groups = new Map()
  for (const f of fills) {
    // Collapse partial fills of ONE order. Group by oid (unique per order); HL returns
    // hash=0x0…0 for a whole class of fills, so grouping by hash merged unrelated orders
    // into a phantom row at a blended price. Fall back to tid (unique per fill) so a
    // missing oid never merges distinct fills.
    const key = f.oid != null ? `oid_${f.oid}`
      : (f.hash && !/^0x0+$/.test(f.hash) ? f.hash : `tid_${f.tid ?? f.time + '_' + f.coin + '_' + f.px}`)
    if (!groups.has(key)) {
      groups.set(key, { time: f.time, timeStr: f.timeStr, coin: f.coin, side: f.side,
        dir: f.dir, sz: 0, notional: 0, fee: 0, feeToken: f.feeToken, closedPnl: 0, hash: f.hash })
    }
    const g = groups.get(key)
    g.sz += f.sz; g.notional += f.notional; g.fee += f.fee; g.closedPnl += f.closedPnl
    if (f.time > g.time) { g.time = f.time; g.timeStr = f.timeStr }
  }
  return Array.from(groups.values()).map(g => ({ ...g, px: g.sz > 0 ? g.notional / g.sz : 0 }))
}

export function renderTrades(fills) {
  const tbody = document.getElementById('tradesTbody')

  const trades = aggregateByHash(fills)

  document.getElementById('fillCount').textContent    = trades.length
  document.getElementById('fillCountBig').textContent = trades.length

  if (trades.length === 0) {
    tbody.innerHTML = emptyRow(7, '📈', 'No trade history')
    return
  }

  const LIMIT  = window.innerWidth <= 768 ? 10 : 20
  const sorted = trades.sort((a, b) => b.time - a.time)
  const pages  = Math.ceil(sorted.length / LIMIT)
  _tradesPage  = Math.min(_tradesPage, pages - 1)
  const start  = _tradesPage * LIMIT
  const visible = sorted.slice(start, start + LIMIT)

  const isMobile = window.innerWidth <= 768

  const rowHtml = visible.map(t => {
    const hasPnl  = t.closedPnl !== 0
    const netPnl  = t.closedPnl - t.fee
    const pnl     = fmtPnL(netPnl)
    const dir     = t.dir || (t.side === 'BUY' ? 'Open Long' : 'Open Short')
    const isClose = dir.toLowerCase().includes('close')
    const eid     = `fill-expand-${t.hash || t.time + '_' + t.coin}`
    const sizeCell = `${fmtSize(t.sz)}<div style="font-size:10px;color:var(--muted)">$${fmtUSD(t.notional)}</div>`
    // Share card for a closed trade: derive entry/exit + return-on-cost from the fill.
    // Position side = opposite of a closing fill's side (a sell closes a long);
    // outcome positions are always long (settlement fills have no long/short word).
    const _isOc     = typeof t.coin === 'string' && (t.coin[0] === '#' || t.coin[0] === '+')
    const _sideLong = _isOc ? true
                    : /long/i.test(dir)  ? true
                    : /short/i.test(dir) ? false
                    : t.side !== 'BUY'
    const _cost     = _sideLong ? (t.notional - t.closedPnl) : (t.notional + t.closedPnl)
    const _entryPx  = (t.sz > 0 && _cost > 0) ? _cost / t.sz : t.px
    const _priceRet = _cost > 0 ? (t.closedPnl / _cost) * 100 : 0
    const _entryStr = _isOc ? _entryPx.toFixed(5) : '$' + fmtPrice(_entryPx)
    const _markStr  = _isOc ? Number(t.px).toFixed(5) : '$' + fmtPrice(t.px)
    const _sideStr  = _isOc ? '' : (_sideLong ? 'LONG' : 'SHORT')
    const _shareCall = `window.__shareTrade('${_jss(t.coin)}',{title:'${_jss(_lbl(t.coin))}',side:'${_sideStr}',roePct:${_priceRet.toFixed(2)},entry:'${_entryStr}',mark:'${_markStr}'})`
    const shareBtn  = hasPnl ? ` <button class="trade-share-btn" title="Share this trade" onclick="event.stopPropagation();${_shareCall}">↗</button>` : ''
    const tapExpand = isMobile ? `onclick="window.__toggleRowExpand('${eid}')" style="cursor:pointer"` : ''
    const mainRow  = `<tr ${tapExpand}>
      <td style="color:var(--muted);white-space:nowrap;font-size:11px">
        <div style="display:flex;align-items:center;gap:6px">
          ${isMobile ? `<span class="row-expand-btn" id="btn-${eid}">&#8964;</span>` : ''}
          ${esc(t.timeStr)}
        </div>
      </td>
      <td><b>${esc(_lbl(t.coin))}</b></td>
      <td><span class="dir-badge ${isClose ? 'dir-close' : 'dir-open'}">${esc(dir)}</span></td>
      <td>${sizeCell}</td>
      <td>$${fmtPrice(t.px)}</td>
      <td class="${hasPnl ? pnl.cls : 'muted'}" style="white-space:nowrap">${hasPnl ? pnl.text : '—'}${isMobile ? '' : shareBtn}</td>
      <td class="neg" style="font-size:11px">-$${fmtUSD(t.fee)}</td>
    </tr>`
    const expandRow = isMobile ? `<tr class="row-expand-detail" id="${eid}">
      <td colspan="7">
        <div class="row-expand-grid">
          <div class="row-expand-item"><span>Price</span><span>$${fmtPrice(t.px)}</span></div>
          <div class="row-expand-item"><span>Size</span><span>${fmtSize(t.sz)} ${esc(_lbl(t.coin))}<div style="font-size:10px;color:var(--muted)">$${fmtUSD(t.notional)}</div></span></div>
          <div class="row-expand-item"><span>Closed PnL</span><span class="${fmtPnL(t.closedPnl).cls}">${hasPnl ? fmtPnL(t.closedPnl).text : '—'}</span></div>
          <div class="row-expand-item"><span>Fee</span><span class="neg">-$${fmtUSD(t.fee)} ${esc(t.feeToken ?? 'USDC')}</span></div>
          <div class="row-expand-item"><span>Net PnL</span><span class="${fmtPnL(netPnl).cls}">${hasPnl ? fmtPnL(netPnl).text : '—'}</span></div>
          <div class="row-expand-item"><span>Direction</span><span class="dir-badge ${isClose ? 'dir-close' : 'dir-open'}">${esc(dir)}</span></div>
        </div>
        ${hasPnl ? `<button class="trade-share-btn-full" onclick="event.stopPropagation();${_shareCall}">↗ Share this trade</button>` : ''}
      </td>
    </tr>` : ''
    return mainRow + expandRow
  }).join('')

  const paginationRow = pages > 1
    ? `<tr><td colspan="7" style="text-align:center;padding:10px 0">
        <div style="display:inline-flex;align-items:center;gap:12px">
          <button class="btn-sm" onclick="window.__tradesPrevPage()" ${_tradesPage === 0 ? 'disabled' : ''} style="padding:5px 10px">&#8249;</button>
          <span style="font-size:11px;color:var(--muted);font-family:'JetBrains Mono',monospace">${_tradesPage + 1} / ${pages}</span>
          <button class="btn-sm" onclick="window.__tradesNextPage()" ${_tradesPage >= pages - 1 ? 'disabled' : ''} style="padding:5px 10px">&#8250;</button>
        </div>
       </td></tr>`
    : ''

  tbody.innerHTML = rowHtml + paginationRow
}


// ─── PORTFOLIO STATS ──────────────────────────────────────────────────────────
export function renderPortfolioStats({ perpState, spotState, fills, funding, portfolio = [], webData = null }) {
  // HL "Portfolio Value" — the portfolio endpoint is HL's own unified account value
  const _perpVal      = parseFloat((perpState.marginSummary ?? {}).accountValue ?? 0)
  const _spotUSDCTot  = parseFloat((spotState?.balances ?? []).find(b => b.coin === 'USDC')?.total ?? 0)
  const accountValue  = liveAccountValue(portfolio, _perpVal, _spotUSDCTot)

  const totalUnrPnl  = (perpState.assetPositions ?? []).reduce(
    (s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0
  )
  const realizedPnl  = fills.reduce((s, f) => s + f.closedPnl, 0)

  // Withdrawable: perp withdrawable + free spot USDC (matches overview)
  const perpWdraw    = parseFloat(perpState.withdrawable ?? 0)
  const spotUSDC     = (spotState?.balances ?? []).find(b => b.coin === 'USDC')
  const spotUSDCFree = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
  const withdrawable = perpWdraw + spotUSDCFree

  // Health = 100 − HL's Unified Account Ratio (maint margin / unified USDC balance)
  const cms          = perpState.crossMarginSummary ?? {}
  const marginUsed   = parseFloat(cms.totalMarginUsed ?? 0)
  const maintMargin  = parseFloat(perpState.crossMaintenanceMarginUsed ?? 0)
  const _hBase       = _spotUSDCTot > 0 ? _spotUSDCTot : _perpVal
  const healthPct    = _hBase > 0
    ? Math.max(0, (1 - maintMargin / _hBase) * 100)
    : 0
  const healthStr    = accountValue > 0 ? healthPct.toFixed(1) + '%' : '—'
  const healthCls    = healthPct > 60 ? 'pos' : healthPct > 30 ? 'neu' : 'neg'

  const stats = [
    {
      label: 'Account Value',
      value: '$' + fmtUSD(accountValue),
      sub:   'Total perp equity',
      cls:   'neu',
    },
    {
      label: 'Unrealized PnL',
      value: fmtPnL(totalUnrPnl).text,
      sub:   'Open positions mark-to-market',
      cls:   fmtPnL(totalUnrPnl).cls,
    },
    {
      label: 'Realized PnL',
      value: fmtPnL(realizedPnl).text,
      sub:   'Sum of all closed trades',
      cls:   fmtPnL(realizedPnl).cls,
    },
    {
      label: 'Withdrawable',
      value: '$' + fmtUSD(withdrawable),
      sub:   'Perp + free spot USDC',
      cls:   'neu',
    },
    {
      label: 'Account Health',
      value: healthStr,
      sub:   'Equity above maintenance margin',
      cls:   healthCls,
    },
  ]

  document.getElementById('portfolioStats').innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value ${s.cls}">${esc(s.value)}</div>
      ${s.sub ? `<div class="stat-sub">${esc(s.sub)}</div>` : ''}
    </div>`).join('')
}

// ─── MARKETS — POKEMON CARD GRID ─────────────────────────────────────────────

const COIN_COLORS = {
  BTC:   '#f7931a', ETH:   '#627eea', SOL:   '#9945ff',
  HYPE:  '#00ffcc', BNB:   '#f0b90b', XRP:   '#0085c0',
  DOGE:  '#c2a633', AVAX:  '#e84142', MATIC: '#8247e5',
  LINK:  '#2a5ada', UNI:   '#ff007a', PEPE:  '#3d9e40',
  WIF:   '#e17b3e', BONK:  '#f5850c', SUI:   '#4da2ff',
  ARB:   '#28a0f0', OP:    '#ff0420', INJ:   '#00c2ff',
  TIA:   '#7b2fff', SEI:   '#9e1aff', APT:   '#00c2a8',
  NEAR:  '#00c08b', FTM:   '#1969ff', ATOM:  '#6f4cff',
}

function coinColor(coin) {
  return COIN_COLORS[coin] ?? '#00ffcc'
}

function coinLogoUrl(coin) {
  return `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/${coin.toLowerCase()}.png`
}

export function computeCoinStats(coin, coinFills, price) {
  let totalPnl = 0, volume = 0

  // Group closing fills by 1h bucket to avoid counting partial fills as separate trades
  const ONE_H  = 60 * 60 * 1000
  const buckets = {}  // key: `side_bucket` → { side: 'long'|'short', netPnl }

  for (const f of coinFills) {
    volume   += f.notional
    totalPnl += f.closedPnl

    const dir     = (f.dir ?? '').toLowerCase()
    const isClose = f.closedPnl !== 0 || dir.includes('close')
    if (!isClose) continue

    const wasLong  = dir.includes('close long')  || (!dir.includes('short') && f.rawSide === 'A')
    const wasShort = dir.includes('close short') || (dir.includes('short') && f.rawSide === 'B')
    if (!wasLong && !wasShort) continue

    const side   = wasLong ? 'long' : 'short'
    const bucket = Math.floor(f.time / ONE_H)
    const key    = `${side}_${bucket}`
    if (!buckets[key]) buckets[key] = { side, netPnl: 0 }
    buckets[key].netPnl += f.closedPnl
  }

  let longs = 0, shorts = 0, longsWon = 0, shortsWon = 0
  for (const b of Object.values(buckets)) {
    if (b.side === 'long')  { longs++;  if (b.netPnl > 0) longsWon++ }
    if (b.side === 'short') { shorts++; if (b.netPnl > 0) shortsWon++ }
  }

  const avgHoldMs = computeAvgHoldTime(coinFills)
  return { coin, price, longs, shorts, longsWon, shortsWon, totalPnl, volume, fills: coinFills.length, avgHoldMs }
}

export function renderCoinCard(stats, _price, isSearchResult = false) {
  const color   = coinColor(stats.coin)
  const logo    = coinLogoUrl(stats.coin)
  const pnlCls  = stats.totalPnl >= 0 ? 'pos' : 'neg'
  const pnlSign = stats.totalPnl >= 0 ? '+' : '-'
  const id      = isSearchResult ? 'pokemonSearchCard' : ''

  return `
    <div class="pokemon-card" style="--coin-color:${color}" ${id ? `id="${id}"` : ''}
         onclick="window.__showMarketDetail('${esc(stats.coin)}', ${stats.price})">
      <div class="pokemon-card-inner">
        <div class="pokemon-logo-wrap">
          <img class="pokemon-logo-img" src="${logo}" alt="${esc(stats.coin)}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <div class="pokemon-logo-fallback" style="display:none;background:${color}22;color:${color}">
            ${esc(stats.coin.slice(0, 3))}
          </div>
        </div>
        <div class="pokemon-coin-symbol">${esc(stats.coin)}</div>
        <div class="pokemon-coin-price">$${fmtPrice(stats.price)}</div>
        <div class="pokemon-divider"></div>
        <div class="pokemon-stats-grid">
          <div class="pokemon-stat">
            <div class="pokemon-stat-label">Longs</div>
            <div class="pokemon-stat-val pos">${stats.longs}</div>
          </div>
          <div class="pokemon-stat">
            <div class="pokemon-stat-label">Shorts</div>
            <div class="pokemon-stat-val neg">${stats.shorts}</div>
          </div>
          <div class="pokemon-stat">
            <div class="pokemon-stat-label">Long Won</div>
            <div class="pokemon-stat-val pos">${stats.longsWon}</div>
          </div>
          <div class="pokemon-stat">
            <div class="pokemon-stat-label">Short Won</div>
            <div class="pokemon-stat-val neg">${stats.shortsWon}</div>
          </div>
          <div class="pokemon-stat" style="grid-column:1/-1">
            <div class="pokemon-stat-label">Avg Hold Time</div>
            <div class="pokemon-stat-val">${fmtDuration(stats.avgHoldMs)}</div>
          </div>
        </div>
        <div class="pokemon-pnl ${pnlCls}">
          ${pnlSign}$${fmtUSD(Math.abs(stats.totalPnl))}
        </div>
        <div class="pokemon-vol">Vol $${fmtCompact(stats.volume)}</div>
      </div>
    </div>`
}

function renderSearchCard() {
  return `
    <div class="pokemon-card pokemon-card-search" id="pokemonSearchCard">
      <div class="pokemon-card-inner pokemon-card-inner-search">
        <div class="pokemon-search-plus">+</div>
        <div class="pokemon-search-label">Search Asset</div>
        <input class="pokemon-search-input" id="pokemonSearchInput"
               placeholder="BTC, ETH, SOL..."
               oninput="window.__searchMarketCard(this.value)"
               autocomplete="off" spellcheck="false"/>
        <div id="pokemonSearchResults" class="pokemon-search-results"></div>
      </div>
    </div>`
}

export function renderMarkets({ fills, allMids, perpState }) {
  const el = document.getElementById('marketsGrid')
  if (!el) return

  // Build per-coin stats from fills
  const coinMap = {}
  for (const f of fills) {
    if (!coinMap[f.coin]) coinMap[f.coin] = []
    coinMap[f.coin].push(f)
  }

  const allStats = Object.entries(coinMap)
    .map(([coin, cf]) => computeCoinStats(coin, cf, parseFloat(allMids[coin] ?? 0)))

  // Top 7 by PnL (best first) — winners section
  const winners = [...allStats]
    .sort((a, b) => b.totalPnl - a.totalPnl)
    .slice(0, 7)

  // Bottom 7 by PnL (worst first) — losses section
  const losers = [...allStats]
    .sort((a, b) => a.totalPnl - b.totalPnl)
    .filter(s => s.totalPnl < 0)
    .slice(0, 7)

  el.innerHTML = `
    <div class="markets-grid">
      ${winners.map(s => renderCoinCard(s, s.price)).join('')}
      ${renderSearchCard()}
    </div>
    <div class="markets-section-divider">
      <div class="markets-section-divider-line"></div>
      <span class="markets-section-divider-label">Biggest Losses</span>
      <div class="markets-section-divider-line"></div>
    </div>
    <div class="markets-grid">
      ${losers.length > 0
        ? losers.map(s => renderCoinCard(s, s.price)).join('') + renderSearchCard()
        : '<div class="market-empty" style="grid-column:1/-1;padding:40px 0;text-align:center;color:var(--muted)">No losing trades yet</div>'
      }
    </div>`
}

// ─── TOKEN LIST (legacy — kept for search card detail) ────────────────────────
// ─── TOKEN DETAIL ─────────────────────────────────────────────────────────────
export function renderTokenDetail(coin, price, perpState, fills) {
  const positions   = perpState.assetPositions ?? []
  const myPos       = positions.find(p => p.position.coin === coin)
  const coinFills   = fills.filter(f => f.coin === coin)
  const totalVolume = coinFills.reduce((s, f) => s + f.notional, 0)
  const totalFees   = coinFills.reduce((s, f) => s + f.fee, 0)
  const closedPnl   = coinFills.reduce((s, f) => s + f.closedPnl, 0)
  const buys        = coinFills.filter(f => f.rawSide === 'B').length
  const sells       = coinFills.filter(f => f.rawSide === 'A').length
  const pnl         = fmtPnL(closedPnl)

  let posHtml = ''
  if (myPos) {
    const pos     = myPos.position
    const side    = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
    const posPnl  = fmtPnL(pos.unrealizedPnl)
    const roe     = parseFloat(pos.returnOnEquity) * 100
    posHtml = `
      <div style="margin-top:20px">
        <div class="section-title">Your Position</div>
        <div class="token-stats-grid">
          <div class="token-stat">
            <div class="token-stat-label">Side</div>
            <div class="token-stat-value">
              <span class="badge badge-${side.toLowerCase()}">${side}</span>
            </div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Size</div>
            <div class="token-stat-value">${fmtSize(pos.szi)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Entry Price</div>
            <div class="token-stat-value">$${fmtPrice(pos.entryPx)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Unr. PnL</div>
            <div class="token-stat-value ${posPnl.cls}">${posPnl.text}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">ROE</div>
            <div class="token-stat-value ${roe >= 0 ? 'pos' : 'neg'}">${fmtPct(roe, true)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Liq. Price</div>
            <div class="token-stat-value neg">$${fmtPrice(pos.liquidationPx ?? 0)}</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Leverage</div>
            <div class="token-stat-value">${pos.leverage.value}x</div>
          </div>
          <div class="token-stat">
            <div class="token-stat-label">Margin Used</div>
            <div class="token-stat-value">$${fmtUSD(pos.marginUsed)}</div>
          </div>
        </div>
      </div>`
  }

  document.getElementById('tokenDetailCard').innerHTML = `
    <div class="token-card">
      <div class="token-name">${esc(coin)}</div>
      <div style="color:var(--muted);font-size:12px;font-family:'JetBrains Mono',monospace">PERPETUAL / USDC</div>
      <div class="token-price">$${fmtPrice(price)}</div>
      <div class="token-stats-grid">
        <div class="token-stat">
          <div class="token-stat-label">Your Trades</div>
          <div class="token-stat-value">${coinFills.length}</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Volume</div>
          <div class="token-stat-value">$${fmtCompact(totalVolume)}</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Buys / Sells</div>
          <div class="token-stat-value">${buys} / ${sells}</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Closed PnL</div>
          <div class="token-stat-value ${pnl.cls}">${pnl.text}</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Fees Paid</div>
          <div class="token-stat-value neg">$${fmtUSD(totalFees)}</div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Net (PnL - Fees)</div>
          <div class="token-stat-value ${(closedPnl - totalFees) >= 0 ? 'pos' : 'neg'}">
            ${fmtPnL(closedPnl - totalFees).text}
          </div>
        </div>
        <div class="token-stat">
          <div class="token-stat-label">Avg Hold Time</div>
          <div class="token-stat-value">${fmtDuration(computeAvgHoldTime(coinFills))}</div>
        </div>
      </div>
      ${posHtml}
    </div>`
}

// ─── MANAGE TABLES (Trade tab) ───────────────────────────────────────────────
export function renderManageTables(perpState, openOrders, allMids) {
  renderManagePositions(perpState, allMids)
  renderManageOrders(openOrders, perpState)
}

export function renderManagePositions(perpState, allMids) {
  let positions = perpState.assetPositions ?? []
  const tbody   = document.getElementById('managePosTbody')
  const countEl = document.getElementById('managePosCount')
  if (countEl) countEl.textContent = positions.length

  const thead = document.querySelector('#managePosTable thead tr')
  if (thead) {
    const k = _mPosSortKey, d = _mPosSortDir
    thead.innerHTML =
      _thMPos('coin',  'Coin',     k, d) +
      _thMPos('side',  'Side',     k, d) +
      _thMPos('size',  'Size',     k, d) +
      _thMPos('entry', 'Entry',    k, d) +
      _thMPos('mark',  'Mark',     k, d) +
      _thMPos('pnl',   'Unr. PnL',k, d) +
      _thMPos('roe',   'ROE',      k, d) +
      '<th>Liq.</th><th>Margin</th><th>Actions</th>'
  }

  if (positions.length === 0) {
    tbody.innerHTML = emptyRow(10, '📭', 'No open positions')
    return
  }

  if (_mPosSortKey) {
    const val = (p) => {
      const pos = p.position
      switch (_mPosSortKey) {
        case 'coin':  return pos.coin
        case 'side':  return parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
        case 'size':  return Math.abs(parseFloat(pos.szi))
        case 'entry': return parseFloat(pos.entryPx)
        case 'mark':  return parseFloat(allMids[pos.coin] ?? 0)
        case 'pnl':   return parseFloat(pos.unrealizedPnl)
        case 'roe':   return parseFloat(pos.returnOnEquity)
        default:      return 0
      }
    }
    positions = [...positions].sort((a, b) => {
      const av = val(a), bv = val(b)
      return typeof av === 'string' ? av.localeCompare(bv) * _mPosSortDir : (av - bv) * _mPosSortDir
    })
  }

  tbody.innerHTML = positions.map(p => {
    const pos     = p.position
    const side    = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
    const pnl     = fmtPnL(pos.unrealizedPnl)
    const mktPx   = parseFloat(allMids[pos.coin] ?? 0)
    const roe     = parseFloat(pos.returnOnEquity) * 100

    return `<tr>
      <td><b>${esc(_lbl(pos.coin))}</b></td>
      <td><span class="badge badge-${side.toLowerCase()}">${side}</span></td>
      <td>${fmtSize(pos.szi)}</td>
      <td>$${fmtPrice(pos.entryPx)}</td>
      <td>$${mktPx ? fmtPrice(mktPx) : '—'}</td>
      <td class="${pnl.cls}">${pnl.text}</td>
      <td class="${roe >= 0 ? 'pos' : 'neg'}">${fmtPct(roe, true)}</td>
      <td style="color:var(--red)">$${fmtPrice(pos.liquidationPx ?? 0)}</td>
      <td>$${fmtUSD(pos.marginUsed)}</td>
      <td>
        <button class="manage-btn"
          onclick="window.__openEditModal('${esc(pos.coin)}','${side}','${pos.szi}','${pos.entryPx}')">
          ✏ Edit
        </button>
        <button class="manage-btn close"
          onclick="window.__openCloseModal('${esc(pos.coin)}','${side}','${pos.szi}',${mktPx})">
          ✕ Close
        </button>
      </td>
    </tr>`
  }).join('')
}

export function renderManageOrders(openOrders, perpState) {
  const tbody   = document.getElementById('manageOrdersTbody')
  const countEl = document.getElementById('manageOrdCount')
  if (countEl) countEl.textContent = openOrders.length

  const thead = document.querySelector('#manageOrdTable thead tr')
  if (thead) {
    const k = _mOrdSortKey, d = _mOrdSortDir
    thead.innerHTML =
      _thMOrd('coin',  'Coin',  k, d) +
      '<th>Intent</th>' +
      _thMOrd('size',  'Size',  k, d) +
      _thMOrd('price', 'Price', k, d) +
      '<th>Margin</th><th>Expected P&amp;L</th><th>Actions</th>'
  }

  if (openOrders.length === 0) {
    tbody.innerHTML = emptyRow(7, '📋', 'No open orders')
    return
  }

  // Build position lookup for margin/P&L enrichment
  const posMap = {}
  for (const ap of (perpState?.assetPositions ?? [])) {
    const p = ap.position ?? ap
    posMap[p.coin] = p
  }

  let orders = openOrders
  if (_mOrdSortKey) {
    orders = [...openOrders].sort((a, b) => {
      let av, bv
      if (_mOrdSortKey === 'coin') { av = a.coin; bv = b.coin }
      else if (_mOrdSortKey === 'size') { av = parseFloat(a.sz ?? 0); bv = parseFloat(b.sz ?? 0) }
      else if (_mOrdSortKey === 'price') {
        av = parseFloat(a.triggerPx ?? a.limitPx ?? 0)
        bv = parseFloat(b.triggerPx ?? b.limitPx ?? 0)
      }
      return typeof av === 'string' ? av.localeCompare(bv) * _mOrdSortDir : (av - bv) * _mOrdSortDir
    })
  }

  tbody.innerHTML = orders.map(o => {
    const isTrigger = o.isTrigger || (parseFloat(o.triggerPx ?? 0) > 0)
    const triggerPx = parseFloat(o.triggerPx ?? 0)
    const limitPx   = parseFloat(o.limitPx  ?? 0)
    const displayPx = isTrigger && triggerPx > 0 ? triggerPx : limitPx
    const sz        = parseFloat(o.sz ?? 0)

    const orderType = o.orderType ?? ''
    const isTp    = orderType.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl    = orderType.startsWith('Stop')        || o.triggerCondition === 'sl'
    const isBuy   = o.side === 'B'

    let intentLabel, intentCls, intentIcon
    if (isTp) {
      intentLabel = 'Take Profit'; intentCls = 'badge-tp';         intentIcon = '✦'
    } else if (isSl) {
      intentLabel = 'Stop Loss';   intentCls = 'badge-sl';         intentIcon = '⬡'
    } else if (o.reduceOnly) {
      intentLabel = isBuy ? 'Close Short' : 'Close Long'
      intentCls   = 'badge-reduce'; intentIcon = '◈'
    } else {
      intentLabel = isBuy ? 'Open Long' : 'Open Short'
      intentCls   = isBuy ? 'badge-open-long' : 'badge-open-short'
      intentIcon  = isBuy ? '▲' : '▼'
    }

    const orderKind = orderType || (isTrigger
      ? (limitPx > 0 && limitPx !== triggerPx ? 'Stop Limit' : 'Stop Market')
      : 'Limit')

    const priceDetail = isTrigger && triggerPx > 0 && limitPx > 0 && limitPx !== triggerPx
      ? `<div style="color:var(--muted);font-size:9px;margin-top:2px">Entry $${fmtPrice(limitPx)}</div>`
      : ''

    const pos       = posMap[o.coin]
    const entryPx   = pos ? parseFloat(pos.entryPx ?? 0) : 0
    const posSzi    = pos ? parseFloat(pos.szi   ?? 0) : 0
    const isLong    = posSzi > 0
    const effectiveSz = sz > 0 ? sz : Math.abs(posSzi)

    let marginHtml = '<span style="color:var(--muted)">—</span>'
    if (pos && (isTp || isSl || o.reduceOnly)) {
      marginHtml = `$${fmtUSD(parseFloat(pos.marginUsed ?? 0))}`
    }

    let pnlHtml = '<span style="color:var(--muted)">—</span>'
    if (entryPx > 0 && displayPx > 0 && (isTp || isSl || o.reduceOnly)) {
      const pnl  = isLong ? (displayPx - entryPx) * effectiveSz : (entryPx - displayPx) * effectiveSz
      const cls  = pnl >= 0 ? 'pos' : 'neg'
      const sign = pnl >= 0 ? '+' : ''
      pnlHtml = `<span class="${cls}" style="font-family:'JetBrains Mono',monospace;font-weight:700">${sign}$${fmtUSD(Math.abs(pnl))}</span>`
      if (pos?.marginUsed) {
        const margin = parseFloat(pos.marginUsed)
        const roe    = margin > 0 ? (pnl / margin) * 100 : 0
        const rSign  = roe >= 0 ? '+' : ''
        pnlHtml += `<div style="font-size:9px;color:var(--muted);margin-top:1px">${rSign}${roe.toFixed(1)}% on margin</div>`
      }
    }

    const orderValue = effectiveSz * displayPx

    return `<tr>
      <td><b>${esc(_lbl(o.coin))}</b></td>
      <td>
        <span class="badge ${intentCls}">${intentIcon} ${esc(intentLabel)}</span>
        <div style="font-size:9px;color:var(--muted);margin-top:3px">${esc(orderKind)}</div>
      </td>
      <td>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(_lbl(o.coin))}<div style="font-size:9px;color:var(--muted);margin-top:2px">Value $${fmtUSD(orderValue)}</div></td>
      <td>$${fmtPrice(displayPx)}${priceDetail}</td>
      <td style="font-family:'JetBrains Mono',monospace">${marginHtml}</td>
      <td>${pnlHtml}</td>
      <td>
        <button class="manage-btn close"
          onclick="window.__cancelOrder('${esc(o.coin)}', ${o.oid}, ${!!o.isPositionTpsl})">
          ✕ Cancel
        </button>
      </td>
    </tr>`
  }).join('')
}

// ─── PNL CALENDAR ─────────────────────────────────────────────────────────────
// Cache for day-click detail rendering
let _calCache = { fills: [], ledger: [], byDay: {}, rootId: 'calendarRoot', detailId: 'calDetail' }

export function calDayClick(key, rootId) {
  // Resolve the calendar's own data/detail from its root (each calendar stores its
  // own _calData), so multiple calendars (desktop, mobile calendar tab, accounts tab)
  // don't clobber each other via the shared _calCache.
  const root  = rootId ? document.getElementById(rootId) : null
  const cache = (root && root._calData) || _calCache
  const detail = document.getElementById(cache.detailId || 'calDetail')
  if (!detail) return
  document.querySelectorAll('.cal-cell.cal-selected').forEach(c => c.classList.remove('cal-selected'))
  if (detail.dataset.activeKey === key) { detail.innerHTML = ''; detail.dataset.activeKey = ''; return }

  const cell = document.querySelector(`.cal-cell[data-key="${key}"]`)
  if (cell) cell.classList.add('cal-selected')
  detail.dataset.activeKey = key

  const data = cache.byDay[key]
  const [yr, mo, dy] = key.split('-').map(Number)
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const dateLabel = `${MONTHS[mo - 1]} ${dy}, ${yr}`

  // Fills for this day
  const dayStart = new Date(yr, mo - 1, dy).getTime()
  const dayEnd   = dayStart + 86400000
  const dayFills = cache.fills.filter(f => f.time >= dayStart && f.time < dayEnd)

  // Aggregate by order (oid). hash is 0x0…0 for many HL fills, which would merge
  // unrelated orders into a phantom blended row — see aggregateByHash above.
  const groups = new Map()
  for (const f of dayFills) {
    const k = f.oid != null ? `oid_${f.oid}`
      : (f.hash && !/^0x0+$/.test(f.hash) ? f.hash : `tid_${f.tid ?? f.time + '_' + f.coin + '_' + f.px}`)
    if (!groups.has(k)) groups.set(k, { coin: f.coin, dir: f.dir, sz: 0, notional: 0, fee: 0, closedPnl: 0, time: f.time })
    const g = groups.get(k)
    g.sz += f.sz; g.notional += f.notional; g.fee += f.fee; g.closedPnl += f.closedPnl
  }
  const trades = [...groups.values()]
    .map(g => ({ ...g, px: g.sz > 0 ? g.notional / g.sz : 0 }))
    .sort((a, b) => a.time - b.time)

  // Ledger entries for this day
  const dayLedger = cache.ledger.filter(e => e.time >= dayStart && e.time < dayEnd)
  const txEntries = dayLedger.filter(e => {
    const t = e.delta.type
    return t === 'deposit' || t === 'withdraw' || (t === 'send' && e.delta.token === 'USDC')
  })

  const tradesHtml = trades.length ? `
    <div class="cal-detail-section">
      <div class="cal-detail-section-title">Trades</div>
      ${trades.map(t => {
        const isClose = (t.dir || '').toLowerCase().includes('close')
        const netPnl  = t.closedPnl - t.fee
        return `<div class="cal-detail-trade">
          <span class="cal-detail-coin">${esc(_lbl(t.coin))}</span>
          <span class="dir-badge ${isClose ? 'dir-close' : 'dir-open'}">${esc(t.dir || '')}</span>
          <span class="cal-detail-meta">${fmtSize(t.sz)} @ $${fmtPrice(t.px)}</span>
          ${t.closedPnl !== 0 ? `<span class="${netPnl >= 0 ? 'pos' : 'neg'} cal-detail-pnl">${netPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(netPnl))}</span>` : '<span class="cal-detail-pnl" style="color:var(--muted)">—</span>'}
        </div>`
      }).join('')}
    </div>` : ''

  const txHtml = txEntries.length ? `
    <div class="cal-detail-section">
      <div class="cal-detail-section-title">Deposits & Withdrawals</div>
      ${txEntries.map(e => {
        const t         = e.delta.type
        const isDeposit = t === 'deposit' || (t === 'send' && e.delta.token === 'USDC')
        const amt       = parseFloat(isDeposit ? (t === 'deposit' ? e.delta.usdc : e.delta.usdcValue) : e.delta.usdc) || 0
        return `<div class="cal-detail-tx">
          <span class="badge ${isDeposit ? 'badge-deposit' : 'badge-withdraw'}">${isDeposit ? 'Deposit' : 'Withdrawal'}</span>
          <span class="${isDeposit ? 'pos' : 'neg'}" style="font-family:'JetBrains Mono',monospace;font-weight:700">${isDeposit ? '+' : '-'}$${fmtUSD(amt)} USDC</span>
        </div>`
      }).join('')}
    </div>` : ''

  const dayPnl = data?.pnl ?? 0
  detail.innerHTML = `
    <div class="cal-detail-header">
      <div class="cal-detail-date">${dateLabel}</div>
      <div class="cal-detail-summary-pills">
        ${dayPnl !== 0 ? `<span class="cal-detail-pill ${dayPnl >= 0 ? 'pos' : 'neg'}">PnL ${dayPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(dayPnl))}</span>` : ''}
        ${trades.length ? `<span class="cal-detail-pill neu">${trades.length} trade${trades.length !== 1 ? 's' : ''}</span>` : ''}
        ${(data?.deposited ?? 0) > 0 ? `<span class="cal-detail-pill pos">Deposited +$${fmtUSD(data.deposited)}</span>` : ''}
        ${(data?.withdrawn ?? 0) > 0 ? `<span class="cal-detail-pill neg">Withdrawn -$${fmtUSD(data.withdrawn)}</span>` : ''}
      </div>
      <button class="cal-detail-close" onclick="window.__calDayClick('${key}','${rootId || ''}')">✕</button>
    </div>
    ${tradesHtml}${txHtml}
    ${!trades.length && !txEntries.length ? '<div style="color:var(--muted);font-size:12px;padding:12px 0">No activity on this day.</div>' : ''}`
}

export function renderPnLCalendar(fills, month, year, ledger = [], rootId = 'calendarRoot', navId = null, detailId = 'calDetail') {
  const root = document.getElementById(rootId)
  if (!root) return

  // Aggregate closedPnl per calendar day
  const byDay = {}  // key: 'YYYY-MM-DD' → { pnl, trades, deposited, withdrawn }
  for (const f of fills) {
    if (f.closedPnl === 0) continue
    const d   = new Date(f.time)
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    if (!byDay[key]) byDay[key] = { pnl: 0, trades: 0, deposited: 0, withdrawn: 0 }
    byDay[key].pnl    += f.closedPnl
    byDay[key].trades += 1
  }

  // Aggregate deposits & withdrawals per day
  for (const e of ledger) {
    const t = e.delta.type
    const isDeposit  = t === 'deposit' || (t === 'send' && e.delta.token === 'USDC')
    const isWithdraw = t === 'withdraw'
    if (!isDeposit && !isWithdraw) continue
    const amt = isDeposit
      ? parseFloat(t === 'deposit' ? e.delta.usdc : e.delta.usdcValue ?? 0)
      : parseFloat(e.delta.usdc ?? 0)
    if (!amt) continue
    const d   = new Date(e.time)
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    if (!byDay[key]) byDay[key] = { pnl: 0, trades: 0, deposited: 0, withdrawn: 0 }
    if (isDeposit)  byDay[key].deposited += amt
    else            byDay[key].withdrawn += amt
  }

  // Store in cache for click handler + month nav re-render. Also stash per-root so
  // each calendar (desktop / mobile calendar tab / accounts tab) clicks its OWN data.
  _calCache = { fills, ledger, byDay, rootId, detailId: detailId || 'calDetail' }
  root._calData = { fills, ledger, byDay, detailId: detailId || 'calDetail' }

  // Month summary
  const todayD    = new Date()
  const firstDay  = new Date(year, month, 1)
  const lastDay   = new Date(year, month + 1, 0)
  const monthKeys = Object.keys(byDay).filter(k => {
    const [y, m] = k.split('-').map(Number)
    return y === year && m === month + 1
  })
  const monthPnl   = monthKeys.reduce((s, k) => s + byDay[k].pnl, 0)
  const greenDays  = monthKeys.filter(k => byDay[k].pnl > 0).length
  const redDays    = monthKeys.filter(k => byDay[k].pnl < 0).length
  const bestDay    = monthKeys.reduce((b, k) => byDay[k].pnl > (byDay[b]?.pnl ?? -Infinity) ? k : b, monthKeys[0])
  const worstDay   = monthKeys.reduce((w, k) => byDay[k].pnl < (byDay[w]?.pnl ?? Infinity) ? k : w, monthKeys[0])

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const DOWS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

  // Build calendar cells (Sun-Sat week)
  const startDow   = firstDay.getDay()  // 0=Sun
  const totalCells = startDow + lastDay.getDate()
  const rows       = Math.ceil(totalCells / 7)

  let cells = ''
  for (let i = 0; i < rows * 7; i++) {
    const dayNum = i - startDow + 1
    if (dayNum < 1 || dayNum > lastDay.getDate()) {
      cells += `<div class="cal-cell cal-empty"></div>`
      continue
    }
    const key     = `${year}-${String(month+1).padStart(2,'0')}-${String(dayNum).padStart(2,'0')}`
    const data    = byDay[key]
    const isToday = year === todayD.getFullYear() && month === todayD.getMonth() && dayNum === todayD.getDate()
    let cls = 'cal-cell'
    if (isToday) cls += ' cal-today'
    if (data) cls += data.pnl >= 0 ? ' cal-pos' : ' cal-neg'

    const txHtml = data ? [
      data.deposited > 0 ? `<div class="cal-day-tx dep">DEP +$${fmtUSD(data.deposited)}</div>` : '',
      data.withdrawn > 0 ? `<div class="cal-day-tx wth">WDR -$${fmtUSD(data.withdrawn)}</div>` : '',
    ].join('') : ''

    const hasActivity = data && (data.pnl !== 0 || data.deposited > 0 || data.withdrawn > 0)
    if (hasActivity) cls += ' cal-clickable'

    cells += `<div class="${cls}"${hasActivity ? ` data-key="${key}" onclick="window.__calDayClick('${key}','${rootId}')"` : ''}>
      <div class="cal-day-num">${dayNum}</div>
      ${data && data.pnl !== 0 ? `
        <div class="cal-day-pnl ${data.pnl >= 0 ? 'pos' : 'neg'}">${data.pnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(data.pnl))}</div>
        <div class="cal-day-trades">${data.trades} fill${data.trades !== 1 ? 's' : ''}</div>
      ` : ''}
      ${txHtml}
    </div>`
  }

  const fmtDayLabel = (key) => {
    if (!key) return '—'
    const [, , d] = key.split('-')
    return MONTHS[month].slice(0,3) + ' ' + parseInt(d)
  }

  root.innerHTML = `
    <div class="cal-header-row">
      <button class="cal-nav-btn" onclick="${navId || 'calNav'}(-1)">◀ Prev</button>
      <div class="cal-month-label">${MONTHS[month]} ${year}</div>
      <button class="cal-nav-btn" onclick="${navId || 'calNav'}(1)">Next ▶</button>
    </div>
    <div class="cal-summary">
      <div class="stat-card">
        <div class="stat-label">Month PnL</div>
        <div class="stat-value ${monthPnl >= 0 ? 'pos' : 'neg'}">${monthPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(monthPnl))}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Green / Red Days</div>
        <div class="stat-value neu"><span class="pos">${greenDays}</span> / <span class="neg">${redDays}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Best Day</div>
        <div class="stat-value pos">${bestDay ? '+$' + fmtUSD(byDay[bestDay].pnl) : '—'}</div>
        ${bestDay ? `<div class="stat-sub">${fmtDayLabel(bestDay)}</div>` : ''}
      </div>
      <div class="stat-card">
        <div class="stat-label">Worst Day</div>
        <div class="stat-value neg">${worstDay && byDay[worstDay].pnl < 0 ? '-$' + fmtUSD(Math.abs(byDay[worstDay].pnl)) : '—'}</div>
        ${worstDay && byDay[worstDay].pnl < 0 ? `<div class="stat-sub">${fmtDayLabel(worstDay)}</div>` : ''}
      </div>
    </div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <div class="cal-dow-row" style="min-width:350px">${DOWS.map(d => `<div class="cal-dow-cell">${d}</div>`).join('')}</div>
      <div class="cal-grid" style="min-width:350px">${cells}</div>
    </div>`
}

// ─── TRANSFERS ────────────────────────────────────────────────────────────────
const TRANSFER_TYPES = {
  deposit:             { label: 'Deposit',           badge: 'badge-deposit',     sign: +1 },
  withdraw:            { label: 'Withdrawal',         badge: 'badge-withdraw',    sign: -1 },
  accountClassTransfer:{ label: 'Spot ↔ Perp',       badge: 'badge-transfer',    sign:  0 },
  internalTransfer:    { label: 'Internal Transfer',  badge: 'badge-transfer',    sign:  0 },
  spotTransfer:        { label: 'Spot Transfer',      badge: 'badge-transfer',    sign:  0 },
  send:                { label: 'Transfer',            badge: 'badge-transfer',    sign:  0 },
  liquidation:         { label: 'Liquidation',        badge: 'badge-liquidation', sign: -1 },
  rewardsClaim:        { label: 'Rewards',            badge: 'badge-reward',      sign: +1 },
  subAccountTransfer:  { label: 'Sub-account',        badge: 'badge-transfer',    sign:  0 },
}

// Signed USDC value of a ledger entry (+ added to the account, − left it).
// `addr` is the viewing account — used to sign peer transfers (spotTransfer/send)
// by whether we were the sender (outflow) or the recipient (inflow).
export function ledgerAmount(entry, addr = null) {
  const d  = entry.delta
  const me = (addr || '').toLowerCase()
  // For a peer transfer, outgoing = the destination is someone other than us.
  const dir = () => {
    const dest = (d.destination || '').toLowerCase()
    if (!me || !dest) return 1            // unknown → keep positive (legacy behaviour)
    return dest === me ? 1 : -1           // to us = inflow(+), to someone else = outflow(−)
  }
  switch (d.type) {
    case 'deposit':             return parseFloat(d.usdc)
    case 'withdraw':            return -parseFloat(d.usdc)
    case 'accountClassTransfer':return parseFloat(d.usdc) * (d.toPerp ? 1 : -1)
    case 'internalTransfer':    return parseFloat(d.usdc) * dir()
    case 'subAccountTransfer':  return parseFloat(d.usdc) * dir()
    case 'spotTransfer':        return parseFloat(d.usdcValue ?? 0) * dir()
    case 'send':                return parseFloat(d.usdcValue ?? 0) * dir()
    case 'liquidation':         return -parseFloat(d.accountValue ?? 0)
    case 'rewardsClaim':        return parseFloat(d.amount ?? 0)
    default:                    return 0
  }
}

function ledgerDetails(entry) {
  const d = entry.delta
  switch (d.type) {
    case 'accountClassTransfer': return d.toPerp ? 'Spot → Perp' : 'Perp → Spot'
    case 'withdraw':             return `Fee: $${fmtUSD(parseFloat(d.fee ?? 0))}`
    case 'internalTransfer':
    case 'subAccountTransfer':   return `To: ${d.destination?.slice(0,10)}...`
    case 'spotTransfer':         return `${d.amount} ${d.token}`
    case 'send':                 return `${d.amount} ${d.token} → ${d.destination?.slice(0,10)}...`
    case 'liquidation': {
      const coins = (d.liquidatedPositions ?? []).map(p => p.coin).join(', ')
      return `${d.leverageType} · ${coins || '—'}`
    }
    case 'rewardsClaim':         return d.token
    default:                     return '—'
  }
}

export function renderTransfers(ledger, filter = 'all', addr = null) {
  const summaryEl = document.getElementById('transfersSummary')
  const cardsEl   = document.getElementById('transfersCards')
  if (!summaryEl || !cardsEl) return

  const DEPOSIT_TYPES  = ['deposit','accountClassTransfer','internalTransfer','subAccountTransfer','spotTransfer','send']
  const WITHDRAW_TYPES = ['withdraw']

  // Deposited / Withdrawn count real value in/out of the account: bridge
  // deposits & withdrawals plus peer transfers (spot transfers, USDC sends) —
  // an incoming transfer adds to Deposited, an outgoing one to Withdrawn. Uses
  // the same signed amount as the rows so totals and line items agree.
  const FLOW_TYPES = ['deposit', 'withdraw', 'send', 'spotTransfer']
  let totalDeposited = 0, totalWithdrawn = 0
  for (const e of ledger) {
    if (!FLOW_TYPES.includes(e.delta.type)) continue
    if (e.delta.type === 'send' && e.delta.token !== 'USDC') continue   // non-USDC sends carry no USDC value
    const v = ledgerAmount(e, addr)
    if (v > 0) totalDeposited += v
    else if (v < 0) totalWithdrawn += -v
  }
  const net = totalDeposited - totalWithdrawn

  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-label">Total Deposited</div><div class="stat-value pos">$${fmtUSD(totalDeposited)}</div></div>
    <div class="stat-card"><div class="stat-label">Total Withdrawn</div><div class="stat-value neg">$${fmtUSD(totalWithdrawn)}</div></div>
    <div class="stat-card"><div class="stat-label">Net Flow</div><div class="stat-value ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}$${fmtUSD(Math.abs(net))}</div></div>
    <div class="stat-card"><div class="stat-label">Total Events</div><div class="stat-value neu">${ledger.length}</div></div>`

  const filterMap = {
    deposit:  DEPOSIT_TYPES,
    withdraw: WITHDRAW_TYPES,
  }
  const visible = filter === 'all' ? ledger : ledger.filter(e => (filterMap[filter] ?? []).includes(e.delta.type))

  if (!visible.length) {
    cardsEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📋</div>
      <div class="empty-text">No transfers found</div>
    </div>`
    return
  }

  cardsEl.innerHTML = visible.slice().sort((a, b) => b.time - a.time).map(entry => {
    const meta    = TRANSFER_TYPES[entry.delta.type] ?? { label: entry.delta.type, badge: 'badge-transfer', sign: 0 }
    const amt     = ledgerAmount(entry, addr)
    const amtStr  = amt > 0 ? '+$' + fmtUSD(amt) : amt < 0 ? '-$' + fmtUSD(Math.abs(amt)) : '$0.00'
    // Colour follows the actual signed flow (so spot/internal transfers get +/-),
    // falling back to the type's nominal sign when the amount is zero.
    const amtCls  = amt > 0 ? 'pos' : amt < 0 ? 'neg' : (meta.sign > 0 ? 'pos' : meta.sign < 0 ? 'neg' : 'muted')
    const date    = new Date(entry.time)
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
                    ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const details = ledgerDetails(entry)
    return `<div class="txfr-card">
      <div class="txfr-card-top">
        <span class="badge ${meta.badge}">${esc(meta.label)}</span>
        <span class="txfr-card-amt ${amtCls}">${esc(amtStr)}</span>
      </div>
      <div class="txfr-card-bottom">
        <span class="txfr-card-date">${esc(dateStr)}</span>
        <span class="txfr-card-detail" title="${esc(details)}">${esc(details)}</span>
      </div>
    </div>`
  }).join('')
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function emptyRow(cols, icon, text) {
  return `<tr><td colspan="${cols}">
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <div class="empty-text">${text}</div>
    </div>
  </td></tr>`
}
