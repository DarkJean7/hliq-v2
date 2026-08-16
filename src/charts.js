import Chart from 'chart.js/auto'
import { fmtTimeShort, fmtUSD, fmtPrice } from './format.js'

let portfolioChartInst = null
let pnlChartInst       = null

const _valHandlers = { move: null, leave: null }
const _pnlHandlers = { move: null, leave: null }

let _lastPortfolioData = null
let _lastFills         = []
let _lastPeriod        = 'day'
let _pnlChartType      = 'accumulative'

// ── Accounts tab chart instances ─────────────────────────────────────────────
let maPortfolioChartInst = null
let maPnlChartInst       = null
const _maValHandlers = { move: null, leave: null }
const _maPnlHandlers = { move: null, leave: null }
let _maLastPortfolioData = null
let _maLastFills         = []
let _maLastPeriod        = 'day'
let _maPnlChartType      = 'accumulative'

export function destroyCharts() {
  portfolioChartInst?.destroy()
  pnlChartInst?.destroy()
  portfolioChartInst = null
  pnlChartInst       = null
}

export function destroyAcctCharts() {
  maPortfolioChartInst?.destroy()
  maPnlChartInst?.destroy()
  maPortfolioChartInst = null
  maPnlChartInst       = null
}

// ── Overview hero account-value chart ───────────────────────────────────────
let ovChartInst = null
export function destroyOverviewChart() { ovChartInst?.destroy(); ovChartInst = null }

// Clean, minimal options matching the mobile portfolio chart: no x-axis labels/grid,
// full-$ labels on the right, smooth curve.
function _ovChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { type: 'linear', display: false },
      y: {
        position: 'right',
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: '#9aa0b0', font: { family: 'Space Mono', size: 11 }, padding: 6, maxTicksLimit: 4,
          callback: v => '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }),
        },
      },
    },
  }
}

// Returns { first, last } of the visible series so the caller can show the period change.
export function renderOverviewChart(portfolioData, period = 'week', type = 'value', fills = []) {
  const canvas = document.getElementById('overviewChart')
  if (!canvas) return null
  const entry = (portfolioData || []).find(p => p[0] === period)
             ?? (portfolioData || []).find(p => p[0] === 'allTime')

  let data = []
  if (type === 'accumulated') {
    data = (entry?.[1]?.pnlHistory ?? []).map(p => ({ x: +p[0], y: parseFloat(p[1]) }))
  } else if (type === 'realized') {
    const buckets = (entry?.[1]?.pnlHistory ?? []).map(p => +p[0])
    if (buckets.length >= 2) {
      const periodMs = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }
      const cutoff   = period === 'allTime' ? 0 : Date.now() - (periodMs[period] ?? 864e5)
      const bp = new Array(buckets.length).fill(0)
      for (const f of (fills || [])) {
        if (!f.closedPnl || f.time < cutoff) continue
        let idx = buckets.findIndex((ts, i) => ts > f.time || i === buckets.length - 1)
        if (idx < 0) idx = buckets.length - 1
        bp[idx] += f.closedPnl
      }
      let run = 0
      data = buckets.map((ts, i) => ({ x: ts, y: (run += bp[i]) }))
    }
  } else {
    data = (entry?.[1]?.accountValueHistory ?? []).map(p => ({ x: +p[0], y: parseFloat(p[1]) }))
  }
  data = data.filter(d => Number.isFinite(d.y))
  if (data.length < 2) { destroyOverviewChart(); return null }

  const up   = data[data.length - 1].y >= data[0].y
  const col  = up ? '#00e5a0' : '#ff4d6d'
  const gTop = up ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)'

  const ds = {
    data, borderColor: col, backgroundColor: _gradFn(gTop, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.35,
  }
  if (ovChartInst?.canvas === canvas) {
    Object.assign(ovChartInst.data.datasets[0], ds)
    ovChartInst.update('none')
  } else {
    ovChartInst?.destroy()
    ovChartInst = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: [ds] },
      options: _ovChartOptions(),   // clean look matching the mobile portfolio chart
      plugins: [crosshairPlugin, zeroLinePlugin],   // zeroLine draws a $0 baseline when 0 is in range
    })
  }
  return { first: data[0].y, last: data[data.length - 1].y }
}

// ── Performance tab charts ───────────────────────────────────────────────────
// Generic interactive cumulative-PnL chart, reused for the combined chart and one
// per market. Matches the overview/portfolio look (clean axes, crosshair, $0 line)
// and drives a hover hero element. Instances are keyed by canvas id.
const perfChartInsts = {}
const perfHandlers   = {}

export function destroyPerfCharts() {
  for (const k of Object.keys(perfChartInsts)) {
    perfChartInsts[k]?.destroy()
    delete perfChartInsts[k]
  }
}

export function renderPerfChart(canvasId, points, heroId = null) {
  const canvas = document.getElementById(canvasId)
  if (!canvas) return
  const data = (points || []).filter(p => Number.isFinite(p.y))

  if (data.length < 2) {
    perfChartInsts[canvasId]?.destroy()
    delete perfChartInsts[canvasId]
    const h = heroId && document.getElementById(heroId)
    if (h) h.innerHTML = `<div class="portfolio-pnl-num neu" style="font-size:14px;color:var(--muted)">No closed trades in range</div>`
    return
  }

  const last = data[data.length - 1].y
  const up   = last >= 0
  const col  = up ? '#00e5a0' : '#ff4d6d'
  const grad = up ? 'rgba(0,229,160,0.18)' : 'rgba(255,77,109,0.18)'
  const ds   = {
    data, borderColor: col, backgroundColor: _gradFn(grad, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.3,
  }

  if (perfChartInsts[canvasId]?.canvas === canvas) {
    Object.assign(perfChartInsts[canvasId].data.datasets[0], ds)
    perfChartInsts[canvasId].update('none')
  } else {
    perfChartInsts[canvasId]?.destroy()
    perfChartInsts[canvasId] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: [ds] },
      options: _ovChartOptions(),
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }

  if (heroId) {
    const sign = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
    const defHtml = `<div class="portfolio-pnl-num ${up ? 'pos' : 'neg'}">${sign(last)}</div>`
    perfHandlers[canvasId] = perfHandlers[canvasId] || { move: null, leave: null }
    attachHover(perfChartInsts[canvasId], canvasId, heroId, defHtml, (val, lbl) =>
      `<div class="portfolio-pnl-num ${val >= 0 ? 'pos' : 'neg'}">${sign(val)}</div>
       <div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`, perfHandlers[canvasId])
  }
}

Object.defineProperty(window, 'maPortfolioChartInst', { get: () => maPortfolioChartInst })
Object.defineProperty(window, 'maPnlChartInst',       { get: () => maPnlChartInst })

// ── Helpers ───────────────────────────────────────────────────────────────────

function _gradFn(top, bot) {
  return function(context) {
    const { ctx, chartArea } = context.chart
    if (!chartArea) return top
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
    g.addColorStop(0,   top)
    g.addColorStop(1,   bot)
    return g
  }
}

function _pinLabel(v) {
  const abs  = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  return sign + '$' + (abs >= 1000 ? (abs / 1000).toFixed(2) + 'k' : abs.toFixed(2))
}

function _showResetBtn(id, show) {
  const el = document.getElementById(id)
  if (el) el.style.display = show ? '' : 'none'
}

function _setPeriodView(chart, period) {
  if (!chart) return
  if (period === 'allTime') { chart.resetZoom(); return }
  try {
    const ms  = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }
    const now = Date.now()
    chart.zoomScale('x', { min: now - (ms[period] ?? 864e5), max: now + 3600e3 })
  } catch (_) {}
}

export function zoomAcctChartsToPeriod(period) {
  _maLastPeriod = period
  // Period now selects the data series (clean style), so re-render both charts.
  if (_maLastPortfolioData) renderAcctCharts(_maLastPortfolioData, period, _maLastFills)
}

function attachHover(chart, canvasId, heroId, defaultHtml, formatFn, handlers) {
  const canvas = document.getElementById(canvasId)
  if (!canvas) return

  const heroEl = document.getElementById(heroId)
  if (heroEl) heroEl.innerHTML = defaultHtml

  if (handlers.move)  canvas.removeEventListener('mousemove',  handlers.move)
  if (handlers.leave) canvas.removeEventListener('mouseleave', handlers.leave)

  handlers.move = e => {
    const pts = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true)
    if (!pts.length) return
    const idx  = pts[0].index
    const item = chart.data.datasets[0].data[idx]
    const val  = (item && typeof item === 'object') ? item.y : item
    const lbl  = (item && typeof item === 'object') ? item.x : (chart.data.labels?.[idx] ?? idx)
    const el   = document.getElementById(heroId)
    if (el) el.innerHTML = formatFn(val, lbl, chart)
  }

  handlers.leave = () => {
    const el = document.getElementById(heroId)
    if (el) el.innerHTML = defaultHtml
  }

  canvas.addEventListener('mousemove',  handlers.move)
  canvas.addEventListener('mouseleave', handlers.leave)
}

// ── Portfolio Tab Charts ───────────────────────────────────────────────────────

export function renderCharts(portfolioData, period, fills = [], { resetZoom = true } = {}) {
  if (!portfolioData?.length) return { valDiff: 0, valPct: 0, lastPnl: 0 }
  _lastPortfolioData = portfolioData
  _lastFills         = fills
  if (period != null) _lastPeriod = period

  const allTimeEntry = portfolioData.find(p => p[0] === 'allTime')
                    ?? portfolioData[portfolioData.length - 1]
  if (!allTimeEntry) return { valDiff: 0, valPct: 0, lastPnl: 0 }

  // Select the series for the chosen period directly (clean overview/mobile look —
  // data is sliced by period in JS rather than zoom-panned over the all-time curve).
  const periodEntry = portfolioData.find(p => p[0] === _lastPeriod) ?? allTimeEntry
  const valHistory  = periodEntry[1].accountValueHistory ?? []

  const valData = valHistory.map(p => ({ x: +p[0], y: parseFloat(p[1]) })).filter(d => Number.isFinite(d.y))

  const canvasEl = document.getElementById('portfolioChart')
  if (!canvasEl) return { valDiff: 0, valPct: 0, lastPnl: 0 }

  const vUp   = (valData.at(-1)?.y ?? 0) >= (valData[0]?.y ?? 0)
  const vCol  = vUp ? '#00e5a0' : '#ff4d6d'
  const vGrad = vUp ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)'
  const vDs = {
    data: valData, borderColor: vCol, backgroundColor: _gradFn(vGrad, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.35,
  }

  if (portfolioChartInst?.canvas === canvasEl) {
    Object.assign(portfolioChartInst.data.datasets[0], vDs)
    portfolioChartInst.update('none')
  } else {
    portfolioChartInst?.destroy()
    portfolioChartInst = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { datasets: [vDs] },
      options: _ovChartOptions(),
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }

  _renderPnlChart(portfolioData, fills, resetZoom)

  const firstVal       = valData[0]?.y ?? 0
  const lastVal        = valData.at(-1)?.y ?? 0
  const valDiff        = lastVal - firstVal
  const valPct         = firstVal !== 0 ? (valDiff / firstVal) * 100 : 0
  const vCls           = valDiff >= 0 ? 'pos' : 'neg'
  const vSign          = valDiff >= 0 ? '+' : ''
  const valDefaultHtml = `
    <div class="portfolio-pnl-num ${vCls}">$${fmtUSD(lastVal)}</div>
    <div class="portfolio-pnl-pct ${vCls}">${vSign}$${fmtUSD(Math.abs(valDiff))} &nbsp;${vSign}${valPct.toFixed(2)}%</div>`

  attachHover(portfolioChartInst, 'portfolioChart', 'portfolioValueHero', valDefaultHtml, (val, lbl, ch) => {
    const xMin    = ch?.scales?.x?.min ?? 0
    const visBase = valData.find(d => d.x >= xMin)?.y ?? (valData[0]?.y ?? val)
    const diff    = val - visBase
    const pct     = visBase !== 0 ? (diff / visBase) * 100 : 0
    const cls     = diff >= 0 ? 'pos' : 'neg'
    const sign    = diff >= 0 ? '+' : ''
    return `
      <div class="portfolio-pnl-num ${cls}">$${fmtUSD(val)}</div>
      <div class="portfolio-pnl-pct ${cls}">${sign}$${fmtUSD(Math.abs(diff))} &nbsp;${sign}${pct.toFixed(2)}%</div>
      <div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`
  }, _valHandlers)

  return { valDiff, valPct, lastVal, lastPnl: lastVal }
}

function _renderPnlChart(portfolioData, fills, resetZoom = true) {
  const periodEntry = portfolioData.find(p => p[0] === _lastPeriod)
                   ?? portfolioData.find(p => p[0] === 'allTime')
  const pnlHistory  = periodEntry?.[1]?.pnlHistory ?? []

  let pnlData
  if (_pnlChartType === 'realized') {
    const periodMs = { day: 864e5, week: 7*864e5, month: 30*864e5 }
    const cutoff   = _lastPeriod === 'allTime' ? 0 : Date.now() - (periodMs[_lastPeriod] ?? 864e5)
    const buckets  = pnlHistory.map(p => +p[0])
    if (buckets.length < 2) {
      pnlData = []
    } else {
      const bucketPnl = new Array(buckets.length).fill(0)
      for (const f of fills) {
        if (!f.closedPnl || f.time < cutoff) continue
        let idx = buckets.findIndex((ts, i) => ts > f.time || i === buckets.length - 1)
        if (idx < 0) idx = buckets.length - 1
        bucketPnl[idx] += f.closedPnl
      }
      let running = 0
      pnlData = buckets.map((ts, i) => ({ x: ts, y: (running += bucketPnl[i]) }))
    }
  } else {
    pnlData = pnlHistory.map(p => ({ x: +p[0], y: parseFloat(p[1]) }))
  }

  const lastVal = pnlData.at(-1)?.y ?? 0
  const col     = lastVal >= 0 ? '#00e5a0' : '#ff4d6d'
  const gradTop = lastVal >= 0 ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)'

  const canvasEl = document.getElementById('pnlChart')
  if (!canvasEl) return

  const pDs = {
    data: pnlData, borderColor: col, backgroundColor: _gradFn(gradTop, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.35,
  }
  if (pnlChartInst?.canvas === canvasEl) {
    Object.assign(pnlChartInst.data.datasets[0], pDs)
    pnlChartInst.update('none')
  } else {
    pnlChartInst?.destroy()
    pnlChartInst = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { datasets: [pDs] },
      options: _ovChartOptions(),
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }

  const pCls  = lastVal >= 0 ? 'pos' : 'neg'
  const pSign = lastVal >= 0 ? '+' : '-'
  const defaultHtml = `<div class="portfolio-pnl-num ${pCls}">${pSign}$${fmtUSD(Math.abs(lastVal))}</div>`

  attachHover(pnlChartInst, 'pnlChart', 'pnlHero', defaultHtml, (val, lbl) => {
    const cls  = val >= 0 ? 'pos' : 'neg'
    const sign = val >= 0 ? '+' : '-'
    return `
      <div class="portfolio-pnl-num ${cls}">${sign}$${fmtUSD(Math.abs(val))}</div>
      <div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`
  }, _pnlHandlers)
}

export function setPnlChartType(type) {
  _pnlChartType = type
  const titleEl = document.getElementById('pnlChartTitle')
  if (titleEl) titleEl.textContent = type === 'realized' ? 'Realized PnL' : 'Accumulative PnL'
  if (!_lastPortfolioData) return
  _renderPnlChart(_lastPortfolioData, _lastFills, false)
}

// ── Accounts Tab Charts ───────────────────────────────────────────────────────

export function renderAcctCharts(portfolioData, period, fills = [], { resetZoom = true } = {}) {
  _maLastPortfolioData = portfolioData
  _maLastFills         = fills
  if (period != null) _maLastPeriod = period

  const allTimeEntry = portfolioData.find(p => p[0] === 'allTime')
                    ?? portfolioData[portfolioData.length - 1]
  if (!allTimeEntry) return

  // Select the chosen period's series directly (clean look — sliced in JS, no zoom)
  const periodEntry = portfolioData.find(p => p[0] === _maLastPeriod) ?? allTimeEntry
  const valHistory  = periodEntry[1].accountValueHistory ?? []
  const valData = valHistory.map(p => ({ x: +p[0], y: parseFloat(p[1]) })).filter(d => Number.isFinite(d.y))

  const canvasEl = document.getElementById('maPortfolioChart')
  if (!canvasEl) return

  const vUp   = (valData.at(-1)?.y ?? 0) >= (valData[0]?.y ?? 0)
  const vCol  = vUp ? '#00e5a0' : '#ff4d6d'
  const vGrad = vUp ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)'
  const vDs = {
    data: valData, borderColor: vCol, backgroundColor: _gradFn(vGrad, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.35,
  }

  if (maPortfolioChartInst?.canvas === canvasEl) {
    Object.assign(maPortfolioChartInst.data.datasets[0], vDs)
    maPortfolioChartInst.update('none')
  } else {
    maPortfolioChartInst?.destroy()
    maPortfolioChartInst = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { datasets: [vDs] },
      options: _ovChartOptions(),
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }
  _showResetBtn('maValResetZoom', false)

  _renderAcctPnlChart(portfolioData, fills, resetZoom)

  const firstVal       = valData[0]?.y ?? 0
  const lastVal        = valData.at(-1)?.y ?? 0
  const valDiff        = lastVal - firstVal
  const valPct         = firstVal !== 0 ? (valDiff / firstVal) * 100 : 0
  const vCls           = valDiff >= 0 ? 'pos' : 'neg'
  const vSign          = valDiff >= 0 ? '+' : ''
  const valDefaultHtml = `
    <div class="portfolio-pnl-num ${vCls}">$${fmtUSD(lastVal)}</div>
    <div class="portfolio-pnl-pct ${vCls}">${vSign}$${fmtUSD(Math.abs(valDiff))} &nbsp;${vSign}${valPct.toFixed(2)}%</div>`

  attachHover(maPortfolioChartInst, 'maPortfolioChart', 'maPortfolioValueHero', valDefaultHtml, (val, lbl, ch) => {
    const xMin    = ch?.scales?.x?.min ?? 0
    const visBase = valData.find(d => d.x >= xMin)?.y ?? (valData[0]?.y ?? val)
    const diff    = val - visBase
    const pct     = visBase !== 0 ? (diff / visBase) * 100 : 0
    const cls     = diff >= 0 ? 'pos' : 'neg'
    const sign    = diff >= 0 ? '+' : ''
    return `
      <div class="portfolio-pnl-num ${cls}">$${fmtUSD(val)}</div>
      <div class="portfolio-pnl-pct ${cls}">${sign}$${fmtUSD(Math.abs(diff))} &nbsp;${sign}${pct.toFixed(2)}%</div>
      <div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`
  }, _maValHandlers)
}

function _renderAcctPnlChart(portfolioData, fills, resetZoom = true) {
  const periodEntry = portfolioData.find(p => p[0] === _maLastPeriod)
                   ?? portfolioData.find(p => p[0] === 'allTime')
  const pnlHistory  = periodEntry?.[1]?.pnlHistory ?? []

  let pnlData
  if (_maPnlChartType === 'realized') {
    const periodMs = { day: 864e5, week: 7*864e5, month: 30*864e5 }
    const cutoff   = _maLastPeriod === 'allTime' ? 0 : Date.now() - (periodMs[_maLastPeriod] ?? 864e5)
    const buckets  = pnlHistory.map(p => +p[0])
    if (buckets.length < 2) {
      pnlData = []
    } else {
      const bucketPnl = new Array(buckets.length).fill(0)
      for (const f of fills) {
        if (!f.closedPnl || f.time < cutoff) continue
        let idx = buckets.findIndex((ts, i) => ts > f.time || i === buckets.length - 1)
        if (idx < 0) idx = buckets.length - 1
        bucketPnl[idx] += f.closedPnl
      }
      let running = 0
      pnlData = buckets.map((ts, i) => ({ x: ts, y: (running += bucketPnl[i]) }))
    }
  } else {
    pnlData = pnlHistory.map(p => ({ x: +p[0], y: parseFloat(p[1]) }))
  }

  const lastVal = pnlData.at(-1)?.y ?? 0
  const col     = lastVal >= 0 ? '#00e5a0' : '#ff4d6d'
  const gradTop = lastVal >= 0 ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)'

  const canvasEl = document.getElementById('maPnlChart')
  if (!canvasEl) return

  const pDs = {
    data: pnlData, borderColor: col, backgroundColor: _gradFn(gradTop, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.35,
  }
  if (maPnlChartInst?.canvas === canvasEl) {
    Object.assign(maPnlChartInst.data.datasets[0], pDs)
    maPnlChartInst.update('none')
  } else {
    maPnlChartInst?.destroy()
    maPnlChartInst = new Chart(canvasEl.getContext('2d'), {
      type: 'line',
      data: { datasets: [pDs] },
      options: _ovChartOptions(),
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }
  _showResetBtn('maPnlResetZoom', false)

  const pCls  = lastVal >= 0 ? 'pos' : 'neg'
  const pSign = lastVal >= 0 ? '+' : '-'
  const defaultHtml = `<div class="portfolio-pnl-num ${pCls}">${pSign}$${fmtUSD(Math.abs(lastVal))}</div>`

  attachHover(maPnlChartInst, 'maPnlChart', 'maPnlHero', defaultHtml, (val, lbl) => {
    const cls  = val >= 0 ? 'pos' : 'neg'
    const sign = val >= 0 ? '+' : '-'
    return `
      <div class="portfolio-pnl-num ${cls}">${sign}$${fmtUSD(Math.abs(val))}</div>
      <div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`
  }, _maPnlHandlers)
}

export function setAcctPnlChartType(type) {
  _maPnlChartType = type
  const titleEl = document.getElementById('maPnlChartTitle')
  if (titleEl) titleEl.textContent = type === 'realized' ? 'Realized PnL' : 'Accumulative PnL'
  if (!_maLastPortfolioData) return
  _renderAcctPnlChart(_maLastPortfolioData, _maLastFills, false)
}

// ── Shared chart config ───────────────────────────────────────────────────────

function _makeInteractiveOptions(onZoom) {
  const base = makeChartOptions()
  return {
    ...base,
    animation: false,
    plugins: {
      ...base.plugins,
      zoom: {
        pan:  { enabled: true, mode: 'x' },
        zoom: { wheel: { enabled: true, speed: 0.08 }, pinch: { enabled: true }, mode: 'x', onZoom },
      },
    },
  }
}

// ── Plugins ───────────────────────────────────────────────────────────────────

// Vertical + horizontal crosshair with a Y-axis cursor tag
const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? []
    if (!active.length) return
    const { ctx, chartArea: { top, bottom, left, right } } = chart
    const xPx = active[0].element.x
    const yPx = active[0].element.y

    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])

    ctx.beginPath(); ctx.moveTo(xPx, top);  ctx.lineTo(xPx, bottom); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(left, yPx); ctx.lineTo(right, yPx);  ctx.stroke()
    ctx.setLineDash([])

    // Y-axis cursor tag
    const idx  = active[0].index
    const item = chart.data.datasets[0].data[idx]
    const yVal = typeof item === 'object' ? item.y : item
    if (yVal != null && !isNaN(yVal)) {
      const label = _pinLabel(yVal)
      ctx.font = '9px "Space Mono", monospace'
      const tw  = ctx.measureText(label).width
      const bw  = tw + 10
      const bh  = 15
      const bx  = right + 1
      const by  = yPx - bh / 2
      ctx.fillStyle = 'rgba(70,70,90,0.95)'
      ctx.fillRect(bx, by, bw, bh)
      ctx.fillStyle    = '#b0b0c8'
      ctx.textBaseline = 'middle'
      ctx.textAlign    = 'left'
      ctx.fillText(label, bx + 5, yPx)
    }

    ctx.restore()
  },
}

// Floating last-price pin: dashed line at current value + colored tag on right axis
const lastPricePinPlugin = {
  id: 'lastPricePin',
  afterDraw(chart) {
    const dataset = chart.data.datasets[0]
    if (!dataset?.data?.length) return
    const last = dataset.data[dataset.data.length - 1]
    const yVal = typeof last === 'object' ? last.y : last
    if (yVal == null || isNaN(yVal)) return

    const yScale = chart.scales.y
    const yPx    = yScale.getPixelForValue(yVal)
    if (yPx < yScale.top - 1 || yPx > yScale.bottom + 1) return

    const { ctx, chartArea } = chart
    const col = typeof dataset.borderColor === 'string' ? dataset.borderColor : '#00ffcc'

    ctx.save()

    // Dashed horizontal line across chart area at last price
    ctx.beginPath()
    ctx.moveTo(chartArea.left, yPx)
    ctx.lineTo(chartArea.right, yPx)
    ctx.lineWidth   = 1
    ctx.strokeStyle = col + '50'
    ctx.setLineDash([3, 4])
    ctx.stroke()
    ctx.setLineDash([])

    // Colored price tag on right axis (overlays ticks at that position)
    const label = _pinLabel(yVal)
    ctx.font = 'bold 9px "Space Mono", monospace'
    const tw  = ctx.measureText(label).width
    const bw  = tw + 10
    const bh  = 16
    const bx  = chartArea.right + 1
    const by  = yPx - bh / 2

    ctx.fillStyle = col
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2); ctx.fill()
    } else {
      ctx.fillRect(bx, by, bw, bh)
    }

    ctx.fillStyle    = '#0a0a12'
    ctx.textBaseline = 'middle'
    ctx.textAlign    = 'left'
    ctx.fillText(label, bx + 5, yPx)
    ctx.restore()
  },
}

// Solid y=0 baseline — only added to PnL chart instances
const zeroLinePlugin = {
  id: 'zeroLine',
  afterDraw(chart) {
    const yScale = chart.scales.y
    if (!yScale) return
    const yPx = yScale.getPixelForValue(0)
    if (yPx < yScale.top || yPx > yScale.bottom) return
    const { ctx, chartArea } = chart
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(chartArea.left, yPx)
    ctx.lineTo(chartArea.right, yPx)
    ctx.lineWidth   = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.stroke()
    ctx.restore()
  },
}

function makeChartOptions() {
  return {
    responsive:           true,
    maintainAspectRatio:  false,
    animation:            { duration: window.innerWidth <= 768 ? 0 : 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend:   { display: false },
      tooltip:  { enabled: false },
    },
    scales: {
      x: {
        type:   'linear',
        grid:   { color: 'rgba(255,255,255,0.04)', drawTicks: false },
        ticks:  {
          color: '#505068', font: { family: 'Space Mono', size: 9 },
          maxTicksLimit: 6, padding: 6,
          callback: v => fmtTimeShort(v),
        },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        position: 'right',
        afterFit:  scale => { scale.width = Math.max(scale.width, 74) },
        grid:     { color: 'rgba(255,255,255,0.04)', drawTicks: false },
        ticks: {
          color:    '#505068',
          font:     { family: 'Space Mono', size: 9 },
          padding:  6,
          callback: v => {
            const abs = Math.abs(v)
            const sign = v < 0 ? '-' : ''
            return sign + '$' + (abs >= 1000 ? (abs / 1000).toFixed(1) + 'k' : abs.toFixed(0))
          },
        },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
    },
  }
}

// ── Mobile trade-detail price chart (interactive, like the portfolio charts) ────

let mobTradeChartInst = null
let _mobOverlays = []

export function destroyMobTradeChart() {
  mobTradeChartInst?.destroy()
  mobTradeChartInst = null
  _mobOverlays = []
}

export function resetMobTradeChart() {
  if (!mobTradeChartInst) return
  try {
    mobTradeChartInst.resetZoom()
    _mobAutoScaleY(mobTradeChartInst)
    mobTradeChartInst.update('none')
  } catch {}
}

// Position levels (entry/liq/tp/sl) draw as dashed lines with a right-axis tag.
// Open orders (type 'dot') draw as a small dot in the price column instead.
const mobOverlayLinesPlugin = {
  id: 'mobOverlayLines',
  afterDraw(chart) {
    if (!_mobOverlays.length) return
    const yScale = chart.scales.y
    const { ctx, chartArea } = chart

    // ── Dotted-line levels with tags ──
    const lines = _mobOverlays.filter(o => o.type !== 'dot')
      .map(o => ({ ...o, yPx: yScale.getPixelForValue(o.price) }))
      .filter(o => Number.isFinite(o.yPx))
      .sort((a, b) => a.yPx - b.yPx)
    let prevLabelY = -1e9
    for (const o of lines) {
      const yPx = Math.max(chartArea.top + 1, Math.min(chartArea.bottom - 1, o.yPx))
      ctx.save()
      ctx.beginPath(); ctx.moveTo(chartArea.left, yPx); ctx.lineTo(chartArea.right, yPx)
      ctx.lineWidth = 1; ctx.strokeStyle = o.color; ctx.globalAlpha = 0.85
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1
      const labelY = Math.max(yPx, prevLabelY + 16)
      prevLabelY = labelY
      const label = o.label + ' ' + o.fmt
      ctx.font = 'bold 11px "Space Mono", monospace'
      const tw = ctx.measureText(label).width, bw = tw + 10, bh = 17
      const bx = chartArea.right + 1, by = labelY - bh / 2
      ctx.fillStyle = o.color
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 3); ctx.fill() }
      else ctx.fillRect(bx, by, bw, bh)
      ctx.fillStyle = '#0a0a12'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
      ctx.fillText(label, bx + 5, labelY)
      ctx.restore()
    }

    // ── Open-order dots, just to the right of the price labels ──
    const dotX = chartArea.right + (yScale.width || 56) - 6
    for (const o of _mobOverlays.filter(o => o.type === 'dot')) {
      const yPx = yScale.getPixelForValue(o.price)
      if (!Number.isFinite(yPx) || yPx < chartArea.top || yPx > chartArea.bottom) continue
      ctx.save()
      ctx.beginPath()
      ctx.arc(dotX, yPx, 3, 0, Math.PI * 2)
      ctx.fillStyle = o.color
      ctx.fill()
      ctx.restore()
    }
  },
}

function _mobPriceTick(v) {
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (abs >= 1)    return v.toFixed(2)
  return v.toPrecision(3)
}

function _mobHeroHtml(price, t) {
  return `<span style="font-weight:800;font-family:var(--font-mono)">$${fmtPrice(price)}</span>`
       + `<span style="color:var(--muted);margin-left:7px">${fmtTimeShort(t)}</span>`
}

// TradingView-style x-axis labels: show "DD Mon" at each new day, "HH:MM" within
// a day (for intraday timeframes); always "DD Mon" for 4h+.
function _mobXTick(tf) {
  const intraday = ['1m', '5m', '15m', '1h'].includes(tf)
  return function(value, index, ticks) {
    const d   = new Date(value)
    const mon = d.toLocaleString('en-US', { month: 'short' })
    if (!intraday) return d.getDate() + ' ' + mon
    const prev   = index > 0 && ticks[index - 1] ? new Date(ticks[index - 1].value) : null
    const newDay = !prev || d.toDateString() !== prev.toDateString()
    if (newDay) return d.getDate() + ' ' + mon
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }
}

// Auto-scale the price axis to the data currently visible in the x window
// (so panning/zooming through history doesn't render as a flat line).
function _mobAutoScaleY(chart) {
  const xs = chart.scales.x
  if (!xs) return
  const xmin = xs.min, xmax = xs.max
  let lo = Infinity, hi = -Infinity
  if (chart._candleMode && chart._candleData) {
    for (const d of chart._candleData) {
      if (d.x < xmin || d.x > xmax) continue
      if (d.l < lo) lo = d.l
      if (d.h > hi) hi = d.h
    }
  } else {
    for (const d of chart.data.datasets[0].data) {
      if (d.x < xmin || d.x > xmax) continue
      if (d.y < lo) lo = d.y
      if (d.y > hi) hi = d.y
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1
  chart.options.scales.y.min = lo - pad
  chart.options.scales.y.max = hi + pad
}

// Chart.js ships no candlestick type. In candle mode the price line is drawn fully
// transparent, so the OHLC bodies/wicks must be painted here — without this the chart renders
// completely blank the moment candlestick mode is toggled on.
const mobCandlesPlugin = {
  id: 'mobCandles',
  beforeDatasetsDraw(chart) {
    if (!chart._candleMode || !Array.isArray(chart._candleData)) return
    const xs = chart.scales.x, ys = chart.scales.y
    if (!xs || !ys) return
    const vis = chart._candleData.filter(d =>
      Number.isFinite(d.x) && Number.isFinite(d.o) && Number.isFinite(d.h) &&
      Number.isFinite(d.l) && Number.isFinite(d.c) && d.x >= xs.min && d.x <= xs.max)
    if (!vis.length) return

    // Body width from the tightest gap between candles, so it stays right at any zoom.
    let gap = Infinity
    for (let i = 1; i < vis.length; i++) gap = Math.min(gap, vis[i].x - vis[i - 1].x)
    if (!Number.isFinite(gap) || gap <= 0) gap = (xs.max - xs.min) / Math.max(1, vis.length)
    const span = Math.abs(xs.getPixelForValue(xs.min + gap) - xs.getPixelForValue(xs.min))
    const w    = Math.max(1, Math.min(18, span * 0.62))

    const { ctx, chartArea } = chart
    ctx.save()
    ctx.beginPath()
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
    ctx.clip()
    for (const d of vis) {
      const col = d.c >= d.o ? '#00e5a0' : '#ff4d6d'
      const x   = xs.getPixelForValue(d.x)
      const yO  = ys.getPixelForValue(d.o), yC = ys.getPixelForValue(d.c)
      const yH  = ys.getPixelForValue(d.h), yL = ys.getPixelForValue(d.l)
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke()   // wick
      // Body — min 1px tall so doji / untraded candles still show.
      ctx.fillRect(x - w / 2, Math.min(yO, yC), w, Math.max(1, Math.abs(yC - yO)))
    }
    ctx.restore()
  },
}

export function renderMobTradeChart(canvas, candles, overlays, heroId, tf = '1h', type = 'line') {
  destroyMobTradeChart()
  _mobOverlays = (overlays || []).map(o => ({ ...o, fmt: fmtPrice(o.price) }))
  const pts  = candles.map(k => ({ x: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })).filter(d => Number.isFinite(d.c))
  const data = pts.map(p => ({ x: p.x, y: p.c }))
  if (data.length < 2) return null
  const isCandle = type === 'candle'

  const up   = data[data.length - 1].y >= data[0].y
  const col  = up ? '#00e5a0' : '#ff4d6d'
  const gTop = up ? 'rgba(0,229,160,0.26)' : 'rgba(255,77,109,0.26)'
  const gBot = up ? 'rgba(0,229,160,0)'    : 'rgba(255,77,109,0)'

  // Default view = most recent ~90 candles; user can pan left through full history.
  const len   = data.length
  const dt    = len > 1 ? Math.max(1, data[len - 1].x - data[len - 2].x) : 60000
  const visN  = Math.min(len, 90)
  const lastT = data[len - 1].x
  const xMin0 = data[len - visN].x
  const xMax0 = lastT + dt * 5            // small "future" gap on the right
  const panMin = data[0].x
  const panMax = lastT + dt * 30
  let lo = Infinity, hi = -Infinity
  for (const p of pts) {
    if (p.x < xMin0 || p.x > xMax0) continue
    const plo = isCandle ? p.l : p.c, phi = isCandle ? p.h : p.c
    if (plo < lo) lo = plo
    if (phi > hi) hi = phi
  }
  const yPad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1

  const base = makeChartOptions()
  const options = {
    ...base,
    animation: false,
    onHover: (e, active) => {
      const el = document.getElementById(heroId)
      if (!el) return
      if (!active.length) { el.innerHTML = _mobHeroHtml(data[data.length - 1].y, data[data.length - 1].x); return }
      const item = mobTradeChartInst?.data.datasets[0].data[active[0].index]
      if (item) el.innerHTML = _mobHeroHtml(item.y, item.x)
    },
    plugins: {
      ...base.plugins,
      zoom: {
        limits: { x: { min: panMin, max: panMax, minRange: dt * 8 } },
        pan:  { enabled: true, mode: 'x', onPan: ({ chart }) => { _mobAutoScaleY(chart); chart.update('none') } },
        zoom: { wheel: { enabled: true, speed: 0.08 }, pinch: { enabled: true }, mode: 'x', onZoom: ({ chart }) => { _mobAutoScaleY(chart); chart.update('none') } },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: xMin0, max: xMax0,
        grid:   { color: 'rgba(255,255,255,0.05)', drawTicks: false },
        ticks:  { color: '#c8c8d2', font: { size: 12, weight: '600' }, maxTicksLimit: 6, padding: 8, callback: _mobXTick(tf) },
        border: { display: false },
      },
      y: {
        position: 'right',
        min: lo - yPad, max: hi + yPad,
        afterFit: s => { s.width = Math.max(s.width, 66) },
        grid:   { color: 'rgba(255,255,255,0.05)', drawTicks: false },
        ticks:  { color: '#c8c8d2', font: { size: 12, weight: '500' }, padding: 8, count: 8, callback: _mobPriceTick },
        border: { display: false },
      },
    },
  }

  mobTradeChartInst = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets: [{
      data,
      borderColor:     isCandle ? 'transparent' : col,
      backgroundColor: isCandle ? 'transparent' : _gradFn(gTop, gBot),
      borderWidth:     isCandle ? 0 : 1.6,
      pointRadius: 0, pointHoverRadius: 4,
      fill: isCandle ? false : 'start', tension: 0,
    }] },
    options,
    plugins: [crosshairPlugin, mobOverlayLinesPlugin, mobCandlesPlugin],
  })
  mobTradeChartInst._candleMode = isCandle
  mobTradeChartInst._candleData = pts
  if (isCandle) mobTradeChartInst.update('none')
  canvas.addEventListener('dblclick', () => resetMobTradeChart())

  const heroEl = document.getElementById(heroId)
  if (heroEl) heroEl.innerHTML = _mobHeroHtml(data[data.length - 1].y, data[data.length - 1].x)
  return mobTradeChartInst
}

// Live refresh: swap in new candles + overlays, keep current zoom/pan
export function updateMobTradeChartData(candles, overlays) {
  if (!mobTradeChartInst) return
  _mobOverlays = (overlays || []).map(o => ({ ...o, fmt: fmtPrice(o.price) }))
  const pts = candles.map(k => ({ x: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })).filter(d => Number.isFinite(d.c))
  mobTradeChartInst.data.datasets[0].data = pts.map(p => ({ x: p.x, y: p.c }))
  mobTradeChartInst._candleData = pts
  _mobAutoScaleY(mobTradeChartInst)
  mobTradeChartInst.update('none')
}
