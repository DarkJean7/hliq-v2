/**
 * The Trade chart — desktop's Trade tab and the phone's market detail — on TradingView's
 * Lightweight Charts (Apache-2.0, `lightweight-charts`).
 *
 * Asked: "can we make the trade tab more like a real terminal for trading ... its just mostly
 * about the chart. the chart is like meh." It was Chart.js, a general graphing library with
 * candles, panning and price tags painted on by hand (src/charts.js). This is a library made for
 * exactly this: real candles and a volume pane, a crosshair with its own price and time tags,
 * kinetic drag and pinch, a price axis that rescales as you scroll, and room to drag the last
 * candle across to the left edge, as on Hyperliquid.
 *
 * Same four calls the old chart exposed, so main.js only changes its import:
 *   renderMobTradeChart(canvas, candles, overlays, heroId, tf, type)   draw (replaces any)
 *   updateMobTradeChartData(candles, overlays)                         live candle / overlays
 *   resetMobTradeChart()                                               back to the recent window
 *   destroyMobTradeChart()
 * `canvas` is where the old chart drew; this mounts a host beside it and hides it, so neither
 * shell's markup changes. Candles are Hyperliquid's ({t, o, h, l, c, v}); overlays are main.js's
 * _mobChartOverlays: { price, color, label, type: 'dot' | 'line', dash }.
 *
 * Imports nothing from main.js; formatting comes from src/format.js like the old chart's.
 */
import { createChart, CandlestickSeries, HistogramSeries, AreaSeries, LineStyle, CrosshairMode } from 'lightweight-charts'
import { fmtPrice, fmtTimeShort } from './format.js'

const UP = '#00e5a0', DOWN = '#ff4d6d'
/** Bars on screen when a chart opens or is reset — the old chart's default window. */
const VIEW_BARS = 90

let chart = null, host = null, hidden = null
let price = null, volume = null
let lines = []
let bars = []            // the bars as drawn, with `ms` (real time) beside the shifted `time`
let mode = 'candle'
let heroEl = null

// Lightweight Charts labels its axis in UTC. Shifting each bar by the local offset makes every
// label the viewer's own clock — the old chart's, and Hyperliquid's. The real time is kept on
// the bar for the readout.
const shift = (ms) => Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60

function toBars(candles) {
  const out = []
  let prev = -Infinity
  for (const k of candles ?? []) {
    const ms = +k.t, o = +k.o, h = +k.h, l = +k.l, c = +k.c
    if (!Number.isFinite(ms) || !Number.isFinite(c)) continue
    const time = shift(ms)
    if (time <= prev) continue          // the library needs strictly ascending times
    prev = time
    out.push({ time, ms, open: o, high: h, low: l, close: c, v: +k.v || 0 })
  }
  return out
}
const volBar = (b) => ({ time: b.time, value: b.v, color: b.close >= b.open ? 'rgba(0,229,160,0.32)' : 'rgba(255,77,109,0.32)' })
const lineBar = (b) => ({ time: b.time, value: b.close })

// Ticks small enough for the cheapest coin: 2 significant decimals past the leading digit.
function minMoveFor(p) {
  if (!(p > 0)) return 0.01
  const dec = Math.min(8, Math.max(0, 4 - Math.floor(Math.log10(p))))
  return Math.pow(10, -dec)
}

function cssVar(name, fallback) {
  try { return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback } catch { return fallback }
}

// The readout in the top-left: what the crosshair is on, or the latest bar. OHLC and the bar's
// change, the way a terminal's legend reads, and only where there is room for it.
function heroHtml(b, prevClose) {
  if (!b) return ''
  const chg = prevClose > 0 ? (b.close - prevClose) / prevClose * 100 : null
  const col = b.close >= b.open ? UP : DOWN
  const wide = (host?.clientWidth ?? 0) >= 560
  const ohlc = wide
    ? ['O', b.open, 'H', b.high, 'L', b.low, 'C', b.close].reduce((s, x, i) => s + (i % 2
        ? `<span style="color:${col};margin-right:8px">${fmtPrice(x)}</span>`
        : `<span style="color:var(--muted);margin-right:3px">${x}</span>`), '')
    : ''
  return `<span style="font-weight:800;font-family:var(--font-mono)">$${fmtPrice(b.close)}</span>`
    + (chg != null ? `<span style="color:${chg >= 0 ? UP : DOWN};margin-left:7px;font-family:var(--font-mono)">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : '')
    + `<span style="color:var(--muted);margin-left:9px">${fmtTimeShort(b.ms)}</span>`
    + (ohlc ? `<span style="margin-left:12px;font-family:var(--font-mono);font-size:11.5px">${ohlc}</span>` : '')
}
function paintHero(i) {
  if (!heroEl) return
  const n = bars.length
  const k = i == null || i < 0 || i >= n ? n - 1 : i
  heroEl.innerHTML = heroHtml(bars[k], bars[k - 1]?.close)
}

function setOverlays(overlays) {
  if (!price) return
  for (const l of lines) { try { price.removePriceLine(l) } catch {} }
  lines = []
  for (const o of overlays ?? []) {
    if (!(o?.price > 0)) continue
    // The series' own last-price line is the mark here, with its tag on the axis — a second
    // dotted "Mark" line on top of it would only draw the same price twice.
    if (o.label === 'Mark') continue
    const dot = o.type === 'dot'
    lines.push(price.createPriceLine({
      price: o.price, color: o.color, lineWidth: 1,
      lineStyle: dot ? LineStyle.SparseDotted : LineStyle.Dashed,
      // A resting order is a faint marker, not a labelled level: a grid bot has dozens.
      axisLabelVisible: !dot, title: dot ? '' : o.label,
      axisLabelColor: o.color, axisLabelTextColor: '#0a0a12',
    }))
  }
}

function recentWindow() {
  const n = bars.length
  if (!chart || !n) return
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VIEW_BARS), to: n + 4 })
}

export function destroyMobTradeChart() {
  try { chart?.remove() } catch {}
  host?.remove()
  if (hidden) hidden.style.display = ''
  chart = host = hidden = price = volume = heroEl = null
  lines = []; bars = []
}

export function resetMobTradeChart() {
  if (!chart) return
  recentWindow()
  try { chart.priceScale('right').applyOptions({ autoScale: true }) } catch {}
}

export function renderMobTradeChart(canvas, candles, overlays, heroId, tf = '1h', type = 'line') {
  destroyMobTradeChart()
  if (!canvas?.parentElement) return null
  bars = toBars(candles)
  if (bars.length < 2) return null
  mode = type === 'candle' ? 'candle' : 'line'

  hidden = canvas
  canvas.style.display = 'none'
  host = document.createElement('div')
  host.className = 'tv-chart-host'
  host.style.cssText = 'position:relative;width:100%;height:100%'
  canvas.parentElement.appendChild(host)

  const text = cssVar('--fg-2', '#c8c8d2'), grid = 'rgba(255,255,255,0.05)'
  const intraday = ['1m', '5m', '15m', '30m', '1h', '2h'].includes(tf)
  chart = createChart(host, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: text, fontSize: 11, fontFamily: cssVar('--font-mono', 'monospace'), attributionLogo: true },
    grid: { vertLines: { color: grid }, horzLines: { color: grid } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: 'rgba(200,200,210,0.35)', labelBackgroundColor: '#2a2f3a' },
      horzLine: { color: 'rgba(200,200,210,0.35)', labelBackgroundColor: '#2a2f3a' },
    },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: {
      borderVisible: false, timeVisible: intraday, secondsVisible: false,
      rightOffset: 4, barSpacing: 7, minBarSpacing: 0.5,
      // Free to drag the last candle across to the left edge, as on Hyperliquid.
      fixLeftEdge: false, fixRightEdge: false, rightBarStaysOnScroll: false,
    },
    localization: { priceFormatter: (p) => fmtPrice(p) },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  })

  const last = bars[bars.length - 1].close
  const fmt = { type: 'price', precision: Math.max(0, -Math.round(Math.log10(minMoveFor(last)))), minMove: minMoveFor(last) }
  price = mode === 'candle'
    ? chart.addSeries(CandlestickSeries, {
        upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
        priceFormat: fmt, priceLineStyle: LineStyle.Dotted, priceLineWidth: 1,
      })
    : chart.addSeries(AreaSeries, {
        lineColor: last >= bars[0].close ? UP : DOWN, lineWidth: 2,
        topColor: last >= bars[0].close ? 'rgba(0,229,160,0.26)' : 'rgba(255,77,109,0.26)', bottomColor: 'rgba(0,0,0,0)',
        priceFormat: fmt, priceLineStyle: LineStyle.Dotted, priceLineWidth: 1,
      })
  price.setData(mode === 'candle' ? bars : bars.map(lineBar))

  // Volume along the bottom fifth, on a scale of its own so it never squeezes the candles.
  volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
  volume.setData(bars.map(volBar))

  setOverlays(overlays)
  recentWindow()

  heroEl = document.getElementById(heroId)
  if (heroEl) { heroEl.style.whiteSpace = 'nowrap'; heroEl.style.overflow = 'hidden'; heroEl.style.right = '70px' }
  paintHero(null)
  chart.subscribeCrosshairMove((p) => paintHero(p?.logical == null ? null : Math.round(p.logical)))
  // Capture phase: the library handles double-clicks itself and does not let them bubble.
  host.addEventListener('dblclick', resetMobTradeChart, true)
  return chart
}

/** For tests/tradechart-live.mjs: what is drawn and where the view sits, in bar indexes. */
export function tradeChartState() {
  return chart ? { bars: bars.length, mode, lines: lines.length, range: chart.timeScale().getVisibleLogicalRange() } : null
}

// Live refresh: the candle socket sends the bar being built (same time) or the next one. Those
// go through `update`, which keeps where the user has scrolled; anything else redraws the data.
export function updateMobTradeChartData(candles, overlays) {
  if (!chart || !price) return
  const next = toBars(candles)
  if (!next.length) return
  const a = bars, n = a.length
  const sameStart = n && next[0].time === a[0].time
  if (sameStart && (next.length === n || next.length === n + 1)) {
    const b = next[next.length - 1]
    bars = next
    price.update(mode === 'candle' ? b : lineBar(b))
    volume?.update(volBar(b))
  } else {
    bars = next
    price.setData(mode === 'candle' ? bars : bars.map(lineBar))
    volume?.setData(bars.map(volBar))
  }
  setOverlays(overlays)
  paintHero(null)
}
