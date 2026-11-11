// "Past reports" in Signals → Macro (src/macropast.js), and the release dates it is built on (src/macro.js).
// No network: the archive page and calendar here are trimmed copies of the real formats.
import { parseBlsArchive, beaEvents, pastEvents, buildMacro } from '../../src/macro.js'
import { pastRows, yearSummary, pastCardHtml } from '../../src/macropast.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? pass++ : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const iso = (ms) => new Date(ms).toISOString().slice(0, 16)

// ── the BLS archive page ──
// Both of its formats, a commented-out placeholder for releases not yet out, and an entry whose PDF's
// aria-label names the wrong month (the page really does this).
const page = `<h4 id="2026">2026 Employment Situation</h4>
<ul><!--  <li><a href="/news.release/archives/empsit_12042026.htm">November 2026 Employment Situation</a></li> -->
<li><a href="/news.release/archives/empsit_11062026.htm">October 2026 Employment Situation</a> (<a aria-label="September 2026 Employment Situation PDF" href="/news.release/archives/empsit_11062026.pdf">PDF</a>)</li>
<li><a href="/news.release/archives/empsit_10022026.htm">September 2026 Employment Situation</a> (<a href="/x.pdf">PDF</a>)</li>
<li><a href="/news.release/archives/empsit_12162025.htm">November 2025 Employment Situation</a></li>
<li><a href="/news.release/archives/empsit_11202025.htm">September 2025 Employment Situation</a></li>
<li><a href="/bls/history/home.htm">History</a></li>
<li>December 2007 Employment Situation (<a aria-label="December 2007 Employment Situation TXT" href="/news.release/history/empsit_01042008.txt">TXT</a>)</li>`
const jobs = parseBlsArchive(page, 'jobs')
const by = Object.fromEntries((jobs ?? []).map(e => [e.period, e]))
t('a placeholder in a comment is not a release', !by['2026-11'], Object.keys(by))
t('the month comes from the entry, not a mislabelled PDF', iso(by['2026-10']?.t) === '2026-11-06T13:30', by['2026-10'])
t('8:30 New York, through daylight saving', iso(by['2026-09']?.t) === '2026-10-02T12:30', by['2026-09'])
t('a shutdown-delayed release keeps its own month', iso(by['2025-09']?.t) === '2025-11-20T13:30', by['2025-09'])
t('the old text format', iso(by['2007-12']?.t) === '2008-01-04T13:30', by['2007-12'])
t('links that are not releases are skipped', jobs.length === 5, jobs)
t('oldest first', jobs[0].period === '2007-12' && jobs.at(-1).period === '2026-10', jobs.map(e => e.period))
t('JOLTS comes out at 10:00', iso(parseBlsArchive('<li><a href="/a/jolts_11032026.htm">September 2026</a></li>', 'jolts')[0].t) === '2026-11-03T15:00')
t('not an archive page is null', parseBlsArchive('<html>busy</html>', 'cpi') === null)

// ── BEA names its periods, in two styles ──
const ics = (rows) => 'BEGIN:VCALENDAR\n' + rows.map(([s, d]) => `BEGIN:VEVENT\nSUMMARY:${s}\nDTSTART:${d}\nEND:VEVENT\n`).join('') + 'END:VCALENDAR'
const bea = beaEvents(ics([
  ['Gross Domestic Product\\, 4th Quarter and Year 2024 (Advance Estimate)', '20250130T133000Z'],
  ['Gross Domestic Product\\, 3rd Quarter 2025 (Initial Estimate) and Corporate Profits (Preliminary)', '20251223T133000Z'],
  ['GDP (Advance Estimate)\\, 3rd Quarter 2026', '20261029T123000Z'],
  ['Gross Domestic Product for Puerto Rico\\, 2023', '20250301T133000Z'],
  ['Personal Income and Outlays\\, October and November 2025', '20260122T150000Z'],
  ['Personal Income and Outlays\\, July 2026 ', '20260826T123000Z'],
]))
t('the older GDP title', bea[0].kind === 'gdp' && bea[0].stage === 'advance' && bea[0].period === '2024-10', bea[0])
t('"Initial" is the first estimate', bea[1].stage === 'advance' && bea[1].period === '2025-07', bea[1])
t('the newer GDP title', bea[2].period === '2026-07' && bea[2].stage === 'advance', bea[2])
t('Puerto Rico is not US GDP', !bea.some(e => e.t === Date.UTC(2025, 2, 1, 13, 30)))
const pce = bea.filter(e => e.kind === 'pce')
t('one release for two months is two rows', pce.map(e => e.period).join() === '2025-10,2025-11,2026-07', pce)

// ── what the server sends ──
const D = 864e5, NOW = Date.UTC(2026, 10, 11)
const dayOf = (ms) => Math.floor(ms / D)
const relJobs = parseBlsArchive(page, 'jobs')
const btc = [[dayOf(Date.UTC(2026, 10, 6)), 100], [dayOf(Date.UTC(2026, 10, 7)), 98]]
const past = pastEvents({ bls: [{ t: Date.UTC(2026, 9, 2), kind: 'jobs' }], bea, fomc: [{ t: Date.UTC(2026, 9, 28, 18), kind: 'fomc', projections: false }, { t: NOW + 30 * D, kind: 'fomc' }] }, { jobs: relJobs }, btc, NOW)
t('nothing still to come', past.every(e => e.t < NOW), past.filter(e => e.t >= NOW))
t('nothing older than about six years', !past.some(e => e.period === '2007-12'))
t('BLS dates come from the archive, which names the month', past.filter(e => e.kind === 'jobs').every(e => e.period), past.filter(e => e.kind === 'jobs'))
t('Bitcoin\'s move where the price history reaches', past.find(e => e.period === '2026-10')?.btc === -2, past.find(e => e.period === '2026-10'))
t('and no move, rather than a flat one, where it does not', !('btc' in past.find(e => e.period === '2026-09')))
t('no calendars at all is unknown', pastEvents({ bls: null, bea: null, fomc: null }, {}, null, NOW) === null)
t('buildMacro carries it', Array.isArray(buildMacro({ series: {}, events: { bea }, rel: { jobs: relJobs } }, NOW).past))

// ── the rows ──
const STAMP = (d) => Date.parse(d + 'T12:00:00Z')
const months = (from, n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2020 + Math.floor((from + i) / 12), (from + i) % 12, 1)); return [STAMP(d.toISOString().slice(0, 10)), f(i)] })
// CPI from Jan 2021 to Sep 2026 with October 2025 missing, as FRED has it.
const cpiPts = months(12, 69, i => 2 + i / 100).filter(p => new Date(p[0]).toISOString().slice(0, 7) !== '2025-10')
const d = {
  items: [
    { key: 'cpi', pts: cpiPts },
    { key: 'core', pts: cpiPts.map(([a, v]) => [a, v + 1]) },
    { key: 'payrolls', pts: [[STAMP('2026-09-01'), 60], [STAMP('2026-10-01'), 165]] },
    { key: 'unrate', pts: [[STAMP('2026-09-01'), 4.2], [STAMP('2026-10-01'), 4.1]] },
    { key: 'fed', pts: [[STAMP('2020-01-02'), 1.75], [STAMP('2025-09-18'), 4.25], [STAMP('2025-10-30'), 4.0], [STAMP('2025-12-11'), 3.75], [STAMP('2026-09-17'), 4.0], [STAMP('2026-11-10'), 4.0]] },
  ],
  past: [
    { t: Date.UTC(2026, 9, 14, 12, 30), kind: 'cpi', period: '2026-09', btc: -1.82 },
    { t: Date.UTC(2025, 9, 24, 12, 30), kind: 'cpi', period: '2025-09' },
    ...past,
    { t: Date.UTC(2025, 9, 29, 18), kind: 'fomc' }, { t: Date.UTC(2025, 11, 10, 19), kind: 'fomc', projections: true },
    { t: Date.UTC(2026, 0, 28, 19), kind: 'fomc' }, { t: Date.UTC(2026, 8, 16, 18), kind: 'fomc', btc: 0.74 },
  ],
}
const y1 = pastRows(d, 'cpi', null, NOW)
t('a year is twelve months, newest first', y1.length === 12 && y1[0].at === STAMP('2026-09-01'), y1.map(r => iso(r.at)))
t('dated by the month it names', iso(y1[0].rel) === '2026-10-14T12:30' && y1[0].btc === -1.82, y1[0])
const gap = y1.find(r => r.gap)
t('the unpublished month is a row that says so', gap && iso(gap.at).startsWith('2025-10'), y1.map(r => r.gap))
t('the month after it has no change', y1.find(r => iso(r.at).startsWith('2025-11')).chg === null)
t('a normal month does', Math.abs(y1[0].chg - 0.01) < 1e-9, y1[0].chg)
t('the core figure beside it', Math.abs(y1[0].v2 - (y1[0].v + 1)) < 1e-9)
t('a month with no release on file has no date, not a guessed one', !('rel' in y1[1]), y1[1])
const y5 = pastRows(d, 'cpi', 5, NOW)
t('five years starts in January five years back', new Set(y5.map(r => r.year)).size === 6 && Math.min(...y5.map(r => r.year)) === 2021, [...new Set(y5.map(r => r.year))])
const T = (en) => en
t('a year sums up', /^avg [\d.]+% · ended [\d.]+%$/.test(yearSummary('cpi', y5.filter(r => r.year === 2025), T)), yearSummary('cpi', y5.filter(r => r.year === 2025), T))
const j = pastRows(d, 'jobs', null, NOW)
t('jobs dated from the archive', iso(j[0].rel) === '2026-11-06T13:30' && j[0].btc === -2 && j[0].v2 === 4.1, j[0])

const fed = pastRows(d, 'fomc', null, NOW)
t('every past meeting in the year, newest first, whatever order they came in', fed.length === 4 && fed.every((r, i) => i === 0 || r.at < fed[i - 1].at), fed.map(r => iso(r.at)))
const fx = Object.fromEntries(fed.map(r => [iso(r.at).slice(0, 10), r]))
t('a cut', fx['2025-12-10'].chg === -0.25 && fx['2025-12-10'].v === 3.75, fx['2025-12-10'])
t('a meeting more than a year ago is not in the year', !fx['2025-10-29'])
t('a hold', fx['2026-01-28'].chg === 0, fx['2026-01-28'])
t('a hike, read the day after the statement', fx['2026-09-16'].chg === 0.25 && fx['2026-09-16'].btc === 0.74, fx['2026-09-16'])
t('projections are noted', fx['2025-12-10'].projections === true)
const fy = pastRows(d, 'fomc', 5, NOW)
t('a Fed year', yearSummary('fomc', fy.filter(r => r.year === 2025), T) === '2 cuts · −0.50 pt · ended 3.50–3.75%', yearSummary('fomc', fy.filter(r => r.year === 2025), T))
t('jobs in a year', /^\+225K jobs · unemployment ended 4\.1%$/.test(yearSummary('jobs', pastRows(d, 'jobs', 5, NOW), T)), yearSummary('jobs', pastRows(d, 'jobs', 5, NOW), T))

// ── the card ──
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const html = pastCardHtml(d, { T, esc: String }, NOW)
t('a chip for each report', ['cpi', 'pce', 'ppi', 'jobs', 'jolts', 'gdp', 'fomc'].every(k => html.includes(`data-past-kind="${k}"`)))
t('and both ranges', html.includes('data-past-range="1y"') && html.includes('data-past-range="5y"'))
t('the unpublished month reads "No figure"', html.includes('No figure'))
t('nothing for a report is said, not left blank', /No past figures/.test(pastCardHtml({ items: [] }, { T, esc: String }, NOW)))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
