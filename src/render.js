import { fmtUSD, fmtPrice, fmtSize, fmtPnL, fmtPct, fmtCompact, fmtTime, esc } from './format.js'
import { aggregateFillsByCoin } from './api.js'

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

// ─── OVERVIEW ────────────────────────────────────────────────────────────────
export function renderOverview({ perpState, spotState, fills, funding = [], openOrders, allMids = {}, portfolio = [], webData = null, sessionStart = null, firstFillTime = null }) {
  const margin    = perpState.marginSummary ?? {}
  const positions = perpState.assetPositions ?? []

  // Account value from portfolio allTime — same source as the charts
  const portfolioAcctVal = portfolioLatest(portfolio, 'allTime', 'accountValueHistory')

  // Fall back to clearinghouseState if portfolio not yet loaded
  const accountValue = portfolioAcctVal ?? parseFloat(margin.accountValue ?? 0)

  const totalNtl    = parseFloat(margin.totalNtlPos    ?? 0)
  const marginUsed  = parseFloat(margin.totalMarginUsed ?? 0)

  // Withdrawable: perp + any free spot USDC
  const perpWithdrawable = parseFloat(perpState.withdrawable ?? 0)
  const spotUSDC         = (spotState?.balances ?? []).find(b => b.coin === 'USDC')
  const spotUSDCFree     = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
  const withdrawable     = perpWithdrawable + spotUSDCFree

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

  // ── Current streak & avg hold time ───────────────────────────────────────
  const currentStreak = computeCurrentStreak(fills)
  const avgHoldMs     = computeAvgHoldTime(fills)

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
      label: 'Win Rate',
      value: winRate + (closedTrades > 0 ? '%' : ''),
      sub:   winningTrades + ' of ' + closedTrades + ' closed',
      cls:   'neu',
    },
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
    // ── Volume & duration ────────────────────────────────────────────────────
    {
      label: 'Avg Hold Time',
      value: fmtDuration(avgHoldMs),
      sub:   'Avg time from open to close fill',
      cls:   'neu',
    },
    {
      label: 'Total Volume',
      value: '$' + fmtCompact(totalVolume),
      sub:   fills.length + ' fills',
      cls:   'neu',
      id:    'statTotalVolume',
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
      label: 'Member Since',
      value: memberSince,
      sub:   isFinite(earliestTs) ? Math.floor((Date.now() - earliestTs) / (1000 * 60 * 60 * 24)) + ' days ago' : '—',
      cls:   'neu',
    },
  ]

  const maintMargin = parseFloat(perpState.crossMaintenanceMarginUsed ?? 0)
  const health      = accountValue > 0
    ? Math.max(0, Math.min(100, (accountValue - maintMargin) / accountValue * 100))
    : 100
  const healthColor = health > 50 ? 'var(--green)' : health > 25 ? 'var(--yellow)' : health > 10 ? '#ff9444' : 'var(--red)'

  document.getElementById('overviewStats').innerHTML = `
    <div class="overview-hero-row">
      ${heroStats.map(s => `
        <div class="stat-card stat-card-hero">
          <div class="stat-label">${esc(s.label)}</div>
          <div class="stat-value ${s.cls}">${esc(s.value)}</div>
          <div class="stat-sub">${esc(s.sub)}</div>
        </div>`).join('')}
      <div class="stat-card stat-card-hero">
        <div class="stat-label">Account Health</div>
        <div class="stat-value" style="color:${healthColor};font-size:22px">${health.toFixed(1)}%</div>
        <div class="health-bar-wrap" style="margin:8px 0 6px">
          <div class="health-bar-fill" style="width:${health.toFixed(2)}%;background:${healthColor}"></div>
        </div>
        <div class="stat-sub">Maint. margin $${fmtUSD(maintMargin)} — ${positions.length} pos open</div>
      </div>
    </div>
    <div class="overview-perf-row">
      ${perfStats.map(s => `
        <div class="stat-card">
          <div class="stat-label">${esc(s.label)}</div>
          <div class="stat-value ${s.cls}"${s.id ? ` id="${s.id}"` : ''}>${esc(s.value)}</div>
          ${s.sub ? `<div class="stat-sub">${esc(s.sub)}</div>` : ''}
        </div>`).join('')}
    </div>`

  // Clear legacy positions wrap if it still exists in HTML
  const wrap = document.getElementById('overviewPositionsWrap')
  if (wrap) wrap.innerHTML = ''
}

// ─── POSITIONS TAB ───────────────────────────────────────────────────────────
export function renderPositions(perpState, allMids = {}) {
  const positions = perpState.assetPositions ?? []
  const tbody = document.getElementById('positionsTbody')

  document.getElementById('posCount').textContent    = positions.length
  document.getElementById('posCountBig').textContent = positions.length

  if (positions.length === 0) {
    tbody.innerHTML = emptyRow(12, '📭', 'No open positions')
    return
  }

  tbody.innerHTML = positions.map((p, i) => {
    const pos    = p.position
    const side   = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
    const pnl    = fmtPnL(pos.unrealizedPnl)
    const roe    = parseFloat(pos.returnOnEquity) * 100
    const mktPx  = parseFloat(allMids[pos.coin] ?? 0)
    const liqPx  = parseFloat(pos.liquidationPx ?? 0)
    const isLong = side === 'LONG'
    const eid    = `pos-expand-${i}`

    // Warn if mark price is within 15% of liquidation price
    let liqWarn = false, liqDistPct = 0
    if (liqPx > 0 && mktPx > 0) {
      liqDistPct = isLong
        ? (mktPx - liqPx) / mktPx * 100
        : (liqPx - mktPx) / mktPx * 100
      liqWarn = liqDistPct > 0 && liqDistPct < 15
    }

    return `<tr${liqWarn ? ' class="liq-warn-row"' : ''}>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="row-expand-btn" onclick="window.__toggleRowExpand('${eid}')" aria-label="expand">&#8964;</button>
          <b>${esc(pos.coin)}</b>
        </div>
      </td>
      <td><span class="badge badge-${side.toLowerCase()}">${side}</span></td>
      <td>${fmtSize(pos.szi)}</td>
      <td>$${fmtPrice(pos.entryPx)}</td>
      <td>$${mktPx ? fmtPrice(mktPx) : '—'}</td>
      <td>$${fmtUSD(pos.positionValue)}</td>
      <td class="${pnl.cls}">${pnl.text}</td>
      <td class="${roe >= 0 ? 'pos' : 'neg'}">${fmtPct(roe, true)}</td>
      <td class="${liqWarn ? 'liq-warn' : ''}">
        ${liqWarn ? '⚠ ' : ''}$${fmtPrice(liqPx)}
        ${liqWarn ? `<div style="font-size:10px;margin-top:2px">${liqDistPct.toFixed(1)}% away</div>` : ''}
      </td>
      <td>${esc(String(pos.leverage.value))}x (${esc(pos.leverage.type)})</td>
      <td>$${fmtUSD(pos.marginUsed)}</td>
      <td>
        <button class="manage-btn"
          onclick="window.__openEditModal('${esc(pos.coin)}','${side}','${pos.szi}','${pos.entryPx}')">
          ✏ TP/SL
        </button>
        <button class="manage-btn close"
          onclick="window.__openCloseModal('${esc(pos.coin)}','${side}','${pos.szi}',${mktPx || parseFloat(pos.entryPx)})">
          ✕ Close
        </button>
      </td>
    </tr>
    <tr class="row-expand-detail" id="${eid}">
      <td colspan="12">
        <div class="row-expand-grid">
          <div class="row-expand-item"><span>Mark Price</span><span>$${mktPx ? fmtPrice(mktPx) : '—'}</span></div>
          <div class="row-expand-item"><span>Position Value</span><span>$${fmtUSD(pos.positionValue)}</span></div>
          <div class="row-expand-item ${liqWarn ? 'liq-warn' : ''}"><span>Liq. Price</span><span>${liqWarn ? '⚠ ' : ''}$${fmtPrice(liqPx)}</span></div>
          <div class="row-expand-item"><span>Leverage</span><span>${esc(String(pos.leverage.value))}x (${esc(pos.leverage.type)})</span></div>
          <div class="row-expand-item"><span>Margin Used</span><span>$${fmtUSD(pos.marginUsed)}</span></div>
          <div class="row-expand-item"><span>ROE</span><span class="${roe >= 0 ? 'pos' : 'neg'}">${fmtPct(roe, true)}</span></div>
        </div>
      </td>
    </tr>`
  }).join('')
}

// ─── SPOT TAB ────────────────────────────────────────────────────────────────
export function renderSpot(spotState) {
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
      <td><b>${esc(b.coin)}</b></td>
      <td>${fmtSize(total)}</td>
      <td>${fmtSize(hold)}</td>
      <td class="pos">${fmtSize(avail)}</td>
    </tr>`
  }).join('')
}

// ─── ORDERS TAB ──────────────────────────────────────────────────────────────
export function renderOrders(openOrders, perpState) {
  const tbody = document.getElementById('ordersTbody')

  document.getElementById('ordCount').textContent    = openOrders.length
  document.getElementById('ordCountBig').textContent = openOrders.length

  if (openOrders.length === 0) {
    tbody.innerHTML = emptyRow(7, '📋', 'No open orders')
    return
  }

  // Build a quick lookup: coin → position data
  const posMap = {}
  for (const ap of (perpState?.assetPositions ?? [])) {
    const p = ap.position ?? ap
    posMap[p.coin] = p
  }

  tbody.innerHTML = openOrders.map(o => {
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

    // Use the exact orderType string HL provides (e.g. "Take Profit Limit", "Stop Market")
    const orderKind = orderType || (isTrigger
      ? (limitPx > 0 && limitPx !== triggerPx ? 'Stop Limit' : 'Stop Market')
      : 'Limit')

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
      pnlHtml = `<span class="${cls}" style="font-family:'Space Mono',monospace;font-weight:700">${sign}$${fmtUSD(Math.abs(pnl))}</span>`
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
          <b>${esc(o.coin)}</b>
        </div>
      </td>
      <td>
        <span class="badge ${intentCls}">${intentIcon} ${esc(intentLabel)}</span>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${esc(orderKind)}</div>
      </td>
      <td>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(o.coin)}<div style="font-size:10px;color:var(--muted);margin-top:2px">Value $${fmtUSD(orderValue)}</div></td>
      <td>$${fmtPrice(displayPx)}${priceDetail}</td>
      <td style="font-family:'Space Mono',monospace">${marginHtml}</td>
      <td>${pnlHtml}</td>
      <td>
        <button class="manage-btn close"
          onclick="window.__cancelOrder('${esc(o.coin)}', ${o.oid})">
          ✕ Cancel
        </button>
      </td>
    </tr>
    <tr class="row-expand-detail" id="${eid}">
      <td colspan="7">
        <div class="row-expand-grid">
          <div class="row-expand-item"><span>Size</span><span>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(o.coin)}</span></div>
          <div class="row-expand-item"><span>Order Value</span><span>$${fmtUSD(orderValue)}</span></div>
          <div class="row-expand-item"><span>Margin</span><span>${marginHtml}</span></div>
          <div class="row-expand-item"><span>P&L if Hit</span><span>${pnlHtml}</span></div>
        </div>
      </td>
    </tr>`
  }).join('')
}

// ─── TRADE HISTORY TAB ───────────────────────────────────────────────────────
function aggregateByHash(fills) {
  const groups = new Map()
  for (const f of fills) {
    const key = f.hash || `${f.time}_${f.coin}_${f.side}`
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

  // Summary stats (from raw fills for accuracy on fees/pnl)
  const totalVolume  = fills.reduce((s, f) => s + f.notional, 0)
  const totalFees    = fills.reduce((s, f) => s + f.fee, 0)
  const totalRealPnl = fills.reduce((s, f) => s + f.closedPnl, 0)
  // Group closing fills by coin + 1h bucket to avoid counting partial fills as separate trades
  const ONE_HOUR_T = 60 * 60 * 1000
  const tradeWindows = {}
  for (const f of fills.filter(f => f.closedPnl !== 0)) {
    const bucket = Math.floor(f.time / ONE_HOUR_T)
    const key    = `${f.coin}_${bucket}`
    if (!tradeWindows[key]) tradeWindows[key] = { netPnl: 0 }
    tradeWindows[key].netPnl += f.closedPnl - f.fee
  }
  const tradeWindowList = Object.values(tradeWindows)
  const winners  = tradeWindowList.filter(w => w.netPnl > 0).length
  const winRate  = tradeWindowList.length > 0 ? (winners / tradeWindowList.length * 100).toFixed(1) : '—'

  const summaryEl = document.getElementById('tradesSummary')
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="stat-card"><div class="stat-label">Total Volume</div><div class="stat-value neu">$${fmtCompact(totalVolume)}</div></div>
      <div class="stat-card"><div class="stat-label">Realized PnL</div><div class="stat-value ${fmtPnL(totalRealPnl).cls}">${fmtPnL(totalRealPnl).text}</div></div>
      <div class="stat-card"><div class="stat-label">Total Fees</div><div class="stat-value neg">-$${fmtUSD(totalFees)}</div></div>
      <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value neu">${winRate}${tradeWindowList.length > 0 ? '%' : ''}</div></div>`
  }

  // Render aggregated trades, newest first
  tbody.innerHTML = trades.sort((a, b) => b.time - a.time).slice(0, 500).map(t => {
    const hasPnl  = t.closedPnl !== 0
    const netPnl  = t.closedPnl - t.fee
    const pnl     = fmtPnL(netPnl)
    const dir     = t.dir || (t.side === 'BUY' ? 'Open Long' : 'Open Short')
    const isClose = dir.toLowerCase().includes('close')
    return `<tr>
      <td style="color:var(--muted);white-space:nowrap;font-size:11px">${esc(t.timeStr)}</td>
      <td><b>${esc(t.coin)}</b></td>
      <td><span class="dir-badge ${isClose ? 'dir-close' : 'dir-open'}">${esc(dir)}</span></td>
      <td>${fmtSize(t.sz)}</td>
      <td>$${fmtPrice(t.px)}</td>
      <td class="${hasPnl ? pnl.cls : 'muted'}">${hasPnl ? pnl.text : '—'}</td>
      <td class="neg" style="font-size:11px">-$${fmtUSD(t.fee)}</td>
    </tr>`
  }).join('')
}


// ─── PORTFOLIO STATS ──────────────────────────────────────────────────────────
export function renderPortfolioStats({ perpState, fills, funding, portfolio = [], webData = null }) {
  const accountValue = portfolioLatest(portfolio, 'allTime', 'accountValueHistory')
    ?? parseFloat((perpState.marginSummary ?? {}).accountValue ?? 0)

  const cumLedger    = parseFloat(webData?.cumLedger ?? 0)
  const allTimePnl   = cumLedger !== 0
    ? accountValue - cumLedger
    : portfolioLatest(portfolio, 'allTime', 'pnlHistory') ?? fills.reduce((s, f) => s + f.closedPnl, 0)

  const totalUnrPnl  = (perpState.assetPositions ?? []).reduce(
    (s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0
  )
  const totalFees    = fills.reduce((s, f) => s + f.fee, 0)
  const totalFunding = funding.reduce((s, f) => s + f.usdc, 0)

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
      label: 'All Time PnL',
      value: fmtPnL(allTimePnl).text,
      sub:   'Equity minus net deposits',
      cls:   fmtPnL(allTimePnl).cls,
    },
    {
      label: 'Net Funding',
      value: fmtPnL(totalFunding).text,
      sub:   'Received minus paid (30d)',
      cls:   fmtPnL(totalFunding).cls,
    },
    {
      label: 'Total Fees',
      value: '-$' + fmtUSD(totalFees),
      sub:   'Paid to exchange',
      cls:   'neg',
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
export function renderTokenList(allMids, query, fills) {
  const list    = document.getElementById('tokenResultsList')
  const entries = Object.entries(allMids)
  const q       = query.toLowerCase().trim()
  const filtered = q ? entries.filter(([k]) => k.toLowerCase().includes(q)) : entries

  if (filtered.length === 0) {
    list.innerHTML = '<div class="market-empty">No tokens found.</div>'
    return
  }

  const coinStats = {}
  for (const f of fills) {
    if (!coinStats[f.coin]) coinStats[f.coin] = { trades: 0, pnl: 0 }
    coinStats[f.coin].trades++
    coinStats[f.coin].pnl += f.closedPnl
  }

  list.innerHTML = filtered.slice(0, 100).map(([coin, price]) => {
    const p     = parseFloat(price)
    const stats = coinStats[coin]
    return `<div class="token-result-item" onclick="window.__showTokenDetail('${esc(coin)}', ${p})">
      <div class="token-result-left">
        <div class="token-icon">${esc(coin.slice(0, 3))}</div>
        <div>
          <div class="token-result-name">${esc(coin)}</div>
          <div style="font-size:11px;color:var(--muted);font-family:'Space Mono',monospace">
            ${stats ? stats.trades + ' trades' : 'No trades'}
          </div>
        </div>
      </div>
      <div class="token-result-price">
        <div style="font-weight:700">$${fmtPrice(p)}</div>
        ${stats ? `<div style="font-size:10px" class="${stats.pnl >= 0 ? 'pos' : 'neg'}">${fmtPnL(stats.pnl).text}</div>` : ''}
      </div>
    </div>`
  }).join('')
}

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
      <div style="color:var(--muted);font-size:12px;font-family:'Space Mono',monospace">PERPETUAL / USDC</div>
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
  const positions = perpState.assetPositions ?? []
  const tbody     = document.getElementById('managePosTbody')

  if (positions.length === 0) {
    tbody.innerHTML = emptyRow(10, '📭', 'No open positions')
    return
  }

  tbody.innerHTML = positions.map(p => {
    const pos     = p.position
    const side    = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
    const pnl     = fmtPnL(pos.unrealizedPnl)
    const mktPx   = parseFloat(allMids[pos.coin] ?? 0)
    const roe     = parseFloat(pos.returnOnEquity) * 100

    return `<tr>
      <td><b>${esc(pos.coin)}</b></td>
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
  const tbody = document.getElementById('manageOrdersTbody')

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

  tbody.innerHTML = openOrders.map(o => {
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
      pnlHtml = `<span class="${cls}" style="font-family:'Space Mono',monospace;font-weight:700">${sign}$${fmtUSD(Math.abs(pnl))}</span>`
      if (pos?.marginUsed) {
        const margin = parseFloat(pos.marginUsed)
        const roe    = margin > 0 ? (pnl / margin) * 100 : 0
        const rSign  = roe >= 0 ? '+' : ''
        pnlHtml += `<div style="font-size:9px;color:var(--muted);margin-top:1px">${rSign}${roe.toFixed(1)}% on margin</div>`
      }
    }

    const orderValue = effectiveSz * displayPx

    return `<tr>
      <td><b>${esc(o.coin)}</b></td>
      <td>
        <span class="badge ${intentCls}">${intentIcon} ${esc(intentLabel)}</span>
        <div style="font-size:9px;color:var(--muted);margin-top:3px">${esc(orderKind)}</div>
      </td>
      <td>${fmtSize(effectiveSz > 0 ? effectiveSz : sz)} ${esc(o.coin)}<div style="font-size:9px;color:var(--muted);margin-top:2px">Value $${fmtUSD(orderValue)}</div></td>
      <td>$${fmtPrice(displayPx)}${priceDetail}</td>
      <td style="font-family:'Space Mono',monospace">${marginHtml}</td>
      <td>${pnlHtml}</td>
      <td>
        <button class="manage-btn close"
          onclick="window.__cancelOrder('${esc(o.coin)}', ${o.oid})">
          ✕ Cancel
        </button>
      </td>
    </tr>`
  }).join('')
}

// ─── PNL CALENDAR ─────────────────────────────────────────────────────────────
// Cache for day-click detail rendering
let _calCache = { fills: [], ledger: [], byDay: {} }

export function calDayClick(key) {
  // Toggle off if same day clicked again
  const detail = document.getElementById('calDetail')
  if (!detail) return
  document.querySelectorAll('.cal-cell.cal-selected').forEach(c => c.classList.remove('cal-selected'))
  if (detail.dataset.activeKey === key) { detail.innerHTML = ''; detail.dataset.activeKey = ''; return }

  const cell = document.querySelector(`.cal-cell[data-key="${key}"]`)
  if (cell) cell.classList.add('cal-selected')
  detail.dataset.activeKey = key

  const data = _calCache.byDay[key]
  const [yr, mo, dy] = key.split('-').map(Number)
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const dateLabel = `${MONTHS[mo - 1]} ${dy}, ${yr}`

  // Fills for this day
  const dayStart = new Date(yr, mo - 1, dy).getTime()
  const dayEnd   = dayStart + 86400000
  const dayFills = _calCache.fills.filter(f => f.time >= dayStart && f.time < dayEnd)

  // Aggregate by hash
  const groups = new Map()
  for (const f of dayFills) {
    const k = f.hash || `${f.time}_${f.coin}`
    if (!groups.has(k)) groups.set(k, { coin: f.coin, dir: f.dir, sz: 0, notional: 0, fee: 0, closedPnl: 0, time: f.time })
    const g = groups.get(k)
    g.sz += f.sz; g.notional += f.notional; g.fee += f.fee; g.closedPnl += f.closedPnl
  }
  const trades = [...groups.values()]
    .map(g => ({ ...g, px: g.sz > 0 ? g.notional / g.sz : 0 }))
    .sort((a, b) => a.time - b.time)

  // Ledger entries for this day
  const dayLedger = _calCache.ledger.filter(e => e.time >= dayStart && e.time < dayEnd)
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
          <span class="cal-detail-coin">${esc(t.coin)}</span>
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
          <span class="${isDeposit ? 'pos' : 'neg'}" style="font-family:'Space Mono',monospace;font-weight:700">${isDeposit ? '+' : '-'}$${fmtUSD(amt)} USDC</span>
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
      <button class="cal-detail-close" onclick="window.__calDayClick('${key}')">✕</button>
    </div>
    ${tradesHtml}${txHtml}
    ${!trades.length && !txEntries.length ? '<div style="color:var(--muted);font-size:12px;padding:12px 0">No activity on this day.</div>' : ''}`
}

export function renderPnLCalendar(fills, month, year, ledger = []) {
  const root = document.getElementById('calendarRoot')
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

  // Store in cache for click handler
  _calCache = { fills, ledger, byDay }

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

    cells += `<div class="${cls}"${hasActivity ? ` data-key="${key}" onclick="window.__calDayClick('${key}')"` : ''}>
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
      <button class="cal-nav-btn" onclick="calNav(-1)">◀ Prev</button>
      <div class="cal-month-label">${MONTHS[month]} ${year}</div>
      <button class="cal-nav-btn" onclick="calNav(1)">Next ▶</button>
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
  send:                { label: 'Received',            badge: 'badge-deposit',     sign: +1 },
  liquidation:         { label: 'Liquidation',        badge: 'badge-liquidation', sign: -1 },
  rewardsClaim:        { label: 'Rewards',            badge: 'badge-reward',      sign: +1 },
  subAccountTransfer:  { label: 'Sub-account',        badge: 'badge-transfer',    sign:  0 },
}

function ledgerAmount(entry) {
  const d = entry.delta
  switch (d.type) {
    case 'deposit':             return parseFloat(d.usdc)
    case 'withdraw':            return parseFloat(d.usdc)
    case 'accountClassTransfer':return parseFloat(d.usdc) * (d.toPerp ? 1 : -1)
    case 'internalTransfer':    return parseFloat(d.usdc)
    case 'subAccountTransfer':  return parseFloat(d.usdc)
    case 'spotTransfer':        return parseFloat(d.usdcValue ?? 0)
    case 'send':                return parseFloat(d.usdcValue ?? 0)
    case 'liquidation':         return parseFloat(d.accountValue ?? 0)
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

export function renderTransfers(ledger, filter = 'all') {
  const summaryEl = document.getElementById('transfersSummary')
  const tbody     = document.getElementById('transfersTbody')
  if (!summaryEl || !tbody) return

  const DEPOSIT_TYPES  = ['deposit','accountClassTransfer','internalTransfer','subAccountTransfer','spotTransfer','send']
  const WITHDRAW_TYPES = ['withdraw']

  const totalDeposited = ledger.reduce((s, e) => {
    if (e.delta.type === 'deposit') return s + parseFloat(e.delta.usdc ?? 0)
    if (e.delta.type === 'send' && e.delta.token === 'USDC') return s + parseFloat(e.delta.usdcValue ?? 0)
    return s
  }, 0)
  const totalWithdrawn = ledger
    .filter(e => e.delta.type === 'withdraw')
    .reduce((s, e) => s + parseFloat(e.delta.usdc ?? 0), 0)
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
    tbody.innerHTML = emptyRow(4, '📋', 'No transfers found')
    return
  }

  tbody.innerHTML = visible.slice().sort((a, b) => b.time - a.time).map(entry => {
    const meta   = TRANSFER_TYPES[entry.delta.type] ?? { label: entry.delta.type, badge: 'badge-transfer', sign: 0 }
    const amt    = ledgerAmount(entry)
    const amtStr = amt > 0 ? '+$' + fmtUSD(amt) : amt < 0 ? '-$' + fmtUSD(Math.abs(amt)) : '$0.00'
    const amtCls = meta.sign > 0 ? 'pos' : meta.sign < 0 ? 'neg' : 'muted'
    const date   = new Date(entry.time)
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
                    ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    return `<tr>
      <td style="color:var(--muted);white-space:nowrap;font-size:11px">${esc(dateStr)}</td>
      <td><span class="badge ${meta.badge}">${esc(meta.label)}</span></td>
      <td class="${amtCls}" style="font-family:'Space Mono',monospace">${esc(amtStr)}</td>
      <td style="color:var(--muted);font-size:11px">${esc(ledgerDetails(entry))}</td>
    </tr>`
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
