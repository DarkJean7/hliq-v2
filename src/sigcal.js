/**
 * Calendar performance for one market: how each month of a year did, and each day of a month.
 *
 * Asked: "in signals we have the asset performance just by timeframes. what if we also add a
 * calendar performance so i can see the asset performance on a desired month from the past".
 * The timeframe table answers "how has it moved lately"; this answers "how did it do in March
 * 2025". It reads the daily candles Signals already loads (from Hyperliquid's launch), so it costs
 * no requests of its own.
 *
 * A period's return is its last close against the close BEFORE it — the previous day's or the
 * previous month's — so a month's figure and the sum of its days describe the same moves. The
 * first period a market traded has nothing before it and is measured from its first open instead,
 * and says so (`partial`), because "+400% in its listing month" is a different kind of number.
 * Times are UTC, as Hyperliquid's daily candles are.
 */

const DAY = 86_400_000

/** Daily candles as [{ t, o, c }], oldest first, one per UTC day. Unusable rows are dropped. */
export function dailyCloses(candles) {
  const by = new Map()
  for (const k of candles ?? []) {
    const t = Number(k?.t), o = parseFloat(k?.o), c = parseFloat(k?.c)
    if (!Number.isFinite(t) || !(c > 0)) continue
    const day = Math.floor(t / DAY) * DAY
    by.set(day, { t: day, o: o > 0 ? o : c, c })
  }
  return [...by.values()].sort((a, b) => a.t - b.t)
}

/** The years the data covers, newest first. */
export function yearsOf(rows) {
  if (!rows?.length) return []
  const a = new Date(rows[0].t).getUTCFullYear(), b = new Date(rows.at(-1).t).getUTCFullYear()
  const out = []
  for (let y = b; y >= a; y--) out.push(y)
  return out
}

const ym = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth() }

/**
 * Each month of `year`: { m (0-11), ret, partial, current } — ret null where the market had no
 * trading that month. `current` marks the month still in progress.
 */
export function monthReturns(rows, year, now = Date.now()) {
  const last = new Map()    // year*12+month -> last close
  const first = new Map()   // year*12+month -> first open
  for (const r of rows ?? []) {
    const k = ym(r.t)
    if (!first.has(k)) first.set(k, r.o)
    last.set(k, r.c)
  }
  const nowK = ym(now)
  const out = []
  for (let m = 0; m < 12; m++) {
    const k = year * 12 + m
    if (!last.has(k)) { out.push({ m, ret: null, partial: false, current: k === nowK }); continue }
    const prev = last.get(k - 1)
    const base = prev ?? first.get(k)
    out.push({ m, ret: last.get(k) / base - 1, partial: prev == null, current: k === nowK })
  }
  return out
}

/**
 * The days of one month: { lead, days: [{ d, ret, partial }], total, best, worst, partial }.
 * `lead` is how many blank cells come first in a Monday-first week. A day with no candle
 * (before listing, or still to come) has ret null.
 */
export function monthDays(rows, year, month, now = Date.now()) {
  const start = Date.UTC(year, month, 1), end = Date.UTC(year, month + 1, 1)
  const n = Math.round((end - start) / DAY)
  const byDay = new Map((rows ?? []).map((r, i) => [r.t, i]))
  const days = []
  for (let d = 1; d <= n; d++) {
    const t = start + (d - 1) * DAY
    const i = byDay.get(t)
    if (i == null) { days.push({ d, ret: null, partial: false, future: t > now }); continue }
    const r = rows[i], prev = rows[i - 1]
    // Only the day directly before counts as "the close before it": a gap in the data must not
    // fold several days of moves into one cell.
    const usePrev = prev && prev.t === t - DAY
    days.push({ d, ret: r.c / (usePrev ? prev.c : r.o) - 1, partial: !usePrev, future: false })
  }
  const traded = days.filter(x => x.ret != null)
  const mr = monthReturns(rows, year, now)[month]
  return {
    lead: (new Date(start).getUTCDay() + 6) % 7,
    days,
    total: mr.ret,
    partial: mr.partial,
    best: traded.length ? traded.reduce((a, b) => (b.ret > a.ret ? b : a)) : null,
    worst: traded.length ? traded.reduce((a, b) => (b.ret < a.ret ? b : a)) : null,
  }
}

/** How strongly to tint a cell for a return, 0–1, so a quiet day does not shout. */
export function tint(ret, fullAt) {
  if (ret == null || !Number.isFinite(ret)) return 0
  return Math.min(1, Math.abs(ret) / fullAt)
}
