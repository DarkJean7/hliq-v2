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
export const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
export const MACRO_UA = 'InsolventTerminal/1.0 (+https://insolvent.trade)'

const LONG = 7 * 365 * 864e5    // reports: six years to show, plus the year a year-on-year needs behind it
const SHORT = 400 * 864e5       // daily markets: a year is plenty, and 8 × 6 years of days is a big answer
export const MACRO_SERIES = {
  CPIAUCNS: LONG, CPIAUCSL: LONG, CPILFENS: LONG, CPILFESL: LONG, PCEPI: LONG, PCEPILFE: LONG, PPIFIS: LONG,
  UNRATE: LONG, PAYEMS: LONG, ICSA: SHORT, A191RL1Q225SBEA: LONG, UMCSENT: LONG,
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
  const momOf = (id) => { const m = mom(s[id]).at(-1); return m ? { mom: m[1], momDate: m[0] } : null }
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
    unknownCal: Object.entries(raw?.events ?? { bls: null, bea: null, fomc: null }).filter(([, v]) => !v).map(([k]) => k),
  }
}

const DAY_MS = 864e5
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
export function beaEvents(text) {
  const all = parseIcs(text)
  return all && all.flatMap((e) => {
    const gdp = /^GDP \((Advance|Second|Third)/.exec(e.summary)      // not "Gross Domestic Product by County"
    if (gdp) return [{ t: e.t, kind: 'gdp', stage: gdp[1].toLowerCase() }]
    return /^Personal Income and Outlays/.test(e.summary) ? [{ t: e.t, kind: 'pce' }] : []
  })
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

function mergeEvents(ev, now) {
  const lists = Object.values(ev ?? {}).filter(Boolean)
  if (!lists.length) return null
  return lists.flat().filter(e => e.t >= now - 6 * 3600e3).sort((a, b) => a.t - b.t).slice(0, 40)
}

// The index is published once a day and its whole history is 300 KB, so it is not asked for often.
const TTL = { series: 30 * 60e3, fng: 3 * 3600e3, global: 10 * 60e3, cal: 6 * 3600e3 }

/**
 * One refresh: only what is due, and a failed read keeps the last good one, so an outage shows a stale
 * figure with its own date rather than a hole. `getText(url)` resolves to the body or rejects.
 */
export async function refreshMacro(prev, getText, now = Date.now()) {
  const raw = { series: { ...(prev?.series ?? {}) }, fng: prev?.fng ?? null, global: prev?.global ?? null,
    events: { bls: null, bea: null, fomc: null, ...(prev?.events ?? {}) }, srcAt: { ...(prev?.srcAt ?? {}) } }
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
    due('cal:bls') && read(BLS_ICS_URL).then((t) => { const v = blsEvents(t); if (v?.length) { raw.events.bls = v; raw.srcAt['cal:bls'] = now } }),
    due('cal:bea') && read(BEA_ICS_URL).then((t) => { const v = beaEvents(t); if (v?.length) { raw.events.bea = v; raw.srcAt['cal:bea'] = now } }),
    due('cal:fomc') && read(FOMC_URL).then((t) => { const v = parseFomc(t); if (v) { raw.events.fomc = v; raw.srcAt['cal:fomc'] = now } }),
  ])
  raw.at = now
  return raw
}

export const macroHasData = (raw) => !!raw && (Object.keys(raw.series ?? {}).length > 0 || !!raw.fng || !!raw.global)
