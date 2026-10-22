/**
 * Dates on a chart's time axis, and on its hover tag (src/charts.js).
 *
 * Asked: "lets add fixed days in the chart and the one when scrolling the chart like hovering".
 * The Overview chart had no time axis at all; these say when each point is. Kept apart from
 * charts.js, which needs a browser, so the formats can be checked on their own
 * (tests/suites/chartdates.test.mjs). Local time, as the rest of the app shows it.
 */
const _M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const _two = (n) => String(n).padStart(2, '0')
/** A tick: "14:00" within two days, "Oct 21" within ~four months, "Mar 2025" beyond. */
export function chartDateTick(t, span) {
  const d = new Date(Number(t))
  if (!Number.isFinite(d.getTime())) return ''
  if (span <= 2 * 864e5) return _two(d.getHours()) + ':' + _two(d.getMinutes())
  if (span <= 120 * 864e5) return _M[d.getMonth()] + ' ' + d.getDate()
  return _M[d.getMonth()] + ' ' + d.getFullYear()
}
/** The hover tag says more than a tick: the day and the time, or the full date for long spans. */
export function chartDateHover(t, span) {
  const d = new Date(Number(t))
  if (!Number.isFinite(d.getTime())) return ''
  const day = _M[d.getMonth()] + ' ' + d.getDate()
  if (span <= 45 * 864e5) return day + ', ' + _two(d.getHours()) + ':' + _two(d.getMinutes())
  return day + ', ' + d.getFullYear()
}
