// ─── MULTI-ASSET COMPARISON CHART ─────────────────────────────────────────────
//
// Watch shows one sparkline per coin, each on its own vertical scale, so "did HYPE beat
// SOL this week" is unanswerable by looking at them. Overlaying raw prices would not help
// either — BTC at $78,000 and HYPE at $76 on one axis makes every other line flat.
//
// So every series is normalised to PERCENT CHANGE from the first candle in the window. That
// puts all of them on one axis where the only thing being compared is performance, which is
// the actual question. The y-axis is therefore always %, never price, and the legend states
// each coin's change over the window rather than its price.
//
// Self-contained like exposure.js: pure functions plus an SVG string, no DOM ownership and
// no chart library. Removing the feature is deleting this file and its call sites.

const _esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * candlesByCoin: { COIN: [{ t, c }, …] } — HL candleSnapshot rows.
 * Returns one normalised series per coin, plus the shared y-range.
 */
export function computeCompare(candlesByCoin, coins) {
  const series = []
  for (const coin of (coins ?? [])) {
    const raw = candlesByCoin?.[coin]
    if (!Array.isArray(raw) || raw.length < 2) continue
    const pts = raw
      .map(k => ({ t: +(k.t ?? k.T ?? 0), c: parseFloat(k.c ?? 0) }))
      .filter(p => p.t > 0 && p.c > 0)
      .sort((a, b) => a.t - b.t)
    if (pts.length < 2) continue
    const base = pts[0].c
    if (!(base > 0)) continue
    series.push({
      coin,
      pts: pts.map(p => ({ t: p.t, v: (p.c / base - 1) * 100 })),
      change: (pts[pts.length - 1].c / base - 1) * 100,
      last: pts[pts.length - 1].c,
      base,
    })
  }
  if (!series.length) return { series: [], min: 0, max: 0, t0: 0, t1: 0 }

  // One shared axis across every series — that shared scale IS the comparison.
  let min = Infinity, max = -Infinity, t0 = Infinity, t1 = -Infinity
  for (const s of series) for (const p of s.pts) {
    if (p.v < min) min = p.v
    if (p.v > max) max = p.v
    if (p.t < t0) t0 = p.t
    if (p.t > t1) t1 = p.t
  }
  // A flat window would collapse to a zero-height band and divide by zero below.
  if (max - min < 0.01) { max += 0.5; min -= 0.5 }
  series.sort((a, b) => b.change - a.change)   // best performer first
  return { series, min, max, t0, t1 }
}

/** Deterministic colour per coin, stable across renders. Mirrors main.js's _coinColor. */
export function compareColor(coin) {
  let h = 0
  for (let i = 0; i < coin.length; i++) h = (h * 31 + coin.charCodeAt(i)) % 360
  return `hsl(${h},70%,55%)`
}

export function compareChartSvg(d, { width = 340, height = 200, label = c => c } = {}) {
  if (!d.series.length) return ''
  const padL = 6, padR = 6, padT = 10, padB = 6
  const w = width - padL - padR, h = height - padT - padB
  const span = d.t1 - d.t0 || 1
  const range = d.max - d.min || 1
  const x = t => padL + ((t - d.t0) / span) * w
  const y = v => padT + (1 - (v - d.min) / range) * h

  // Zero line: the baseline every series starts from, so above it is outperformance.
  const zeroY = (d.min <= 0 && d.max >= 0) ? y(0) : null

  const paths = d.series.map(s => {
    const dAttr = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')
    return `<path d="${dAttr}" fill="none" stroke="${compareColor(s.coin)}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
  }).join('')

  // End-of-line dots make it possible to tell which line is which without tracing back.
  const dots = d.series.map(s => {
    const p = s.pts[s.pts.length - 1]
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.6" fill="${compareColor(s.coin)}"/>`
  }).join('')

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
    style="width:100%;height:${height}px;display:block;overflow:visible">
    ${zeroY != null ? `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${width - padR}" y2="${zeroY.toFixed(1)}"
      stroke="var(--border2)" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
    ${paths}${dots}
  </svg>`
}

export function compareLegendHtml(d, { label = c => c } = {}) {
  return d.series.map(s => {
    const tone = s.change >= 0 ? 'var(--green)' : 'var(--red)'
    return `<div style="display:flex;align-items:center;gap:7px;padding:5px 0;min-width:0">
      <span style="width:9px;height:9px;border-radius:3px;flex-shrink:0;background:${compareColor(s.coin)}"></span>
      <span style="font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(label(s.coin))}</span>
      <span style="flex:1"></span>
      <span style="font-size:12.5px;font-weight:800;font-family:var(--font-mono);color:${tone};white-space:nowrap">
        ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%</span>
    </div>`
  }).join('')
}

/** Best minus worst over the window — the spread the comparison exists to show. */
export function compareSpread(d) {
  if (d.series.length < 2) return null
  return { best: d.series[0], worst: d.series[d.series.length - 1],
           spread: d.series[0].change - d.series[d.series.length - 1].change }
}
