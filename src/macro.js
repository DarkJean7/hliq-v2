// Macro data for the Signals tab: US economic reports, rates, sentiment and when the next report lands.
// Pure: the fetcher is handed in, so serve-prod.js, the dev server and the tests all run this same code.
// None of it touches Hyperliquid, so none of it spends the rate-limit budget.
//
// Empty is not unknown. FRED leaves a month blank when it was never published: October 2025 has no CPI,
// because the shutdown stopped the survey. So a year-on-year looks up the same month a year earlier BY
// DATE, and a month with no partner has no figure. Stepping back twelve rows would quietly compare
// against the wrong month for a whole year after any gap.

const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv'
export const FNG_URL = 'https://api.alternative.me/fng/?limit=0'     // everything, back to February 2018
export const CG_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global'
export const BLS_ICS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics'
export const BEA_ICS_URL = 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics'
// Every past release of each BLS report, by the month it covers. The calendar above has dates but not
// periods, and only from 2025; these pages name the month and go back decades.
export const BLS_ARCHIVE = {
  cpi: 'https://www.bls.gov/bls/news-release/cpi.htm', jobs: 'https://www.bls.gov/bls/news-release/empsit.htm',
  ppi: 'https://www.bls.gov/bls/news-release/ppi.htm', jolts: 'https://www.bls.gov/bls/news-release/jolts.htm',
}
export const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
export const NOWCAST_MONTH_URL = 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_month.json'
export const NOWCAST_YEAR_URL = 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json'
export const BTC_CHART_URL = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily'
export const MACRO_UA = 'InsolventTerminal/1.0 (+https://insolvent.trade)'

const LONG = 7 * 365 * 864e5    // reports: six years to show, plus the year a year-on-year needs behind it
const SHORT = 400 * 864e5       // daily markets: a year is plenty, and 8 × 6 years of days is a big answer
const SEP_SPAN = 400 * 864e5   // the Fed's projections are dated by the year they describe, which run ahead of today
export const MACRO_SERIES = {
  CPIAUCNS: LONG, CPIAUCSL: LONG, CPILFENS: LONG, CPILFESL: LONG, PCEPI: LONG, PCEPILFE: LONG, PPIFIS: LONG,
  UNRATE: LONG, PAYEMS: LONG, ICSA: SHORT, A191RL1Q225SBEA: LONG, UMCSENT: LONG,
  JTSJOL: LONG, GDPNOW: SHORT, FEDTARMD: SEP_SPAN, PCECTPIMD: SEP_SPAN, JCXFEMD: SEP_SPAN, UNRATEMD: SEP_SPAN, GDPC1MD: SEP_SPAN,
  DFEDTARU: LONG, DFEDTARL: LONG, DGS10: SHORT, DGS2: SHORT, T10Y2Y: SHORT, DTWEXBGS: SHORT, DCOILWTICO: SHORT, VIXCLS: SHORT,
}
const DAY = (t) => new Date(t).toISOString().slice(0, 10)
export const fredUrl = (id, now = Date.now()) => `${FRED_CSV}?id=${id}&cosd=${DAY(now - MACRO_SERIES[id])}`

/** "date,value" rows, oldest first. A blank or "." is a month that has no figure: null, never 0. */
export function parseFredCsv(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/)
  if (!/^observation_date,/i.test(lines[0] ?? '')) return null     // an error page, not the data
  const out = []
  for (const l of lines.slice(1)) {
    const [d, v] = l.split(',')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) continue
    const n = v === '' || v === '.' || v == null ? null : Number(v)
    out.push([d, Number.isFinite(n) ? n : null])
  }
  return out.some(r => r[1] != null) ? out : null
}

const shiftMonths = (d, n) => {
  const [y, m] = d.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  return t.toISOString().slice(0, 7) + '-01'
}
const known = (rows) => (rows ?? []).filter(r => r[1] != null)

/** Percent change against the same month a year earlier. A month with no partner is left out. */
export function yoy(rows) {
  const by = new Map(known(rows))
  return known(rows).flatMap(([d, v]) => { const b = by.get(shiftMonths(d, -12)); return b ? [[d, (v / b - 1) * 100]] : [] })
}
/** Percent change on the month before. It has to be the month before: across a gap it would be two months' worth. */
export function mom(rows) {
  const by = new Map(known(rows))
  return known(rows).flatMap(([d, v]) => { const b = by.get(shiftMonths(d, -1)); return b ? [[d, (v / b - 1) * 100]] : [] })
}
/** Change on the month before, in the series' own units. Payrolls are the month's jobs added. */
export function monthDiff(rows) {
  const by = new Map(known(rows))
  return known(rows).flatMap(([d, v]) => { const b = by.get(shiftMonths(d, -1)); return b != null ? [[d, v - b]] : [] })
}

const STAMP = (d) => Date.parse(d + 'T12:00:00Z')     // midday, so no timezone shows the day before
const CUT = { m: 72, q: 24, w: 56, d: 280 }           // how much history goes to the page

/** One row of the page. No rows gives value: null, which the page shows as unavailable rather than 0. */
function item(key, group, fmt, period, rows, next = null, extra = null) {
  const r = rows ?? []
  const last = r.at(-1), prev = r.at(-2)
  return {
    key, group, fmt, period, next,
    date: last?.[0] ?? null, value: last?.[1] ?? null,
    prevDate: prev?.[0] ?? null, prev: prev?.[1] ?? null,
    pts: r.slice(-CUT[period]).map(([d, v]) => [STAMP(d), +v.toFixed(3)]),
    ...extra,
  }
}
function lastOf(rows) { const k = known(rows); return k.at(-1) ?? null }

/** The Fed's target only moves at a decision, so the history is its changes and the row dates the last one. */
function fedItem(hi, lo) {
  const up = known(hi), top = lastOf(hi), low = lastOf(lo)
  const changes = up.filter((r, i) => i === 0 || r[1] !== up[i - 1][1])
  const last = changes.at(-1), before = changes.at(-2)
  const row = item('fed', 'rates', 'pct2', 'd', [], 'fomc')
  if (!top || !low) return row
  return { ...row, date: last[0], value: top[1], low: low[1], prev: before?.[1] ?? null, prevDate: before?.[0] ?? null,
    pts: [...changes.map(([d, v]) => [STAMP(d), v]), [STAMP(top[0]), top[1]]] }
}

/** The page's answer. A source that has never answered is null, and the page says so. */
export function buildMacro(raw, now = Date.now()) {
  const s = raw?.series ?? {}
  // momPts: the monthly change's history, for Past reports. A month with no partner a year back (October
  // 2026, after the shutdown's missing October 2025) has no yearly figure but does have this one.
  const momOf = (id) => {
    const all = mom(s[id]), m = all.at(-1)
    return m ? { mom: m[1], momDate: m[0], momPts: all.slice(-CUT.m).map(([d, v]) => [STAMP(d), +v.toFixed(3)]) } : null
  }
  const lvl = (id) => known(s[id])
  const items = [
    item('cpi', 'inflation', 'pct1', 'm', yoy(s.CPIAUCNS), 'cpi', momOf('CPIAUCSL')),
    item('core', 'inflation', 'pct1', 'm', yoy(s.CPILFENS), 'cpi', momOf('CPILFESL')),
    item('pce', 'inflation', 'pct1', 'm', yoy(s.PCEPI), 'pce', momOf('PCEPI')),
    item('corepce', 'inflation', 'pct1', 'm', yoy(s.PCEPILFE), 'pce', momOf('PCEPILFE')),
    item('ppi', 'inflation', 'pct1', 'm', yoy(s.PPIFIS), 'ppi', momOf('PPIFIS')),
    item('unrate', 'jobs', 'pct1', 'm', lvl('UNRATE'), 'jobs'),
    item('payrolls', 'jobs', 'jobs', 'm', monthDiff(s.PAYEMS), 'jobs'),
    item('claims', 'jobs', 'k', 'w', lvl('ICSA').map(([d, v]) => [d, v / 1000])),
    item('jolts', 'jobs', 'mil', 'm', lvl('JTSJOL').map(([d, v]) => [d, v / 1000]), 'jolts'),
    item('gdp', 'growth', 'pct1', 'q', lvl('A191RL1Q225SBEA'), 'gdp'),
    fedItem(s.DFEDTARU, s.DFEDTARL),
    item('y10', 'rates', 'pct2', 'd', lvl('DGS10')),
    item('y2', 'rates', 'pct2', 'd', lvl('DGS2')),
    item('curve', 'rates', 'pts2', 'd', lvl('T10Y2Y')),
    item('dollar', 'rates', 'num2', 'd', lvl('DTWEXBGS')),
    item('oil', 'rates', 'usd2', 'd', lvl('DCOILWTICO')),
    item('vix', 'sentiment', 'num2', 'd', lvl('VIXCLS')),
    item('umich', 'sentiment', 'num1', 'm', lvl('UMCSENT')),
  ]
  return {
    at: raw?.at ?? null,
    items,
    fng: raw?.fng ?? null,
    global: raw?.global ?? null,
    events: mergeEvents(raw?.events, now),
    nowcast: raw?.nowcast ?? null,
    gdpnow: (() => { const g = lastOf(s.GDPNOW); return g ? { date: g[0], value: g[1] } : null })(),
    sep: sepFor(s, now),
    reactions: btcReactions(raw?.events, raw?.btc, now),
    past: pastEvents(raw?.events, raw?.rel, raw?.btc, now),
    unknownCal: Object.entries(raw?.events ?? { bls: null, bea: null, fomc: null }).filter(([, v]) => !v).map(([k]) => k),
  }
}

const DAY_MS = 864e5
/** The Fed's median projections for this year and next. Each row is dated January of the year it describes. */
function sepFor(s, now) {
  const year = new Date(now).getUTCFullYear()
  const at = (id, y) => (s[id] ?? []).find(r => r[0] === `${y}-01-01`)?.[1] ?? null
  const out = { year, rate: at('FEDTARMD', year), rateNext: at('FEDTARMD', year + 1), pce: at('PCECTPIMD', year), core: at('JCXFEMD', year), unemp: at('UNRATEMD', year), gdp: at('GDPC1MD', year) }
  return Object.entries(out).some(([k, v]) => k !== 'year' && v != null) ? out : null
}

const NC_NAMES = { cpi: 'CPI Inflation', core: 'Core CPI Inflation', pce: 'PCE Inflation', corepce: 'Core PCE Inflation' }
const NC_ACTUAL = { cpi: 'Actual CPI Inflation', core: 'Actual Core CPI Inflation', pce: 'Actual PCE Inflation', corepce: 'Actual Core PCE Inflation' }
const nums = (series) => (series ?? []).map(p => (p?.value === '' || p?.value == null ? null : Number(p.value)))
/** Reads one Cleveland Fed file: the estimate for each month not yet reported, and how far the final one missed for those that were. */
function readNowcast(json) {
  if (!Array.isArray(json)) return null
  const est = {}, misses = Object.fromEntries(Object.keys(NC_NAMES).map(k => [k, []]))
  let asOf = null
  for (const chart of json.slice(-16)) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(chart?.chart?.subcaption ?? '')
    if (!m) continue
    const period = `${m[1]}-${m[2].padStart(2, '0')}`
    const stamp = Date.parse(String(chart.chart._comment ?? '').replace(' ', 'T') + ':00Z')
    if (Number.isFinite(stamp) && (asOf == null || stamp > asOf)) asOf = stamp
    const by = Object.fromEntries((chart.dataset ?? []).map(d => [d.seriesname, d.data]))
    for (const k of Object.keys(NC_NAMES)) {
      const nc = nums(by[NC_NAMES[k]]), act = nums(by[NC_ACTUAL[k]])
      const ai = act.findIndex(v => v != null && Number.isFinite(v))
      if (ai >= 0) {
        // The last estimate before the number came out, not the one on the day it was already known.
        let before = null
        for (let i = ai - 1; i >= 0; i--) if (nc[i] != null && Number.isFinite(nc[i])) { before = nc[i]; break }
        if (before != null) misses[k].push(Math.abs(act[ai] - before))
        continue
      }
      const last = nc.filter(v => v != null && Number.isFinite(v)).at(-1)
      if (last != null) (est[period] ??= {})[k] = last
    }
  }
  return { est, misses, asOf }
}
export function parseNowcast(monthJson, yearJson) {
  const mo = readNowcast(monthJson), yr = readNowcast(yearJson)
  if (!mo && !yr) return null
  const periods = {}
  for (const [p, v] of Object.entries(mo?.est ?? {})) (periods[p] ??= { m: {}, y: {} }).m = v
  for (const [p, v] of Object.entries(yr?.est ?? {})) (periods[p] ??= { m: {}, y: {} }).y = v
  if (!Object.keys(periods).length) return null
  const sum = (src) => Object.fromEntries(Object.entries(src ?? {}).flatMap(([k, a]) => {
    const r = a.slice(-12)
    return r.length ? [[k, { n: r.length, avg: r.reduce((x, y) => x + y, 0) / r.length, max: Math.max(...r) }]] : []
  }))
  return { asOf: mo?.asOf ?? yr?.asOf ?? null, periods, miss: { m: sum(mo?.misses), y: sum(yr?.misses) } }
}

/** Daily closes as [day, price]. A point at 00:00 UTC is the price as that day began, and the last point is "now". */
export function parseBtcChart(json) {
  const seen = new Map()
  for (const p of json?.prices ?? []) {
    const day = Math.floor(p?.[0] / 864e5), v = Number(p?.[1])
    if (Number.isFinite(day) && v > 0 && !seen.has(day)) seen.set(day, v)
  }
  const rows = [...seen].sort((a, b) => a[0] - b[0])
  return rows.length ? rows : null
}

/** How much Bitcoin moved across the UTC day of each past report, by kind, beside a typical day. */
export function btcReactions(events, btc, now = Date.now()) {
  if (!btc?.length) return null
  const px = new Map(btc)
  const dayMove = (d) => { const a = px.get(d), b = px.get(d + 1); return a && b ? (b / a - 1) * 100 : null }
  const all = btc.map(r => dayMove(r[0])).filter(v => v != null)
  if (!all.length) return null
  const normal = all.reduce((a, v) => a + Math.abs(v), 0) / all.length
  const out = {}
  const today = Math.floor(now / 864e5)
  for (const e of Object.values(events ?? {}).flat()) {
    if (!e || e.t > now) continue
    const day = Math.floor(e.t / 864e5)
    if (day >= today || day < today - 366) continue
    const m = dayMove(day)
    if (m != null) (out[e.kind] ??= new Map()).set(day, m)
  }
  return Object.fromEntries(Object.entries(out).map(([k, map]) => {
    const rows = [...map].sort((a, b) => a[0] - b[0])
    return [k, { n: rows.length, avgAbs: rows.reduce((a, r) => a + Math.abs(r[1]), 0) / rows.length, up: rows.filter(r => r[1] > 0).length, normal, recent: rows.slice(-6).reverse().map(([d, v]) => [d, +v.toFixed(2)]) }]
  }))
}

/** Fear & Greed. Newest first from the source; stored oldest first as [day number, value], which keeps six years small. */
export function parseFng(json) {
  const rows = (json?.data ?? []).map(r => ({ day: Math.floor(Number(r.timestamp) / 86400), v: r.value === '' || r.value == null ? NaN : Number(r.value), label: String(r.value_classification ?? '') }))
    .filter(r => Number.isFinite(r.day) && r.v >= 0 && r.v <= 100).sort((a, b) => a.day - b.day)
  const last = rows.at(-1)
  if (!last) return null
  // By date, not by row: the source has skipped days, and "a week ago" must be a week ago.
  const by = new Map(rows.map(r => [r.day, r.v]))
  const back = (n) => by.get(last.day - n) ?? null
  return { value: last.v, label: last.label, date: last.day * DAY_MS, d1: back(1), d7: back(7), d30: back(30), days: rows.map(r => [r.day, r.v]) }
}

/** Alternative.me's own cut-offs, read from its full history: every labelled value falls inside these. */
export const FNG_ZONES = [['xfear', 0, 25], ['fear', 26, 46], ['neutral', 47, 54], ['greed', 55, 75], ['xgreed', 76, 100]]
export const fngZone = (v) => (FNG_ZONES.find(z => v <= z[2]) ?? FNG_ZONES[4])[0]
const fngSide = (v) => v <= 46 ? 'fear' : v >= 55 ? 'greed' : 'neutral'

/** What a window of the index says. `n` is days back from the latest reading; null means all of it. */
export function fngWindow(days, n = null) {
  if (!days?.length) return null
  const lastDay = days.at(-1)[0]
  const rows = n == null ? days : days.filter(r => r[0] > lastDay - n)
  let hi = rows[0], lo = rows[0], sum = 0, fear = 0, greed = 0
  for (const r of rows) {
    sum += r[1]
    if (r[1] > hi[1]) hi = r
    if (r[1] < lo[1]) lo = r
    const s = fngSide(r[1])
    if (s === 'fear') fear++; else if (s === 'greed') greed++
  }
  // How long the reading has been on this side, stopping at a skipped day rather than bridging it.
  const side = fngSide(days.at(-1)[1])
  let streak = 1
  for (let i = days.length - 2; i >= 0; i--) {
    if (days[i][0] !== days[i + 1][0] - 1 || fngSide(days[i][1]) !== side) break
    streak++
  }
  return { rows, avg: sum / rows.length, hi, lo, fearPct: fear / rows.length * 100, greedPct: greed / rows.length * 100, side, streak }
}

export function parseGlobal(json) {
  const d = json?.data
  const cap = Number(d?.total_market_cap?.usd), btc = Number(d?.market_cap_percentage?.btc)
  if (!(cap > 0) || !(btc > 0)) return null
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
  return { cap, vol: num(d.total_volume?.usd), btc, eth: num(d.market_cap_percentage?.eth), chg24: num(d.market_cap_change_percentage_24h_usd) }
}

/** The UTC instant of a New York wall-clock time, whichever side of daylight saving it falls on. */
export function easternToUtc(y, mo, d, h = 0, mi = 0) {
  const want = Date.UTC(y, mo - 1, d, h, mi)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  let t = want
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]))
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
  }
  return t
}

/** Each release this calendar lists: { t, summary }. Long lines fold onto the next with a leading space. */
export function parseIcs(text) {
  const body = String(text ?? '').replace(/\r?\n[ \t]/g, '')
  if (!body.includes('BEGIN:VCALENDAR')) return null
  const out = []
  for (const ev of body.split('BEGIN:VEVENT').slice(1)) {
    const summary = /^SUMMARY:(.*)$/m.exec(ev)?.[1]?.trim().replace(/\\,/g, ',')
    const m = /^DTSTART[^:\r\n]*:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}(Z?)/m.exec(ev)
    if (!summary || !m) continue
    const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
    out.push({ t: m[6] ? Date.UTC(y, mo - 1, d, h, mi) : easternToUtc(y, mo, d, h, mi), summary })
  }
  return out
}

const BLS_KIND = { 'Consumer Price Index': 'cpi', 'Employment Situation': 'jobs', 'Producer Price Index': 'ppi', 'Job Openings and Labor Turnover Survey': 'jolts' }
export function blsEvents(text) {
  const all = parseIcs(text)
  return all && all.flatMap(e => BLS_KIND[e.summary] ? [{ t: e.t, kind: BLS_KIND[e.summary] }] : [])
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad2 = (n) => String(n).padStart(2, '0')
/**
 * BEA titles name the period, in two styles: "GDP (Advance Estimate), 3rd Quarter 2026" and, through 2025,
 * "Gross Domestic Product, 1st Quarter 2025 (Advance Estimate)". The shutdown's Q3 2025 first estimate was
 * called "Initial", and it is the first estimate. A quarter's period is its first month.
 * "Personal Income and Outlays, October and November 2025" was one release for two months, so it is two rows.
 */
export function beaEvents(text) {
  const all = parseIcs(text)
  return all && all.flatMap((e) => {
    // not "Gross Domestic Product by County", nor "for Puerto Rico": neither carries an estimate stage
    const gdp = /^(?:GDP|Gross Domestic Product)\b[^(]*?\((Advance|Second|Third|Initial) Estimate/.exec(e.summary)
    if (gdp) {
      const q = /(\d)(?:st|nd|rd|th) Quarter(?: and Year)? (\d{4})/.exec(e.summary)
      const stage = gdp[1].toLowerCase() === 'initial' ? 'advance' : gdp[1].toLowerCase()
      return [{ t: e.t, kind: 'gdp', stage, ...(q ? { period: `${q[2]}-${pad2((+q[1] - 1) * 3 + 1)}` } : {}) }]
    }
    const pce = /^Personal Income and Outlays,\s*(.+)$/.exec(e.summary)
    if (!pce) return []
    const y = /(\d{4})\s*$/.exec(pce[1].trim())?.[1]
    const months = MONTH_NAMES.flatMap((m, i) => new RegExp(`\\b${m}\\b`).test(pce[1]) ? [i + 1] : [])
    if (!y || !months.length) return [{ t: e.t, kind: 'pce' }]
    return months.map(m => ({ t: e.t, kind: 'pce', period: `${y}-${pad2(m)}` }))
  })
}

/**
 * One BLS archive page: { t, kind, period } for each release, newest month first on the page. Commented-out
 * placeholders for releases not yet out are dropped before reading. The first link in an entry is named with
 * its release date (cpi_10142026.htm); a date that is not after its month, or is months late, is a link to
 * something else and is skipped. BLS releases at 8:30 New York time, JOLTS at 10:00.
 */
export function parseBlsArchive(html, kind) {
  const s = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const out = new Map()
  for (const li of s.split(/<li[\s>]/i).slice(1)) {
    const body = li.split(/<\/li>/i)[0]
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
    const p = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/.exec(text)
    const f = /_(\d{2})(\d{2})(\d{4})\.(?:htm|txt|pdf)/i.exec(body)
    if (!p || !f) continue
    const mo = MONTH_NAMES.indexOf(p[1]) + 1, y = +p[2]
    const t = easternToUtc(+f[3], +f[1], +f[2], kind === 'jolts' ? 10 : 8, kind === 'jolts' ? 0 : 30)
    const end = Date.UTC(y, mo, 1)
    if (!(t > end) || t > end + 160 * DAY_MS) continue
    const period = `${y}-${pad2(mo)}`
    if (!out.has(period)) out.set(period, { t, kind, period })
  }
  return out.size ? [...out.values()].sort((a, b) => a.t - b.t) : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/**
 * Rate decisions from the Fed's calendar page. The page gives no time; statements come at 2pm New York.
 * An asterisk means the meeting comes with projections. Notation votes are not scheduled meetings.
 * Nothing recognisable is null, so a redesign of that page reads as "unknown", not "no meetings".
 */
export function parseFomc(html) {
  const s = String(html ?? '')
  const years = [...s.matchAll(/(\d{4}) FOMC Meetings/g)].map(m => ({ y: +m[1], at: m.index }))
  const out = []
  years.forEach(({ y, at }, i) => {
    const part = s.slice(at, years[i + 1]?.at ?? s.length)
    for (const m of part.matchAll(/fomc-meeting__month[^>]*>(?:\s*<strong>)?\s*([A-Za-z/]+)[\s\S]*?fomc-meeting__date[^>]*>\s*([^<]+?)\s*</g)) {
      const d = /^(\d{1,2})(?:-(\d{1,2}))?(\*?)$/.exec(m[2])
      if (!d) continue
      const names = m[1].toLowerCase().split('/')
      const mo = MONTHS.indexOf(names.at(-1).slice(0, 3)) + 1
      if (!mo) continue
      out.push({ t: easternToUtc(y, mo, +(d[2] ?? d[1]), 14, 0), kind: 'fomc', projections: d[3] === '*' })
    }
  })
  return out.length ? out : null
}

/**
 * Releases that have already happened, oldest first, for "Past reports". Each carries Bitcoin's move across
 * its UTC day when the price history reaches that far, and no `btc` at all when it does not: a missing move
 * is unknown, not flat. A calendar that failed contributes nothing, and the page says dates may be missing.
 */
export function pastEvents(ev, rel, btc, now = Date.now()) {
  // BLS reports come from their archives, which say which month each release covered; the BLS calendar does
  // not, and guessing from timing went wrong after the 2025 shutdown, when one release covered two months.
  const lists = [ev?.bea, ev?.fomc, ...Object.values(rel ?? {})].filter(Boolean)
  if (!lists.length) return null
  const px = new Map(btc ?? [])
  const from = now - 6.2 * 365 * DAY_MS
  return lists.flat().filter(e => e && e.t < now && e.t >= from).sort((a, b) => a.t - b.t).map((e) => {
    const day = Math.floor(e.t / DAY_MS), a = px.get(day), b = px.get(day + 1)
    const out = { t: e.t, kind: e.kind }
    if (e.stage) out.stage = e.stage
    if (e.period) out.period = e.period
    if (e.projections) out.projections = true
    if (a && b) out.btc = +((b / a - 1) * 100).toFixed(2)
    return out
  })
}

function mergeEvents(ev, now) {
  const lists = Object.values(ev ?? {}).filter(Boolean)
  if (!lists.length) return null
  return lists.flat().filter(e => e.t >= now - 6 * 3600e3).sort((a, b) => a.t - b.t).slice(0, 40)
}

// The index is published once a day and its whole history is 300 KB, so it is not asked for often.
const TTL = { series: 30 * 60e3, fng: 3 * 3600e3, global: 10 * 60e3, cal: 6 * 3600e3, nowcast: 3 * 3600e3, btc: 6 * 3600e3, rel: 12 * 3600e3 }

/**
 * One refresh: only what is due, and a failed read keeps the last good one, so an outage shows a stale
 * figure with its own date rather than a hole. `getText(url)` resolves to the body or rejects.
 */
export async function refreshMacro(prev, getText, now = Date.now()) {
  const raw = { series: { ...(prev?.series ?? {}) }, fng: prev?.fng ?? null, global: prev?.global ?? null, nowcast: prev?.nowcast ?? null, btc: prev?.btc ?? null,
    events: { bls: null, bea: null, fomc: null, ...(prev?.events ?? {}) }, rel: { ...(prev?.rel ?? {}) }, srcAt: { ...(prev?.srcAt ?? {}) } }
  const due = (k) => now - (raw.srcAt[k] ?? 0) >= TTL[k.split(':')[0]]
  const read = (url) => getText(url).catch(() => null)

  const ids = Object.keys(MACRO_SERIES).filter(id => due('series:' + id))
  for (let i = 0; i < ids.length; i += 4) {     // a few at a time: this is somebody's free public service
    await Promise.all(ids.slice(i, i + 4).map(async (id) => {
      const rows = parseFredCsv(await read(fredUrl(id, now)))
      if (rows) { raw.series[id] = rows; raw.srcAt['series:' + id] = now }
    }))
  }
  const json = (t) => { try { return JSON.parse(t) } catch { return null } }
  await Promise.all([
    // A file saved before the full history existed has no `days`, and three hours is too long to show nothing.
    (due('fng') || !raw.fng?.days) && read(FNG_URL).then((t) => { const v = parseFng(json(t)); if (v) { raw.fng = v; raw.srcAt.fng = now } }),
    due('global') && read(CG_GLOBAL_URL).then((t) => { const v = parseGlobal(json(t)); if (v) { raw.global = v; raw.srcAt.global = now } }),
    // The Cleveland files are about 7 MB each; only the few numbers used here are kept.
    due('nowcast') && Promise.all([read(NOWCAST_MONTH_URL), read(NOWCAST_YEAR_URL)]).then(([m, y]) => { const v = parseNowcast(json(m), json(y)); if (v) { raw.nowcast = v; raw.srcAt.nowcast = now } }),
    due('btc') && read(BTC_CHART_URL).then((t) => { const v = parseBtcChart(json(t)); if (v) { raw.btc = v; raw.srcAt.btc = now } }),
    due('cal:bls') && read(BLS_ICS_URL).then((t) => { const v = blsEvents(t); if (v?.length) { raw.events.bls = v; raw.srcAt['cal:bls'] = now } }),
    due('cal:bea') && read(BEA_ICS_URL).then((t) => { const v = beaEvents(t); if (v?.length) { raw.events.bea = v; raw.srcAt['cal:bea'] = now } }),
    ...Object.entries(BLS_ARCHIVE).map(([k, url]) => due('rel:' + k) && read(url).then((t) => { const v = parseBlsArchive(t, k); if (v?.length) { raw.rel[k] = v; raw.srcAt['rel:' + k] = now } })),
    due('cal:fomc') && read(FOMC_URL).then((t) => { const v = parseFomc(t); if (v) { raw.events.fomc = v; raw.srcAt['cal:fomc'] = now } }),
  ])
  raw.at = now
  return raw
}

export const macroHasData = (raw) => !!raw && (Object.keys(raw.series ?? {}).length > 0 || !!raw.fng || !!raw.global)
