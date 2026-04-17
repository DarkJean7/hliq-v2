// ─── RISK MANAGEMENT MODULE ──────────────────────────────────────────────────
// Tracks session drawdown, loss streak, and liquidation proximity.
// Exposes a paused flag that the trade UI checks before allowing new orders.

const DEFAULT_THRESHOLDS = {
  maxDrawdownPct: 20,   // % drop from session high water mark → pause
  maxLossStreak:  5,    // consecutive losing closed trades → pause
  liqWarningPct:  20,   // % margin buffer below which to send notification
}

let rs = {
  paused:            false,
  pauseReason:       null,
  sessionStartValue: null,
  peakValue:         null,
  currentValue:      null,
  lossStreak:        0,
  thresholds:        { ...DEFAULT_THRESHOLDS },
  lastLiqNotifAt:    0,
}

// ─── INIT ────────────────────────────────────────────────────────────────────

export function initRisk(accountValue) {
  rs.sessionStartValue = accountValue
  rs.peakValue         = accountValue
  rs.currentValue      = accountValue
  rs.paused            = false
  rs.pauseReason       = null
  rs.lossStreak        = 0
}

// ─── THRESHOLDS ──────────────────────────────────────────────────────────────

export function setThresholds({ maxDrawdownPct, maxLossStreak, liqWarningPct }) {
  if (maxDrawdownPct != null) rs.thresholds.maxDrawdownPct = maxDrawdownPct
  if (maxLossStreak  != null) rs.thresholds.maxLossStreak  = maxLossStreak
  if (liqWarningPct  != null) rs.thresholds.liqWarningPct  = liqWarningPct
}

// ─── ACCOUNT VALUE ───────────────────────────────────────────────────────────
// Drawdown is measured from the SESSION START value (fixed), not a high water
// mark. This prevents open-position unrealized P&L fluctuations from
// tightening the threshold — only closed losses actually move the needle.

export function updateAccountValue(value) {
  if (rs.sessionStartValue == null) return // not initialised yet
  rs.currentValue = value
  // Still track the peak for display, but DON'T use it for the drawdown calc
  if (value > rs.peakValue) rs.peakValue = value

  const drawdownPct = rs.sessionStartValue > 0
    ? ((rs.sessionStartValue - rs.currentValue) / rs.sessionStartValue) * 100
    : 0

  if (!rs.paused) {
    if (drawdownPct >= rs.thresholds.maxDrawdownPct) {
      rs.paused      = true
      rs.pauseReason = `Drawdown limit: −${drawdownPct.toFixed(1)}% from session start ($${rs.sessionStartValue.toFixed(0)})`
    }
  } else if (rs.pauseReason?.startsWith('Drawdown')) {
    // Auto-resume if account recovered back above session start
    if (drawdownPct <= 0) {
      rs.paused      = false
      rs.pauseReason = null
    }
  }
}

// ─── LOSS STREAK ─────────────────────────────────────────────────────────────
// fills must be sorted newest-first (index 0 = most recent).
// Skips fills with closedPnl === 0 (pure open trades with no close component).

export function computeLossStreak(fills) {
  let streak = 0
  for (let i = 0; i < fills.length; i++) {
    const pnl = fills[i].closedPnl
    if (pnl === 0) continue       // open trade — neutral, skip but keep counting
    if (pnl < 0) streak++
    else break                    // hit a winning trade — streak ends
  }
  rs.lossStreak = streak

  if (!rs.paused && streak >= rs.thresholds.maxLossStreak) {
    rs.paused      = true
    rs.pauseReason = `Loss streak: ${streak} consecutive losses`
  }
}

// ─── LIQUIDATION CHECK ───────────────────────────────────────────────────────
// Returns { bufferPct, coin } for the position closest to liquidation,
// or null if no positions have a liquidation price.

export function checkLiquidation(perpState, allMids = {}) {
  const positions = perpState?.assetPositions ?? []
  if (!positions.length) return null

  let minBuffer = Infinity
  let worst     = null

  for (const { position: p } of positions) {
    const liqPx = parseFloat(p.liquidationPx ?? 0)
    if (!liqPx) continue

    const szi = parseFloat(p.szi ?? 0)
    if (!szi) continue

    // Prefer live allMids over positionValue/szi — more accurate
    const markPx = allMids[p.coin]
      ? parseFloat(allMids[p.coin])
      : Math.abs(parseFloat(p.positionValue ?? 0) / szi)
    if (!markPx) continue

    const entryPx = parseFloat(p.entryPx ?? 0)
    const side    = szi > 0 ? 'long' : 'short'

    // % of entry→liq range still intact: 100% = at entry (safe), 0% = at liq (liquidated)
    let bufferPct
    if (side === 'long' && entryPx > liqPx) {
      bufferPct = ((markPx - liqPx) / (entryPx - liqPx)) * 100
    } else if (side === 'short' && liqPx > entryPx) {
      bufferPct = ((liqPx - markPx) / (liqPx - entryPx)) * 100
    } else {
      // Fallback if entry/liq relationship is unexpected
      bufferPct = side === 'long'
        ? ((markPx - liqPx) / markPx) * 100
        : ((liqPx - markPx) / markPx) * 100
    }

    if (bufferPct < minBuffer) {
      minBuffer = bufferPct
      worst = { coin: p.coin, liqPx, markPx, entryPx, bufferPct, side }
    }
  }

  return worst
}

// ─── LIQUIDATION NOTIFICATION ────────────────────────────────────────────────

export function maybeSendLiqNotification(perpState, allMids = {}) {
  const liq = checkLiquidation(perpState, allMids)
  if (!liq) return
  if (liq.bufferPct > rs.thresholds.liqWarningPct) return

  const now = Date.now()
  if (now - rs.lastLiqNotifAt < 5 * 60 * 1000) return // throttle to 1 per 5 min

  rs.lastLiqNotifAt = now

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('⚠ Near Liquidation — Insolvent Terminal', {
      body: `${liq.coin} is ${liq.bufferPct.toFixed(1)}% from liquidation price. Check your positions.`,
      tag:  'liq-warning',
    })
  }
}

// ─── RESUME ──────────────────────────────────────────────────────────────────

export function resume() {
  rs.paused      = false
  rs.pauseReason = null
}

// ─── READ ────────────────────────────────────────────────────────────────────

export function isPaused() {
  return rs.paused
}

export function getRiskState() {
  // Drawdown vs session start (fixed baseline — not high water mark)
  const drawdownPct = (rs.sessionStartValue ?? 0) > 0
    ? ((rs.sessionStartValue - (rs.currentValue ?? rs.sessionStartValue)) / rs.sessionStartValue) * 100
    : 0
  return {
    paused:            rs.paused,
    pauseReason:       rs.pauseReason,
    currentValue:      rs.currentValue,
    peakValue:         rs.peakValue,
    sessionStartValue: rs.sessionStartValue,
    drawdownPct,
    lossStreak:        rs.lossStreak,
    thresholds:        { ...rs.thresholds },
  }
}

// ─── BROWSER NOTIFICATIONS ───────────────────────────────────────────────────

export function requestNotifications() {
  if (typeof Notification === 'undefined') return Promise.resolve('unsupported')
  if (Notification.permission === 'granted') return Promise.resolve('granted')
  return Notification.requestPermission()
}

export function notifPermission() {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}
