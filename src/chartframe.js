/**
 * INSOLVENT TERMINAL — how tall a chart should be
 *
 * Reported against the calendar's month chart: "i dont want the 0 to be in the middle unless
 * is needed because the account have been down. in my case it havent." A September up $2,523
 * that was never red was drawn on an axis running −$5,000 to +$5,000: the line crawled along
 * the top third and half the card showed a loss that never happened.
 *
 * That was not a quirk of the data. Chart.js's `maxTicksLimit` does not cap the labels ON a
 * range — it makes the tick generator pick a spacing coarse enough to fit that many, and then
 * the range grows out to a multiple of that spacing. Three labels over $2,578 of data bought
 * a $10,000 axis. Asking for fewer labels made it worse, which is the opposite of how it
 * reads in the options.
 *
 * So the frame is computed here instead, from the points that are actually on screen, and
 * handed to Chart.js as an explicit min and max.
 *
 *   A PnL LINE IS READ AGAINST ZERO, so zero is always in frame — but at the FLOOR of a month
 *   that only went up and at the CEILING of one that only went down. It lands in the middle
 *   exactly when the month crossed it, which is the only time that means anything.
 *
 *   A VALUE LINE IS NOT: an account oscillating between $9,800 and $10,300 is drawn across
 *   that $500, not flattened against the top of a frame that starts at zero. What the reader
 *   wants to see there is the shape of the move, and the hero above the chart carries the
 *   absolute number.
 *
 * Points outside the x window are excluded before measuring: an off-screen outlier that
 * stretches the axis is a frame nobody can read, for a spike nobody can see.
 */

/**
 * `points`  — [{x, y}], the same array the chart is given.
 * `kind`    — 'pnl' (zero is the reference) or 'value' (hug the data).
 * `xMin`/`xMax` — the visible window, or null for "all of it".
 *
 * Returns { min, max }, or null when there is nothing to measure — the caller then leaves the
 * scale alone rather than inventing one.
 */
export function frameFor(points, { kind = 'pnl', xMin = null, xMax = null } = {}) {
  const all = (points ?? []).filter(p => p && Number.isFinite(p.y))
  if (!all.length) return null
  const vis = all.filter(p => (xMin == null || p.x >= xMin) && (xMax == null || p.x <= xMax))
  const src = vis.length > 1 ? vis : all

  let lo = Math.min(...src.map(p => p.y))
  let hi = Math.max(...src.map(p => p.y))
  if (kind !== 'value') { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }

  // A flat line still needs a frame with height, or it is drawn on the floor.
  const span = (hi - lo) || Math.max(1, Math.abs(hi || lo) * 0.1)
  const pad  = span * 0.08
  // A dip of a few dollars in a month of thousands is not "the account went down" — it is the
  // first hour of the 1st, or a rounding wobble. Under 3% of the range it does not earn space
  // below the line.
  const tiny = span * 0.03

  if (kind === 'value') return { min: lo - pad, max: hi + pad }
  const min = lo >= -tiny ? 0 : lo - pad
  const max = hi <=  tiny ? 0 : hi + pad
  // A month that made and lost exactly nothing collapses both ends onto zero, and a frame
  // with no height is not a frame — the line would be drawn on the border, or nowhere.
  return max > min ? { min, max } : { min, max: min + span }
}
