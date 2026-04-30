import Chart from 'chart.js/auto'
import { fmtTimeShort, fmtUSD } from './format.js'

let portfolioChartInst = null
let pnlChartInst       = null

// Hover listener refs — removed before re-attaching to avoid duplicates
const _valHandlers = { move: null, leave: null }
const _pnlHandlers = { move: null, leave: null }

export function destroyCharts() {
  portfolioChartInst?.destroy()
  pnlChartInst?.destroy()
  portfolioChartInst = null
  pnlChartInst       = null
}

/**
 * Attach Drift-style hover: update hero element while scrubbing the chart.
 * handlers = { move, leave } module-level object so old listeners can be removed.
 * formatFn(val, label) → HTML string
 */
function attachHover(chart, canvasId, heroId, defaultHtml, formatFn, handlers) {
  const canvas = document.getElementById(canvasId)
  if (!canvas) return

  // Set default immediately so hero is visible on load, not only after hover
  const heroEl = document.getElementById(heroId)
  if (heroEl) heroEl.innerHTML = defaultHtml

  // Remove stale listeners from previous render
  if (handlers.move)  canvas.removeEventListener('mousemove',  handlers.move)
  if (handlers.leave) canvas.removeEventListener('mouseleave', handlers.leave)

  handlers.move = e => {
    const pts = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true)
    if (!pts.length) return
    const idx = pts[0].index
    const val = chart.data.datasets[0].data[idx]
    const lbl = chart.data.labels[idx]
    const el  = document.getElementById(heroId)
    if (el) el.innerHTML = formatFn(val, lbl)
  }

  handlers.leave = () => {
    const el = document.getElementById(heroId)
    if (el) el.innerHTML = defaultHtml
  }

  canvas.addEventListener('mousemove',  handlers.move)
  canvas.addEventListener('mouseleave', handlers.leave)
}

/**
 * Render account value + PnL charts for a given period
 * portfolioData: raw HL portfolio response array
 * period: 'day' | 'week' | 'month' | 'allTime'
 */
export function renderCharts(portfolioData, period) {
  const periodEntry = portfolioData.find(p => p[0] === period)
  if (!periodEntry) return { valDiff: 0, valPct: 0, lastPnl: 0 }

  const data       = periodEntry[1]
  const valHistory = data.accountValueHistory ?? []
  const pnlHistory = data.pnlHistory ?? []

  // ── Account Value Chart ──────────────────────────────────────────────────
  const valLabels = valHistory.map(p => fmtTimeShort(p[0]))
  const valValues = valHistory.map(p => parseFloat(p[1]))

  const ctx1 = document.getElementById('portfolioChart').getContext('2d')
  portfolioChartInst?.destroy()

  const grad1 = ctx1.createLinearGradient(0, 0, 0, 180)
  grad1.addColorStop(0, 'rgba(0,255,204,0.16)')
  grad1.addColorStop(1, 'rgba(0,255,204,0)')

  portfolioChartInst = new Chart(ctx1, {
    type: 'line',
    data: {
      labels: valLabels,
      datasets: [{
        data:            valValues,
        borderColor:     '#00ffcc',
        backgroundColor: grad1,
        borderWidth:     2,
        pointRadius:     0,
        pointHoverRadius: 5,
        fill:            true,
        tension:         0.4,
      }],
    },
    options: makeChartOptions(),
    plugins: [crosshairPlugin],
  })

  // ── PnL Chart ────────────────────────────────────────────────────────────
  const pnlLabels = pnlHistory.map(p => fmtTimeShort(p[0]))
  const pnlValues = pnlHistory.map(p => parseFloat(p[1]))
  const lastPnl   = pnlValues.at(-1) ?? 0
  const pnlColor  = lastPnl >= 0 ? '#00e5a0' : '#ff4d6d'

  const ctx2 = document.getElementById('pnlChart').getContext('2d')
  pnlChartInst?.destroy()

  const grad2 = ctx2.createLinearGradient(0, 0, 0, 180)
  grad2.addColorStop(0, lastPnl >= 0 ? 'rgba(0,229,160,0.16)' : 'rgba(255,77,109,0.16)')
  grad2.addColorStop(1, 'rgba(0,0,0,0)')

  pnlChartInst = new Chart(ctx2, {
    type: 'line',
    data: {
      labels: pnlLabels,
      datasets: [{
        data:            pnlValues,
        borderColor:     pnlColor,
        backgroundColor: grad2,
        borderWidth:     2,
        pointRadius:     0,
        pointHoverRadius: 5,
        fill:            true,
        tension:         0.4,
      }],
    },
    options: makeChartOptions(),
    plugins: [crosshairPlugin],
  })

  // Return hero numbers for the period
  const firstVal = valValues[0]   ?? 0
  const lastVal  = valValues.at(-1) ?? 0
  const valDiff  = lastVal - firstVal
  const valPct   = firstVal !== 0 ? (valDiff / firstVal) * 100 : 0

  // ── Drift-style hero hover ─────────────────────────────────────────────
  // These are computed here so attachHover captures the correct defaultHtml.
  const vCls   = valDiff >= 0 ? 'pos' : 'neg'
  const vSign  = valDiff >= 0 ? '+' : ''
  const valDefaultHtml = `
    <div class="portfolio-pnl-num ${vCls}">$${fmtUSD(lastVal)}</div>
    <div class="portfolio-pnl-pct ${vCls}">${vSign}$${fmtUSD(Math.abs(valDiff))} &nbsp;${vSign}${valPct.toFixed(2)}%</div>`

  const pCls  = lastPnl >= 0 ? 'pos' : 'neg'
  const pSign = lastPnl >= 0 ? '+' : '-'
  const pnlDefaultHtml = `
    <div class="portfolio-pnl-num ${pCls}">${pSign}$${fmtUSD(Math.abs(lastPnl))}</div>`

  attachHover(
    portfolioChartInst,
    'portfolioChart',
    'portfolioValueHero',
    valDefaultHtml,
    (val, lbl) => {
      const diff  = val - (valValues[0] ?? val)
      const pct   = (valValues[0] ?? 0) !== 0 ? (diff / valValues[0]) * 100 : 0
      const cls   = diff >= 0 ? 'pos' : 'neg'
      const sign  = diff >= 0 ? '+' : ''
      return `
        <div class="portfolio-pnl-num ${cls}">$${fmtUSD(val)}</div>
        <div class="portfolio-pnl-pct ${cls}">${sign}$${fmtUSD(Math.abs(diff))} &nbsp;${sign}${pct.toFixed(2)}%</div>
        <div class="portfolio-pnl-date">${lbl}</div>`
    },
    _valHandlers
  )

  attachHover(
    pnlChartInst,
    'pnlChart',
    'pnlHero',
    pnlDefaultHtml,
    (val, lbl) => {
      const cls  = val >= 0 ? 'pos' : 'neg'
      const sign = val >= 0 ? '+' : '-'
      return `
        <div class="portfolio-pnl-num ${cls}">${sign}$${fmtUSD(Math.abs(val))}</div>
        <div class="portfolio-pnl-date">${lbl}</div>`
    },
    _pnlHandlers
  )

  return { valDiff, valPct, lastVal, lastPnl, valDefaultHtml, pnlDefaultHtml }
}

// Vertical crosshair line drawn at the hovered index
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? []
    if (!active.length) return
    const { ctx, chartArea: { top, bottom } } = chart
    const x = active[0].element.x
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, bottom)
    ctx.lineWidth   = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.setLineDash([4, 4])
    ctx.stroke()
    ctx.restore()
  },
}

function makeChartOptions() {
  return {
    responsive:  true,
    animation:   { duration: window.innerWidth <= 768 ? 0 : 500 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend:      { display: false },
      tooltip:     { enabled: false },
      yPriceBoxes: false,
    },
    scales: {
      x: {
        grid:   { color: 'rgba(255,255,255,0.03)' },
        ticks:  { color: '#6b6b80', font: { family: 'Space Mono', size: 9 }, maxTicksLimit: 6 },
        border: { color: 'rgba(255,255,255,0.07)' },
      },
      y: {
        grid:  { color: 'rgba(255,255,255,0.03)' },
        ticks: {
          color:    '#6b6b80',
          font:     { family: 'Space Mono', size: 9 },
          callback: v => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)),
        },
        border: { color: 'rgba(255,255,255,0.07)' },
      },
    },
  }
}