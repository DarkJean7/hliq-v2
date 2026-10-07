/**
 * Reported revenue for the STOCKS Hyperliquid lists (HIP-3), from the SEC's XBRL API — for
 * the /markets page's TradFi revenue view. Stocks report by quarter, not by day, so these sit
 * in their own columns (last quarter, trailing twelve months, year-on-year) and are never
 * mixed into the crypto 24h / 7d / 30d figures.
 *
 * Source: data.sec.gov/api/xbrl/companyconcept/CIK…/us-gaap/<concept>.json, one company and
 * one concept at a time. Free, no key, but the SEC asks for a User-Agent naming the caller.
 *
 * ── the fourth quarter ──
 *
 * A 10-K reports the YEAR, not its last quarter, so a company's fiscal Q4 is never filed on
 * its own. Microsoft's April–June quarter is exactly that, which is why a quarterly snapshot
 * of "every company's latest quarter" had no Microsoft, Oracle or Costco. It is derived:
 * fiscal year minus the three quarters inside it (MSFT FY2026: 331,839 − 77,673 − 81,273 −
 * 82,886 = 90,007, in $M). Only when all three are known, and never if it comes out negative.
 *
 * ── what is not covered, and stays unknown ──
 *
 * Companies that do not file with the SEC (Tencent, SK Hynix, Samsung), foreign filers that
 * report under IFRS in other currencies (ASML in EUR, TSMC in TWD), ETFs, and private
 * companies. Null, shown as a dash — not $0.
 *
 * Pure: no fetch. serve-prod.js fetches and caches.
 */

/** Revenue concepts, in the order companies most often use them. Each is tried. */
export const SEC_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
]

export const secConceptUrl = (cik, concept) =>
  `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/us-gaap/${concept}.json`
export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'

const DAY = 864e5
const t = (d) => new Date(d + 'T00:00:00Z').getTime()
const days = (x) => Math.round((t(x.end) - t(x.start)) / DAY)
const isQuarter = (x) => { const d = days(x); return d >= 80 && d <= 100 }
const isYear = (x) => { const d = days(x); return d >= 350 && d <= 380 }

/**
 * One concept's USD facts → its quarters, oldest first: [{ start, end, val, derived? }].
 * The same period is filed again in later reports (as comparatives); the latest filing wins.
 */
export function quarterSeries(facts) {
  const latest = new Map()
  for (const x of (Array.isArray(facts) ? facts : [])) {
    if (!x?.start || !x?.end || !Number.isFinite(Number(x.val))) continue
    const k = x.start + '|' + x.end
    const cur = latest.get(k)
    if (!cur || String(x.filed ?? '') > String(cur.filed ?? '')) latest.set(k, x)
  }
  const all = [...latest.values()]
  const qs = new Map(all.filter(isQuarter).map(x => [x.end, { start: x.start, end: x.end, val: Number(x.val) }]))
  for (const y of all.filter(isYear)) {
    if (qs.has(y.end)) continue
    const inside = [...qs.values()].filter(q => t(q.start) >= t(y.start) - 5 * DAY && t(q.end) <= t(y.end) && !q.derived)
    if (inside.length !== 3) continue
    const val = Number(y.val) - inside.reduce((a, q) => a + q.val, 0)
    if (!(val > 0)) continue
    const lastEnd = Math.max(...inside.map(q => t(q.end)))
    qs.set(y.end, { start: new Date(lastEnd + DAY).toISOString().slice(0, 10), end: y.end, val, derived: true })
  }
  return [...qs.values()].sort((a, b) => t(a.end) - t(b.end))
}

/**
 * A quarter series → what the page shows. `ttm` only when the last four quarters are
 * contiguous (no gap), `yoy` only when the same quarter a year earlier is known; each is
 * null otherwise, never estimated.
 */
export function summarizeRevenue(series) {
  const s = Array.isArray(series) ? series : []
  if (!s.length) return null
  const last = s[s.length - 1]
  const four = s.slice(-4)
  const contiguous = four.length === 4 && four.every((q, i) => i === 0 || Math.abs(t(q.start) - t(four[i - 1].end)) <= 10 * DAY)
  const yearAgo = s.find(q => Math.abs(t(last.end) - t(q.end) - 365 * DAY) <= 20 * DAY)
  return {
    q: last.val, qStart: last.start, qEnd: last.end, qDerived: !!last.derived,
    ttm: contiguous ? four.reduce((a, q) => a + q.val, 0) : null,
    yoy: yearAgo && yearAgo.val > 0 ? (last.val / yearAgo.val - 1) * 100 : null,
  }
}

/**
 * Several concepts for one company → the summary of the one with the most recent quarter
 * (companies switch concepts over the years; the stale one would show an old quarter).
 * `byConcept` is { concept: facts[] }.
 */
export function companyRevenue(byConcept) {
  let best = null
  for (const [concept, facts] of Object.entries(byConcept ?? {})) {
    const series = quarterSeries(facts)
    const sum = summarizeRevenue(series)
    if (!sum) continue
    // The last 16 quarters, for the chart: [start, end, value, derived ? 1 : 0].
    const hist = series.slice(-16).map(q => [q.start, q.end, q.val, q.derived ? 1 : 0])
    if (!best || sum.qEnd > best.qEnd || (sum.qEnd === best.qEnd && sum.q > best.q)) best = { ...sum, concept, hist }
  }
  return best
}
