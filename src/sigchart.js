/**
 * The chart behind Signals: a price line, whatever the chosen indicator draws, and the
 * compared market alongside it.
 *
 * Pure -- it is handed series and returns an SVG string. No app state, no fetching, no
 * DOM. That keeps "what does this indicator actually look like" testable on its own, and
 * it is why this is a file rather than another few hundred lines of main.js.
 *
 * The one judgement encoded here: when two markets share the frame they are drawn as
 * PERCENT CHANGE from the left edge, never as raw price. BTC at 78,000 and HYPE at 81 on
 * one axis makes HYPE a flat line along the bottom, which looks like a fact about the
 * market and is really a fact about the axis. Rebasing is the only honest way to put two
 * prices in one frame, and every overlay is rebased by the same factor so it keeps sitting
 * where it belongs against the line it describes.
 */

const R = (n) => Math.round(n * 10) / 10

/** [[t, v], ...] -> percent change from the first point. */
export function rebase(pts) {
  if (!pts?.length) return []
  const base = +pts[0][1]
  if (!Number.isFinite(base) || base === 0) return []
  return pts.map(([t, v]) => [t, (+v / base - 1) * 100])
}

/** Simple moving average, aligned to the input: null until there is enough history. */
export function smaSeries(vals, n) {
  const out = new Array(vals.length).fill(null)
  let sum = 0
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]
    if (i >= n) sum -= vals[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

export function emaSeries(vals, n) {
  const out = new Array(vals.length).fill(null)
  const k = 2 / (n + 1)
  let prev = null
  for (let i = 0; i < vals.length; i++) {
    prev = prev == null ? vals[i] : vals[i] * k + prev * (1 - k)
    if (i >= n - 1) out[i] = prev
  }
  return out
}

/** Wilder RSI, aligned to the input. */
export function rsiSeries(vals, n = 14) {
  const out = new Array(vals.length).fill(null)
  if (vals.length <= n) return out
  let g = 0, l = 0
  for (let i = 1; i <= n; i++) {
    const d = vals[i] - vals[i - 1]
    if (d >= 0) g += d; else l -= d
  }
  g /= n; l /= n
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  for (let i = n + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1]
    g = (g * (n - 1) + Math.max(0, d)) / n
    l = (l * (n - 1) + Math.max(0, -d)) / n
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}

/** Rolling standard deviation, aligned. Bollinger bands and the volatility panel. */
function stdSeries(vals, n) {
  const out = new Array(vals.length).fill(null)
  for (let i = n - 1; i < vals.length; i++) {
    const w = vals.slice(i - n + 1, i + 1)
    const m = w.reduce((a, b) => a + b, 0) / n
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n)
  }
  return out
}

/**
 * What an indicator adds to the chart.
 *   overlays: lines on the price pane, in price units
 *   sub:      a panel below with its own scale (RSI, volatility)
 */
export function indicatorLayers(key, vals) {
  switch (key) {
    case 'ema': return { overlays: [
      { label: 'EMA 9',  vals: emaSeries(vals, 9),  color: '#22c55e' },
      { label: 'EMA 21', vals: emaSeries(vals, 21), color: '#f59e0b' },
    ] }
    case 'sma': return { overlays: [
      { label: 'SMA 50', vals: smaSeries(vals, 50), color: '#f59e0b' },
    ] }
    case 'ma200w': return { overlays: [
      { label: '200w avg', vals: smaSeries(vals, 200), color: '#a78bfa' },
    ] }
    case 'boll': {
      const mid = smaSeries(vals, 20), sd = stdSeries(vals, 20)
      const up = mid.map((m, i) => m == null || sd[i] == null ? null : m + 2 * sd[i])
      const dn = mid.map((m, i) => m == null || sd[i] == null ? null : m - 2 * sd[i])
      return { overlays: [
        { label: 'Upper',  vals: up,  color: '#60a5fa', dash: '3 3' },
        { label: 'SMA 20', vals: mid, color: '#f59e0b' },
        { label: 'Lower',  vals: dn,  color: '#60a5fa', dash: '3 3' },
      ] }
    }
    case 'rsi': return { sub: {
      label: 'RSI (14)', vals: rsiSeries(vals, 14), color: '#60a5fa',
      min: 0, max: 100, guides: [30, 70],
    } }
    case 'vol': {
      // Rolling 20-period deviation of log returns, annualised -- the same measure the
      // reading above the chart quotes, so the shape and the number agree.
      const rets = vals.map((v, i) => i ? Math.log(v / vals[i - 1]) : 0)
      const sd = stdSeries(rets, 20).map(s => s == null ? null : s * Math.sqrt(365) * 100)
      return { sub: { label: 'Volatility %', vals: sd, color: '#f59e0b' } }
    }
    default: return {}
  }
}

const path = (pts, px, py) => {
  let d = '', pen = false
  for (const [x, y] of pts) {
    if (y == null || !Number.isFinite(y)) { pen = false; continue }
    d += `${pen ? 'L' : 'M'}${R(px(x))},${R(py(y))}`
    pen = true
  }
  return d
}

/**
 * Render. `main` and `cmp` are [[t, price], ...]. With a `cmp` both are rebased to percent,
 * and so are the overlays; without one the pane is in price units.
 */
export function signalChartSvg({
  main, cmp = null, mainLabel = '', cmpLabel = '', indicator = null, vals = [],
  height = 132, subHeight = 46, fmtPrice = (v) => String(v),
  from = 0, to = null,
} = {}) {
  const W = 320, PAD = 4
  const full = (main ?? []).filter(p => Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
  if (full.length < 3) return { svg: '', legend: '', hi: '', lo: '', empty: true, meta: null }

  // Indicators are computed over ALL the history and only then cut to the visible window.
  // Computing them from the window instead would restart every average at the left edge,
  // so zooming in would silently change what the indicator says -- the number would depend
  // on how far you happened to be zoomed, which is not a property any of these have.
  const fullVals = vals.length ? vals : full.map(p => +p[1])
  const layers = indicator ? indicatorLayers(indicator, fullVals) : {}

  const n = full.length
  const lo = Math.max(0, Math.min(n - 3, Math.floor(from)))
  const hi = Math.max(lo + 3, Math.min(n, Math.ceil(to ?? n)))
  const clean = full.slice(lo, hi)
  const meta = { from: lo, to: hi, n, W, PAD, height, t0: +clean[0][0], t1: +clean[clean.length - 1][0] }

  // The compared market is cut by TIME, not by index: the two series need not have the
  // same number of candles, and lining them up by position would slide one against the
  // other the moment either had a gap.
  const cmpWin = cmp ? cmp.filter(p => +p[0] >= meta.t0 && +p[0] <= meta.t1) : null
  const comparing = !!(cmpWin && cmpWin.length > 2)

  // Rebased to the left edge OF THE WINDOW, so zooming in re-reads the percentages against
  // where the visible stretch began. Any other choice makes the number on screen refer to
  // a point that is no longer on it.
  const base = +clean[0][1]
  const toY = comparing ? (v) => (v / base - 1) * 100 : (v) => v
  const series = clean.map(([t, v]) => [t, toY(+v)])
  const cmpSeries = comparing ? rebase(cmpWin) : []
  const overlays = (layers.overlays ?? []).map(o => ({
    ...o, pts: clean.map(([t], i) => [t, o.vals[lo + i] == null ? null : toY(o.vals[lo + i])]),
  }))

  const xs = clean.map(p => +p[0])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const allY = [
    ...series.map(p => p[1]),
    ...cmpSeries.map(p => p[1]),
    ...overlays.flatMap(o => o.pts.map(p => p[1])),
  ].filter(v => v != null && Number.isFinite(v))
  let y0 = Math.min(...allY), y1 = Math.max(...allY)
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return { svg: '', legend: '', hi: '', lo: '', empty: true, meta: null }
  if (y0 === y1) { y0 -= 1; y1 += 1 }

  const px = (t) => PAD + ((t - x0) / ((x1 - x0) || 1)) * (W - PAD * 2)
  const py = (v) => height - PAD - ((v - y0) / ((y1 - y0) || 1)) * (height - PAD * 2)

  const up = series[series.length - 1][1] >= series[0][1]
  const mainColor = comparing ? '#22d3ee' : (up ? 'var(--green,#22c55e)' : 'var(--red,#ef4444)')

  let body = ''
  if (!comparing) {
    body += `<path d="${path(series, px, py)}L${R(px(x1))},${height}L${R(px(x0))},${height}Z" fill="${mainColor}" opacity="0.10"/>`
  }
  for (const o of overlays) {
    body += `<path d="${path(o.pts, px, py)}" fill="none" stroke="${o.color}" stroke-width="1.2" ${
      o.dash ? `stroke-dasharray="${o.dash}"` : ''} opacity="0.9" vector-effect="non-scaling-stroke"/>`
  }
  body += `<path d="${path(series, px, py)}" fill="none" stroke="${mainColor}" stroke-width="1.9" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
  if (comparing) {
    body += `<path d="${path(cmpSeries, px, py)}" fill="none" stroke="#f472b6" stroke-width="1.7" stroke-linejoin="round" opacity="0.95" vector-effect="non-scaling-stroke"/>`
    // With two rebased lines, "flat since the left edge" is the reference the eye needs;
    // without it neither line means much on its own.
    if (y0 < 0 && y1 > 0) {
      body += `<line x1="${PAD}" x2="${W - PAD}" y1="${R(py(0))}" y2="${R(py(0))}" stroke="var(--border2,#2a2f3a)" stroke-width="1" stroke-dasharray="2 3"/>`
    }
  }

  const fmtV = comparing ? (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : fmtPrice
  let svg = `<svg viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block">${body}</svg>`

  // The sub panel keeps its own scale; sharing the price axis would flatten it to nothing.
  const sub = layers.sub
  if (sub) {
    const sPts = clean.map(([t], i) => [t, sub.vals[lo + i]])
    const vs = sPts.map(p => p[1]).filter(v => v != null && Number.isFinite(v))
    if (vs.length > 2) {
      const s0 = sub.min ?? Math.min(...vs), s1 = sub.max ?? Math.max(...vs)
      const spy = (v) => subHeight - 3 - ((v - s0) / ((s1 - s0) || 1)) * (subHeight - 6)
      const guides = (sub.guides ?? []).map(g =>
        `<line x1="${PAD}" x2="${W - PAD}" y1="${R(spy(g))}" y2="${R(spy(g))}" stroke="var(--border2,#2a2f3a)" stroke-width="1" stroke-dasharray="2 3"/>`).join('')
      svg += `<div style="font-size:9px;color:var(--muted);margin:6px 0 1px">${sub.label}</div>` +
        `<svg viewBox="0 0 ${W} ${subHeight}" preserveAspectRatio="none" style="width:100%;height:${subHeight}px;display:block">${guides}<path d="${path(sPts, px, spy)}" fill="none" stroke="${sub.color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`
    }
  }

  const dot = (c) => `<span style="width:8px;height:2px;background:${c};display:inline-block;vertical-align:middle"></span>`
  const legend = [
    `${dot(mainColor)} <span>${mainLabel}</span>`,
    comparing ? `${dot('#f472b6')} <span>${cmpLabel}</span>` : '',
    ...overlays.map(o => `${dot(o.color)} <span>${o.label}</span>`),
  ].filter(Boolean).join('<span style="width:10px;display:inline-block"></span>')

  return { svg, legend, hi: fmtV(y1), lo: fmtV(y0), empty: false, meta }
}
