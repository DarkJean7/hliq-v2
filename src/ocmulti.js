// Outcome charts: a range that fits the line, and one chart for an event's leading options.
//
// Asked for: "lets update the outcomes charts to make them more responsive. also show charts of
// multiple options" — with outcome.xyz's NBA-winner chart as the example: a line per team, its
// name and odds at the line's end.
//
// "Responsive": the y-axis was fixed at 0-100%, so a market at 1-3% drew as a flat line on the
// floor (the BTC $85k screenshot). It now spans the line's own range, padded, kept inside 0-100.
//
// Pure: arrays in, numbers out. main.js fetches the candles and owns the canvas.

// Distinct and readable on a dark card; the leader gets the first.
export const LINE_COLORS = ['#e8e8ee', '#ff6b3d', '#ff3f6c', '#3fb8ff', '#ffd23f', '#7ee08a']

/** The y range (in %) for a set of values: their span, padded, inside [0, 100]. */
export function yRange(values, { minSpan = 6 } = {}) {
  const v = values.filter(Number.isFinite)
  if (!v.length) return { min: 0, max: 100 }
  let lo = Math.min(...v), hi = Math.max(...v)
  const pad = Math.max((hi - lo) * 0.18, 1)
  lo -= pad; hi += pad
  // A line that barely moves still gets some height, centred on where it is.
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2 }
  if (lo < 0) { hi -= lo; lo = 0 }
  if (hi > 100) { lo -= hi - 100; hi = 100 }
  // Snapped to a round step so the axis reads 5% / 10% / 15%, not 4% / 10% / 20% / 25%.
  const span = hi - lo, step = span > 40 ? 10 : span > 15 ? 5 : span > 6 ? 2 : 1
  return { min: Math.max(0, Math.floor(lo / step) * step), max: Math.min(100, Math.ceil(hi / step) * step) }
}

/** The options to draw: the `n` most likely now. rows: [{ id, name, p }] with p in 0..1. */
export function pickLegs(rows, n = 4) {
  return [...rows].filter(r => r && r.id != null).sort((a, b) => (b.p ?? 0) - (a.p ?? 0)).slice(0, n)
}

/**
 * Several candle series on one time axis. A leg's candle exists only when it traded, so each is
 * carried forward from its last close — a quiet hour is the same odds, not a gap — and starts
 * at its own first trade (nothing is invented before it).
 * series: [[{ t, c }]] → { times: [t], lines: [[pct|null]] }
 */
export function alignSeries(series) {
  const times = [...new Set(series.flatMap(s => s.map(k => Number(k.t))))].sort((a, b) => a - b)
  const lines = series.map(s => {
    const by = new Map(s.map(k => [Number(k.t), parseFloat(k.c) * 100]))
    let last = null
    return times.map(t => { if (by.has(t)) last = by.get(t); return last })
  })
  return { times, lines }
}

/**
 * End labels that do not sit on each other: each wants to be at its line's last y, and any two
 * closer than `gap` are pushed apart, kept inside [top, bottom]. ys in pixels; same order back.
 */
export function spreadLabels(ys, gap, top, bottom) {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y)
  for (let k = 1; k < order.length; k++) if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap
  // Overflowed the bottom: push the stack back up.
  const over = order.length ? order[order.length - 1].y - bottom : 0
  if (over > 0) for (const o of order) o.y -= over
  for (let k = 0; k < order.length; k++) if (order[k].y < top + k * gap) order[k].y = top + k * gap
  const out = new Array(ys.length)
  for (const o of order) out[o.i] = o.y
  return out
}

/** A short tag for an option: "San Antonio Spurs" → "SAS"-ish initials, a short name as is. */
export function shortName(name) {
  const s = String(name ?? '').trim()
  if (s.length <= 10) return s
  const w = s.split(/\s+/).filter(Boolean)
  if (w.length === 1) return s.slice(0, 9) + '…'
  // The last word is what a team is called ("Spurs"); keep it whole when it fits.
  const last = w[w.length - 1]
  return last.length <= 12 ? last : last.slice(0, 11) + '…'
}

/** Axis ticks for a time span: dates across days, times within one. */
export function fmtTick(t, spanMs) {
  const d = new Date(t)
  // Over four days, the date alone. Between a day and a half and four, the date repeats across
  // ticks ("Nov 15, Nov 15, Nov 16"), so the hour goes with it. Within a day and a half, the time.
  if (spanMs > 4 * 24 * 3600e3) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (spanMs > 36 * 3600e3) return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric' })
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
