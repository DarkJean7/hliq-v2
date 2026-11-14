// The Portfolio chart's time logic: which history a timeframe reads, how the four histories
// Hyperliquid publishes are stitched into one for Advanced, and where the time labels go.
//
// Asked for: lower timeframes (4H, 8H), hours and minutes on the chart, days visible without
// hovering, and a zoom that shows something when you zoom. That last one was a data problem,
// not a drawing one: Advanced read only the all-time history, whose points are days apart, so
// zooming to an hour stretched one or two points across the screen. Hyperliquid publishes the
// same account at four resolutions (day, week, month, allTime); stitched finest-last, every
// zoom level gets the finest points that exist for it.
//
// Pure: no DOM, no state. main.js draws.

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

/** How far back each timeframe reaches; null = everything. */
export const PERIOD_SPAN = { '1H': HOUR, '4H': 4 * HOUR, '8H': 8 * HOUR, '1D': DAY, '7D': 7 * DAY, '1M': 30 * DAY, 'allTime': null }
/** Which of Hyperliquid's histories holds that timeframe at the finest resolution. */
export const PERIOD_WINDOW = { '1H': 'day', '4H': 'day', '8H': 'day', '1D': 'day', '7D': 'week', '1M': 'month', 'allTime': 'allTime' }

const num = (v) => parseFloat(v)

/** The value of a [t, v] series at time t, interpolated; null outside it. */
export function valueAt(hist, t) {
  const n = hist?.length ?? 0
  if (!n) return null
  if (t < +hist[0][0] || t > +hist[n - 1][0]) return null
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (+hist[m][0] <= t) lo = m; else hi = m }
  const ta = +hist[lo][0], tb = +hist[hi][0], va = num(hist[lo][1]), vb = num(hist[hi][1])
  return tb > ta ? va + (vb - va) * (t - ta) / (tb - ta) : va
}

/**
 * The part of a series from `since` on, starting exactly at `since` (interpolated) so a 4H
 * chart starts at its left edge rather than at whichever point happened to come next.
 */
export function sliceSince(hist, since) {
  if (!hist?.length || since == null) return hist ?? []
  const out = hist.filter(p => +p[0] >= since)
  const v = valueAt(hist, since)
  if (v != null && (!out.length || +out[0][0] > since)) out.unshift([since, String(v)])
  return out
}

/**
 * Hyperliquid's four histories as one, finest wherever a finer one exists.
 *
 * Value is absolute, so finer points simply replace coarser ones over their span. PnL is not:
 * each window's pnlHistory counts from that window's own start. The finer series is shifted
 * so it begins where the stitched series stood at that moment — the alternative is a cliff
 * at every seam.
 */
export function stitchHistories(portfolio, histKey) {
  const get = (w) => ((portfolio ?? []).find(p => p[0] === w)?.[1]?.[histKey] ?? []).filter(p => Number.isFinite(num(p[1])))
  let out = get('allTime').map(p => [+p[0], num(p[1])])
  for (const w of ['month', 'week', 'day']) {
    const fine = get(w)
    if (fine.length < 2) continue
    const t0 = +fine[0][0]
    let shift = 0
    if (histKey === 'pnlHistory') {
      const at = valueAt(out, t0)
      shift = at == null ? 0 : at - num(fine[0][1])
    }
    out = out.filter(p => p[0] < t0).concat(fine.map(p => [+p[0], num(p[1]) + shift]))
  }
  return out.map(([t, v]) => [t, String(v)])
}

// ── time axis ────────────────────────────────────────────────────────────────

// Candidate spacings, finest first. Months and years are calendar steps, not fixed lengths.
const STEPS = [
  { ms: 5 * MIN }, { ms: 15 * MIN }, { ms: 30 * MIN }, { ms: HOUR }, { ms: 2 * HOUR }, { ms: 3 * HOUR },
  { ms: 6 * HOUR }, { ms: 12 * HOUR }, { ms: DAY, day: 1 }, { ms: 2 * DAY, day: 2 }, { ms: 7 * DAY, day: 7 },
  { ms: 14 * DAY, day: 14 }, { ms: 30 * DAY, month: 1 }, { ms: 91 * DAY, month: 3 }, { ms: 182 * DAY, month: 6 },
  { ms: 365 * DAY, month: 12 },
]

const pad2 = (n) => String(n).padStart(2, '0')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

/**
 * Ticks for [t0, t1] across `width` px, at least `minGap` px apart, on round local times.
 * Each tick: { t, label, day } — `day` marks a tick that starts a new day, which is labelled
 * with the date instead of the time, so an intraday chart says which day it is without a hover.
 */
export function timeTicks(t0, t1, width, minGap = 64) {
  const span = t1 - t0
  if (!(span > 0) || !(width > 0)) return []
  const want = Math.max(1, Math.floor(width / minGap))
  const step = STEPS.find(s => span / s.ms <= want) ?? STEPS[STEPS.length - 1]
  const out = []
  if (step.month) {
    const d = new Date(t0); d.setHours(0, 0, 0, 0); d.setDate(1)
    d.setMonth(Math.ceil(d.getMonth() / step.month) * step.month)   // first boundary on the step
    while (d.getTime() < t0) d.setMonth(d.getMonth() + step.month)
    for (; d.getTime() <= t1; d.setMonth(d.getMonth() + step.month)) {
      const t = d.getTime()
      out.push({ t, day: true, label: d.getMonth() === 0 ? String(d.getFullYear()) : MON[d.getMonth()] })
    }
    return out
  }
  if (step.day) {
    let t = startOfDay(t0)
    if (step.day === 7 || step.day === 14) {
      // Weekly ticks on a fixed weekday (Monday), so they do not shift as the window pans.
      const d = new Date(t); d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); t = d.getTime()
    }
    while (t < t0) { const d = new Date(t); d.setDate(d.getDate() + step.day); t = d.getTime() }
    for (; t <= t1; ) {
      const d = new Date(t)
      out.push({ t, day: true, label: d.getDate() === 1 && step.day >= 7 ? MON[d.getMonth()] : `${MON[d.getMonth()]} ${d.getDate()}` })
      d.setDate(d.getDate() + step.day); t = d.getTime()
    }
    return out
  }
  // Intraday: aligned to the step from local midnight.
  let t = startOfDay(t0)
  while (t < t0) t += step.ms
  for (; t <= t1; t += step.ms) {
    const d = new Date(t)
    // Re-align across a daylight-saving change, which makes a "day" 23 or 25 hours long.
    const mid = startOfDay(t)
    const isDay = t === mid
    out.push({ t, day: isDay, label: isDay ? `${MON[d.getMonth()]} ${d.getDate()}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
  }
  return out
}

/** "Nov 12, 14:05" — a point's time, to the minute; the year only when it is not this one. */
export function fmtPointTime(t, now = Date.now()) {
  const d = new Date(+t)
  const yr = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${MON[d.getMonth()]} ${d.getDate()}${yr}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "Nov 3 – Nov 12" / "14:00 – 18:00" — what the window shows, for the readout under the zoom. */
export function fmtRange(t0, t1) {
  const a = new Date(t0), b = new Date(t1)
  const sameDay = startOfDay(t0) === startOfDay(t1)
  if (sameDay) return `${MON[a.getMonth()]} ${a.getDate()}, ${pad2(a.getHours())}:${pad2(a.getMinutes())} – ${pad2(b.getHours())}:${pad2(b.getMinutes())}`
  const yr = a.getFullYear() !== b.getFullYear()
  const f = (d) => `${MON[d.getMonth()]} ${d.getDate()}${yr ? ' ' + d.getFullYear() : ''}`
  return t1 - t0 < 3 * DAY ? `${f(a)} ${pad2(a.getHours())}:${pad2(a.getMinutes())} – ${f(b)} ${pad2(b.getHours())}:${pad2(b.getMinutes())}` : `${f(a)} – ${f(b)}`
}
