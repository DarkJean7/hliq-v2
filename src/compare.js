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

// Hashing a coin name straight to a hue collided in practice: SP500 and SPCX both came out
// green, BTC and SOL both blue, on a chart whose entire job is telling lines apart. Hash into
// a fixed palette instead, then walk to the next free slot if that entry is already taken by
// another coin in the SAME chart. Assignment is done over an alphabetically sorted copy, so a
// coin keeps its colour when the legend re-sorts by performance.
const CMP_PALETTE = [
  '#00e5a0', '#4da3ff', '#ff4d6d', '#f5a524', '#a78bfa',
  '#22d3ee', '#f472b6', '#84cc16', '#fb923c', '#94a3b8',
]

export function assignCompareColors(coins) {
  const out = {}, used = new Set()
  for (const c of [...new Set(coins ?? [])].sort()) {
    let h = 0
    for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) % CMP_PALETTE.length
    let i = h, tries = 0
    while (used.has(i) && tries < CMP_PALETTE.length) { i = (i + 1) % CMP_PALETTE.length; tries++ }
    used.add(i)
    out[c] = CMP_PALETTE[i]
  }
  return out
}

// Kept for callers that colour a single coin outside a chart (the asset picker chips).
export function compareColor(coin) {
  let h = 0
  for (let i = 0; i < coin.length; i++) h = (h * 31 + coin.charCodeAt(i)) % CMP_PALETTE.length
  return CMP_PALETTE[h]
}

// Axis labels: enough precision to place a point in the window, no more. A 1D window needs
// clock time; a 5Y window needs the year.
function _fmtAxis(ts, spanMs) {
  const dt = new Date(ts)
  if (spanMs <= 2 * 86400000) return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (spanMs <= 400 * 86400000) return dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return dt.toLocaleDateString([], { month: 'short', year: '2-digit' })
}

export function compareChartSvg(d, { width = 340, height = 200, colors = null } = {}) {
  if (!d.series.length) return ''
  const col = colors ?? assignCompareColors(d.series.map(s => s.coin))
  const padL = 6, padR = 6, padT = 10, padB = 6
  const w = width - padL - padR, h = height - padT - padB
  const span = d.t1 - d.t0 || 1
  const range = d.max - d.min || 1
  const x = t => padL + ((t - d.t0) / span) * w
  const y = v => padT + (1 - (v - d.min) / range) * h

  // Zero line: every series starts there, so above it is outperformance.
  const zeroY = (d.min <= 0 && d.max >= 0) ? y(0) : null

  const paths = d.series.map(s => {
    const dAttr = s.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')
    return `<path d="${dAttr}" fill="none" stroke="${col[s.coin]}" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
  }).join('')

  const dots = d.series.map(s => {
    const p = s.pts[s.pts.length - 1]
    return `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.6" fill="${col[s.coin]}"/>`
  }).join('')

  // Hidden until scrubbed. One per series, indexed so the scrub handler can move them
  // without re-rendering the chart.
  const hoverDots = d.series.map((s, i) =>
    `<circle class="cmp-hd" data-i="${i}" r="3.4" fill="${col[s.coin]}" stroke="var(--bg)" stroke-width="1.5" style="display:none"/>`).join('')

  return `<svg class="cmp-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
    data-t0="${d.t0}" data-t1="${d.t1}" data-padl="${padL}" data-w="${w}"
    data-padt="${padT}" data-h="${h}" data-min="${d.min}" data-max="${d.max}"
    style="width:100%;height:${height}px;display:block;overflow:visible;touch-action:pan-y">
    ${zeroY != null ? `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${width - padR}" y2="${zeroY.toFixed(1)}"
      stroke="var(--border2)" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
    ${paths}${dots}
    <line class="cmp-cross" y1="${padT}" y2="${padT + h}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" style="display:none"/>
    ${hoverDots}
  </svg>`
}

// Three x-axis labels — start, middle, end. Rendered as HTML under the SVG rather than as
// SVG text: preserveAspectRatio="none" stretches the viewBox horizontally, which would
// distort any text inside it.
export function compareAxisHtml(d) {
  if (!d.series.length) return ''
  const span = d.t1 - d.t0
  const mid  = d.t0 + span / 2
  const cell = (ts, align) => `<span style="flex:1;text-align:${align};font-size:9.5px;color:var(--muted);white-space:nowrap">${_fmtAxis(ts, span)}</span>`
  return `<div style="display:flex;padding:3px 16px 0">${cell(d.t0, 'left')}${cell(mid, 'center')}${cell(d.t1, 'right')}</div>`
}

/**
 * Wire scrubbing on a container holding a compareChartSvg. Returns a detach function.
 * Reads geometry off the SVG's data- attributes so it never recomputes the scale and can
 * never disagree with the drawn lines.
 */
export function attachCompareScrub(root, d, { onReadout = () => {}, colors = null } = {}) {
  const svg = root?.querySelector('.cmp-svg')
  if (!svg || !d.series.length) return () => {}
  const col   = colors ?? assignCompareColors(d.series.map(s => s.coin))
  const cross = svg.querySelector('.cmp-cross')
  const hds   = [...svg.querySelectorAll('.cmp-hd')]
  const t0 = +svg.dataset.t0, t1 = +svg.dataset.t1
  const padL = +svg.dataset.padl, w = +svg.dataset.w
  const padT = +svg.dataset.padt, hh = +svg.dataset.h
  const vMin = +svg.dataset.min, vMax = +svg.dataset.max
  const vbW = svg.viewBox.baseVal.width || 340
  const span = t1 - t0 || 1
  // Identical mapping to the one the paths were drawn with, taken from the same numbers —
  // a second copy of the formula could drift from the lines it is meant to sit on.
  const yOf = v => padT + (1 - (v - vMin) / ((vMax - vMin) || 1)) * hh

  const clear = () => {
    cross.style.display = 'none'
    hds.forEach(c => { c.style.display = 'none' })
    onReadout(null)
  }

  const move = (clientX) => {
    const r = svg.getBoundingClientRect()
    if (!r.width) return
    // Map the pointer into viewBox units. preserveAspectRatio="none" means x scales purely
    // by the width ratio, so this is a straight proportion — no aspect correction needed.
    const vx = ((clientX - r.left) / r.width) * vbW
    const frac = Math.max(0, Math.min(1, (vx - padL) / w))
    const t = t0 + frac * span
    cross.setAttribute('x1', (padL + frac * w).toFixed(1))
    cross.setAttribute('x2', (padL + frac * w).toFixed(1))
    cross.style.display = ''
    const at = []
    d.series.forEach((s, i) => {
      // Nearest sample in time. Series can be on different grids, so each is searched
      // independently rather than assuming a shared index.
      let best = s.pts[0], bd = Infinity
      for (const p of s.pts) { const dd = Math.abs(p.t - t); if (dd < bd) { bd = dd; best = p } }
      const c = hds[i]
      if (c) {
        c.setAttribute('cx', (padL + ((best.t - t0) / span) * w).toFixed(1))
        c.setAttribute('cy', yOf(best.v).toFixed(1))
        c.style.display = ''
      }
      at.push({ coin: s.coin, v: best.v, color: col[s.coin] })
    })
    onReadout({ t, at })
  }

  const onPointer = e => { move(e.clientX ?? e.touches?.[0]?.clientX ?? 0) }
  svg.addEventListener('pointermove', onPointer)
  svg.addEventListener('pointerdown', onPointer)
  svg.addEventListener('pointerleave', clear)
  svg.addEventListener('pointercancel', clear)
  return () => {
    svg.removeEventListener('pointermove', onPointer)
    svg.removeEventListener('pointerdown', onPointer)
    svg.removeEventListener('pointerleave', clear)
    svg.removeEventListener('pointercancel', clear)
  }
}

export function compareReadoutHtml(r, label = c => c) {
  if (!r) return ''
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:baseline">
    <span style="font-size:10.5px;color:var(--muted);white-space:nowrap">${new Date(r.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
    ${r.at.map(a => `<span style="font-size:11px;white-space:nowrap"><span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${a.color};margin-right:4px"></span>${_esc(label(a.coin))} <b style="font-family:var(--font-mono);color:${a.v >= 0 ? 'var(--green)' : 'var(--red)'}">${a.v >= 0 ? '+' : ''}${a.v.toFixed(2)}%</b></span>`).join('')}
  </div>`
}

/**
 * `sub` adds a second figure under the percentage. Off by default: for the asset comparison
 * this legend was written for, the absolute move is a price change per unit and comparing
 * those across coins is meaningless. For a wallet comparison it is the dollars gained, which
 * is the thing the percentage cannot tell you — +991% on a small wallet and +25% on a large
 * one can be the same money.
 */
export function compareLegendHtml(d, { label = c => c, colors = null, sub = null } = {}) {
  const col = colors ?? assignCompareColors(d.series.map(s => s.coin))
  return d.series.map(s => {
    const tone = s.change >= 0 ? 'var(--green)' : 'var(--red)'
    const extra = sub ? sub(s) : ''
    return `<div style="display:flex;align-items:center;gap:7px;padding:5px 0;min-width:0">
      <span style="width:9px;height:9px;border-radius:3px;flex-shrink:0;background:${col[s.coin]}"></span>
      <span style="font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(label(s.coin))}</span>
      <span style="flex:1"></span>
      <span style="text-align:right;white-space:nowrap">
        <span style="font-size:12.5px;font-weight:800;font-family:var(--font-mono);color:${tone}">
          ${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%</span>
        ${extra ? `<span style="display:block;font-size:11px;font-family:var(--font-mono);color:var(--muted);margin-top:1px">${extra}</span>` : ''}
      </span>
    </div>`
  }).join('')
}

/** Best minus worst over the window — the spread the comparison exists to show. */
export function compareSpread(d) {
  if (d.series.length < 2) return null
  return { best: d.series[0], worst: d.series[d.series.length - 1],
           spread: d.series[0].change - d.series[d.series.length - 1].change }
}
