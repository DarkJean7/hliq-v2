import Chart from 'chart.js/auto'
import { fmtTimeShort, fmtUSD, fmtPrice } from './format.js'
import { frameFor } from './chartframe.js'
import { chartDateTick, chartDateHover } from './chartdates.js'

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
    plugins: {
      legend: { display: false }, tooltip: { enabled: false },
      // `yPriceBoxes` (main.js) is registered on Chart itself, so it paints its pill labels
      // over the ticks of EVERY chart in the app — including these, which already write their
      // own axis through the callback below. Two sets of labels in the same place, formatted
      // differently ("$1,000.00" under a pill reading "1,000"), and in a card narrow enough
      // the pair overlaps into mush. It belongs to the price chart, which asks for it through
      // makeChartOptions; these dollar charts say no.
      yPriceBoxes: false,
    },
    scales: {
      // Dates along the bottom ("lets add fixed days in the chart"): a handful, in a form that
      // suits the span on screen — times for a day, days for a week or month, months for all time.
      x: {
        type: 'linear', display: true,
        grid: { display: false }, border: { display: false },
        ticks: {
          color: '#9aa0b0', font: { family: 'Space Mono', size: 10 }, padding: 4, maxTicksLimit: 6, maxRotation: 0, autoSkip: true,
          callback(v) { return chartDateTick(v, this.max - this.min) },
        },
      },
      y: {
        position: 'right',
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: '#9aa0b0', font: { family: 'Space Mono', size: 11 }, padding: 6, maxTicksLimit: 4,
          // The minus goes before the dollar, as it does everywhere else in the app: the axis
          // read "$-1,000" against a "-$1,000" beside it on the same screen.
          callback: v => (v < 0 ? '-$' : '$') + Math.abs(Number(v)).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }),
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
  // What was drawn, so the caller can write the headline from the SAME series rather than
  // computing its own. The two disagreeing is the bug this return value exists to prevent:
  // switching to Acc. PnL changed the chart and left the equity figure above it.
  //
  // baseRef is the account value at the start of the window — the capital a PnL figure is a
  // return ON. Null when the window has no usable start (an account funded inside it), and
  // then no percentage is shown rather than a meaningless one.
  const _avh  = entry?.[1]?.accountValueHistory ?? []
  const _base = _avh.length ? parseFloat(_avh[0][1]) : NaN
  return {
    type, first: data[0].y, last: data[data.length - 1].y,
    baseRef: Number.isFinite(_base) && _base > 1 ? _base : null,
  }
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

/**
 * A line chart with a hover hero, by canvas id.
 *
 * `kind` is what the numbers MEAN, not how they look: 'pnl' is a figure that is good above
 * zero and bad below it, so it is coloured by its sign and written +$/-$; 'value' is an
 * amount the account holds, which is never negative and whose story is the CHANGE across what
 * is on screen — so it is coloured by whether it ended above where it started, and the hero
 * carries the difference and the percentage, as the Portfolio tab's value chart does.
 * `empty` is what to say when there are no points, which a caller knows better than this does.
 */
export function renderPerfChart(canvasId, points, heroId = null, { kind = 'pnl', empty = 'No closed trades in range', maxTicks = 4, axisMin = 0, dates = false, xMin = null, xMax = null } = {}) {
  const canvas = document.getElementById(canvasId)
  if (!canvas) return
  const data = (points || []).filter(p => Number.isFinite(p.y))

  if (data.length < 2) {
    perfChartInsts[canvasId]?.destroy()
    delete perfChartInsts[canvasId]
    const h = heroId && document.getElementById(heroId)
    if (h) h.innerHTML = `<div class="portfolio-pnl-num neu" style="font-size:14px;color:var(--muted)">${empty}</div>`
    return
  }

  const last  = data[data.length - 1].y
  const first = data[0].y
  const up    = kind === 'value' ? last >= first : last >= 0
  const col  = up ? '#00e5a0' : '#ff4d6d'
  const grad = up ? 'rgba(0,229,160,0.18)' : 'rgba(255,77,109,0.18)'
  const ds   = {
    data, borderColor: col, backgroundColor: _gradFn(grad, 'rgba(0,0,0,0)'),
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: 'start', tension: 0.3,
  }

  // The vertical frame, measured rather than left to Chart.js — which grows the range out to
  // its own tick spacing and drew a month that was never red on an axis reaching −$5,000.
  // src/chartframe.js has the evidence and the rule.
  const frame = frameFor(data, { kind, xMin, xMax })
  const yMin = frame?.min, yMax = frame?.max

  if (perfChartInsts[canvasId]?.canvas === canvas) {
    const ch = perfChartInsts[canvasId]
    Object.assign(ch.data.datasets[0], ds)
    // The frame follows the data on an update too — switching from a $6,000 account value to
    // a $560 month of PnL on the same canvas otherwise keeps the old one.
    if (frame) Object.assign(ch.options.scales.y, { min: yMin, max: yMax })
    if (dates) Object.assign(ch.options.scales.x, { min: xMin ?? undefined, max: xMax ?? undefined })
    ch.update('none')
  } else {
    perfChartInsts[canvasId]?.destroy()
    const options = _ovChartOptions()
    options.scales.y.ticks.maxTicksLimit = maxTicks
    if (dates) {
      // A line with no dates under it says the shape of a month without saying WHEN — the
      // dip is unreadable if you cannot tell the 4th from the 22nd. Day numbers only: the
      // month is named in the header a centimetre above, and "Sep 4" at every tick would
      // repeat it five times.
      options.scales.x = {
        type: 'linear', display: true,
        min: xMin ?? undefined, max: xMax ?? undefined,
        grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false },
        border: { display: false },
        ticks: {
          color: '#7a8092', font: { family: 'Space Mono', size: 10 }, padding: 6,
          // Five, evenly spread between the ends of the month. Left to itself the auto-ticker
          // picks a round number of MILLISECONDS, which lands on 1, 9, 15, 26 in one month and
          // somewhere else in the next, so no two months read alike.
          count: 5, maxRotation: 0,
          callback: v => String(new Date(v).getDate()),
        },
      }
      // Faint rules across the plot at each dollar tick: reading a value off a line is
      // guesswork without them, and at this size a grid is cheaper than more labels.
      options.scales.y.grid = { color: 'rgba(255,255,255,0.05)', drawTicks: false }
    }
    // A floor under the axis width. Chart.js measures the labels to size the axis, and in a
    // narrow card it measures them before "Space Mono" has finished loading — then draws them
    // wider than the space it reserved, so "$1,000.00" comes out clipped at both ends. Asking
    // for a minimum width costs a few pixels of plot and cannot be got wrong by a font.
    if (axisMin > 0) options.scales.y.afterFit = (sc) => { sc.width = Math.max(sc.width, axisMin) }
    if (frame) { options.scales.y.min = yMin; options.scales.y.max = yMax }
    // Labels at round numbers inside the frame. With min and max set, Chart.js labels the
    // bounds themselves by default — which is how the axis came to read "-$256.68".
    options.scales.y.ticks.includeBounds = false
    perfChartInsts[canvasId] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: [ds] },
      options,
      plugins: [crosshairPlugin, zeroLinePlugin],
    })
  }

  if (heroId) {
    const sign = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
    // For a value series the hero reads like the Portfolio tab's: the amount, and underneath
    // it what that amount has done since the left edge of what is drawn.
    const change = (v) => {
      const d = v - first, cls = d >= 0 ? 'pos' : 'neg', sg = d >= 0 ? '+' : ''
      const pct = first !== 0 ? (d / first) * 100 : 0
      return `<div class="portfolio-pnl-num ${cls}">$${fmtUSD(v)}</div>
              <div class="portfolio-pnl-pct ${cls}">${sg}$${fmtUSD(Math.abs(d))} &nbsp;${sg}${pct.toFixed(2)}%</div>`
    }
    const defHtml = kind === 'value' ? change(last)
      : `<div class="portfolio-pnl-num ${up ? 'pos' : 'neg'}">${sign(last)}</div>`
    perfHandlers[canvasId] = perfHandlers[canvasId] || { move: null, leave: null }
    attachHover(perfChartInsts[canvasId], canvasId, heroId, defHtml, (val, lbl) =>
      (kind === 'value'
        ? change(val)
        : `<div class="portfolio-pnl-num ${val >= 0 ? 'pos' : 'neg'}">${sign(val)}</div>`) +
      `<div class="portfolio-pnl-date">${fmtTimeShort(lbl)}</div>`, perfHandlers[canvasId])
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

    // X-axis cursor tag: the date of the point under the cursor, under the vertical line — the
    // twin of the value tag above ("and the one when scrolling the chart like hovering"). Only
    // for charts whose x is a time; an index-based chart has no date to show.
    const xVal = typeof item === 'object' ? item.x : null
    if (typeof xVal === 'number' && xVal > 1e12) {
      const ds   = chart.data.datasets[0].data
      const span = (ds.at(-1)?.x ?? xVal) - (ds[0]?.x ?? xVal)
      const label = chartDateHover(xVal, span)
      ctx.font = '9px "Space Mono", monospace'
      const bw = ctx.measureText(label).width + 10, bh = 15
      const bx = Math.min(Math.max(xPx - bw / 2, left), right - bw)
      // Under the plot where there is an axis to sit on; just inside its bottom edge where there
      // is not (a chart with a hidden x axis has no room below, and the tag would be cut off).
      const by = bottom + 2 + bh <= chart.height ? bottom + 2 : bottom - bh - 2
      ctx.fillStyle = 'rgba(70,70,90,0.95)'
      ctx.fillRect(bx, by, bw, bh)
      ctx.fillStyle    = '#d0d0e0'
      ctx.textBaseline = 'middle'
      ctx.textAlign    = 'center'
      ctx.fillText(label, bx + bw / 2, by + bh / 2)
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

// The Trade chart (desktop Trade tab and the phone's market detail) lives in src/tradechart.js,
// on Lightweight Charts.
