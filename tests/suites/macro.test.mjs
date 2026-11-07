// src/macro.js: dates, gaps and failures. No network; every fetch here is a stub.
import { parseFredCsv, yoy, mom, monthDiff, buildMacro, parseNowcast, parseBtcChart, btcReactions, MACRO_SERIES, parseFng, parseGlobal, fngWindow, fngZone, parseIcs, blsEvents, beaEvents, parseFomc, easternToUtc, refreshMacro, fredUrl, macroHasData } from '../../src/macro.js'
import { fmtMacro, fmtDelta, periodLabel, nextOf } from '../../src/macroview.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? pass++ : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// ── the CSV ──
const csv = 'observation_date,CPIAUCNS\r\n2024-09-01,100\r\n2024-10-01,101\r\n2024-11-01,102\r\n2025-09-01,110\r\n2025-10-01,\r\n2025-11-01,.\r\n2025-12-01,120\r\n'
const rows = parseFredCsv(csv)
t('reads rows', rows.length === 7, rows)
t('a blank month is null, not 0', rows[4][1] === null, rows[4])
t('a "." month is null, not 0', rows[5][1] === null, rows[5])
t('an error page is not data', parseFredCsv('<html>busy</html>') === null)
t('a file with no values is not data', parseFredCsv('observation_date,X\n2025-01-01,\n') === null)

// ── a gap must not shift the comparison ──
const series = []
for (let y = 2024; y <= 2025; y++) for (let m = 1; m <= 12; m++) series.push([`${y}-${String(m).padStart(2, '0')}-01`, 100 + (y - 2024) * 12 + m])
series[21][1] = null // 2025-10 never published
const y = yoy(series)
t('the missing month has no year-on-year', !y.some(r => r[0] === '2025-10-01'))
const dec = y.find(r => r[0] === '2025-12-01')
// 2025-12 is 124, 2024-12 is 112. Stepping back 12 known rows would land on 2024-11 (111).
t('December compares with December across the gap', Math.abs(dec[1] - (124 / 112 - 1) * 100) < 1e-9, dec)
const gapRows = [['2025-09-01', 100], ['2025-10-01', null], ['2025-11-01', 110], ['2025-12-01', 121]]
t('no month-on-month across a gap', mom(gapRows).map(r => r[0]).join() === '2025-12-01', mom(gapRows))
t('the same for jobs added', monthDiff(gapRows).map(r => r[1]).join() === '11', monthDiff(gapRows))
t('January looks back to December', mom([['2025-12-01', 100], ['2026-01-01', 101]])[0][0] === '2026-01-01')

// ── unknown stays unknown ──
const empty = buildMacro({ series: {} }, 0)
t('a series never read has value null', empty.items.every(i => i.value === null), empty.items.filter(i => i.value !== null))
t('no calendar is null, not "nothing scheduled"', empty.events === null)
t('and it says which are unknown', empty.unknownCal.join() === 'bls,bea,fomc', empty.unknownCal)
t('no sentiment is null', empty.fng === null && empty.global === null)
t('macroHasData is false for nothing', macroHasData({ series: {} }) === false && macroHasData(null) === false)

// ── the Fed row ──
const fed = buildMacro({ series: {
  DFEDTARU: [['2025-12-10', 4.25], ['2025-12-11', 4.0], ['2026-11-05', 4.0], ['2026-11-06', 4.0]],
  DFEDTARL: [['2025-12-11', 3.75], ['2026-11-06', 3.75]],
} }, 0).items.find(i => i.key === 'fed')
t('range', fed.low === 3.75 && fed.value === 4, fed)
t('dated by its last change, not today', fed.date === '2025-12-11', fed.date)
t('and the rate before that', fed.prev === 4.25, fed.prev)

// ── sentiment ──
const DAYS = 86400, D0 = 20000
const row = (d, v, l = 'Fear') => ({ value: String(v), value_classification: l, timestamp: String((D0 + d) * DAYS) })
const fng = parseFng({ data: [row(30, 25, 'Extreme Fear'), row(29, 28), row(0, 60, 'Greed'), { value: 'x', timestamp: '100' }, { value: '', timestamp: '200' }] })
t('newest wins whatever order it arrives in', fng.value === 25 && fng.label === 'Extreme Fear', fng)
t('yesterday', fng.d1 === 28, fng)
t('a week ago with no reading is null', fng.d7 === null, fng)
t('a month ago is found by date', fng.d30 === 60, fng)
t('history runs oldest first, as day numbers', fng.days[0][0] === D0 && fng.days.length === 3, fng.days)
t('a skipped day is not counted as "a week ago"', parseFng({ data: [row(7, 50), row(1, 40), row(0, 30)] }).d7 === 30)
t('a blank value is not a reading of 0', !parseFng({ data: [row(0, 50), { value: '', timestamp: String((D0 + 1) * DAYS) }] }).days.some(r => r[1] === 0))
t('the zone cut-offs match its labels', [[25, 'xfear'], [26, 'fear'], [46, 'fear'], [47, 'neutral'], [54, 'neutral'], [55, 'greed'], [75, 'greed'], [76, 'xgreed']].every(([v, z]) => fngZone(v) === z))
const hist = [[1, 80], [2, 70], [3, 40], [4, 20], [6, 30], [7, 45]]
const all = fngWindow(hist)
t('average over the window', Math.abs(all.avg - 285 / 6) < 1e-9, all.avg)
t('high and low with their days', all.hi[0] === 1 && all.lo[0] === 4, all)
t('share of days on each side', Math.abs(all.fearPct - 400 / 6) < 1e-9 && Math.abs(all.greedPct - 200 / 6) < 1e-9, all)
t('a streak stops at a skipped day', all.streak === 2 && all.side === 'fear', all)
const win = fngWindow(hist, 3)
t('a window counts back from the latest reading', win.rows.length === 2 && win.rows[0][0] === 6, win.rows)
t('no history is null', fngWindow([]) === null && fngWindow(null) === null)
t('nothing usable is null', parseFng({ data: [] }) === null && parseFng(null) === null)
t('no market cap is null', parseGlobal({ data: { total_market_cap: {} } }) === null)
t('global', parseGlobal({ data: { total_market_cap: { usd: 5 }, market_cap_percentage: { btc: 59 } } }).eth === null)

// ── times ──
t('8:30am New York in November is 13:30Z', easternToUtc(2026, 11, 10, 8, 30) === Date.UTC(2026, 10, 10, 13, 30))
t('8:30am New York in July is 12:30Z', easternToUtc(2026, 7, 15, 8, 30) === Date.UTC(2026, 6, 15, 12, 30))
const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20261110T083000\r\nSUMMARY:Consumer Price\r\n  Index\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20261111T100000\r\nSUMMARY:Real Earnings\r\nEND:VEVENT\r\nEND:VCALENDAR'
t('a folded line is one line', parseIcs(ics)[0].summary === 'Consumer Price Index', parseIcs(ics))
t('only the reports markets watch', blsEvents(ics).map(e => e.kind).join() === 'cpi', blsEvents(ics))
t('in UTC', blsEvents(ics)[0].t === Date.UTC(2026, 10, 10, 13, 30))
t('not a calendar is null', blsEvents('<html>') === null)
const bea = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:GDP (Second Estimate) and Corporate Profits\\, 3rd Quarter 2026\nDTSTART:20261125T133000Z\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Gross Domestic Product by County\nDTSTART:20261126T133000Z\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Personal Income and Outlays\\, October 2026\nDTSTART:20261126T150000Z\nEND:VEVENT\nEND:VCALENDAR'
const be = beaEvents(bea)
t('GDP and PCE, not county GDP', be.map(e => e.kind).join() === 'gdp,pce', be)
t('the estimate is kept', be[0].stage === 'second', be[0])

// ── the Fed's page ──
const M = (mon, d, shaded = '') => `<div class="${shaded} fomc-meeting__month col-xs-5"><strong>${mon}</strong></div>\n\n<div class="fomc-meeting__date col-xs-4">${d}</div>`
const html = `<h4><a id="1">2026 FOMC Meetings</a></h4>${M('October', '27-28')}${M('December', '8-9*', 'fomc-meeting--shaded')}<h4><a id="2">2025 FOMC Meetings</a></h4>${M('Apr/May', '30-1')}${M('August', '22 (notation vote)')}`
const fo = parseFomc(html)
t('every scheduled meeting, not notation votes', fo.length === 3, fo)
t('dated at 2pm New York on its last day', fo[0].t === Date.UTC(2026, 9, 28, 18, 0), fo[0])
t('winter time too', fo[1].t === Date.UTC(2026, 11, 9, 19, 0), fo[1])
t('the asterisk means projections', fo[1].projections === true && fo[0].projections === false)
t('a meeting across months ends in the second', new Date(fo[2].t).getUTCMonth() === 4, fo[2])
t('a redesigned page is unknown, not "no meetings"', parseFomc('<html>new site</html>') === null)

// ── upcoming list ──
const ev = buildMacro({ series: {}, events: { bls: [{ t: 500, kind: 'cpi' }, { t: 100, kind: 'jobs' }], bea: null, fomc: [{ t: 300, kind: 'fomc' }] } }, 0)
t('merged by time', ev.events.map(e => e.kind).join() === 'jobs,fomc,cpi', ev.events)
t('one missing calendar is named', ev.unknownCal.join() === 'bea', ev.unknownCal)
t('nextOf finds the next of its kind', nextOf(ev.events, 'cpi', 200).t === 500 && nextOf(ev.events, 'jobs', 200) === null)

// ── a refresh ──
const NOW = Date.UTC(2026, 10, 7)
const okCsv = (id) => `observation_date,${id}\n2026-01-01,5\n`
let calls = []
const ok = async (u) => { calls.push(u); if (u.includes('fredgraph')) return okCsv(u); if (u.includes('alternative.me')) return JSON.stringify({ data: [{ value: '50', value_classification: 'Neutral', timestamp: '9' }] }); if (u.includes('coingecko')) return JSON.stringify({ data: { total_market_cap: { usd: 9 }, market_cap_percentage: { btc: 50 } } }); throw new Error('no') }
const first = await refreshMacro(null, ok, NOW)
t('everything is read the first time', calls.filter(u => u.includes('fredgraph')).length === Object.keys(MACRO_SERIES).length, calls.length)
t('reads the window it asked for', fredUrl('DGS10', NOW).includes('cosd=2025-'), fredUrl('DGS10', NOW))
t('a calendar that failed stays unknown', first.events.bls === null)
calls = []
await refreshMacro(first, ok, NOW + 60e3)
t('a minute later nothing good is read again', !calls.some(u => /fredgraph|alternative\.me|api\/v3\/global/.test(u)), calls)   // only what failed and never succeeded
calls = []
const later = await refreshMacro(first, ok, NOW + 11 * 60e3)
t('market cap refreshes sooner than reports', calls.some(u => u.includes('coingecko')) && !calls.some(u => u.includes('fredgraph')), calls)
calls = []
await refreshMacro({ ...first, fng: { value: 5, pts: [] } }, ok, NOW + 60e3)
t('a file from before the full history reads it straight away', calls.some(u => u.includes('alternative.me')), calls)
calls = []
await refreshMacro(first, ok, NOW + 40 * 60e3)
t('the index is not asked for every half hour', !calls.some(u => u.includes('alternative.me')), calls)
const down = await refreshMacro(first, async () => { throw new Error('down') }, NOW + 4 * 3600e3)
t('an outage keeps the last good data', down.series.UNRATE?.length === 1 && down.fng?.value === 50 && down.global?.cap === 9, down.fng)
t('and tries again next time', down.srcAt['series:UNRATE'] === NOW, down.srcAt['series:UNRATE'])
t('later is fine', later.at === NOW + 11 * 60e3)

// ── the Cleveland Fed's estimates ──
const nc = (period, stamp, vals, actuals = {}) => ({ chart: { subcaption: period, _comment: stamp }, dataset: [
  ...Object.entries({ 'CPI Inflation': vals.cpi, 'Core CPI Inflation': vals.core }).map(([seriesname, data]) => ({ seriesname, data: (data ?? []).map(value => ({ value: value === null ? '' : String(value) })) })),
  ...Object.entries({ 'Actual CPI Inflation': actuals.cpi }).map(([seriesname, data]) => ({ seriesname, data: (data ?? []).map(value => ({ value: value === null ? '' : String(value) })) })),
] })
const ncM = [
  nc('2026-9', '2026-10-14 00:00', { cpi: [0.3, 0.5, null], core: [0.2, 0.2, 0.2] }, { cpi: [null, null, 0.65] }),
  nc('2026-10', '2026-11-06 00:00', { cpi: [0.2, 0.24], core: [0.21] }, { cpi: [null, null] }),
  nc('2026-11', '2026-11-06 00:00', { cpi: [0.18], core: [0.2] }, { cpi: [null] }),
]
const ncY = [nc('2026-10', '2026-11-06 00:00', { cpi: [3.7, 3.74], core: [2.48] }, { cpi: [null, null] })]
const nowcast = parseNowcast(ncM, ncY)
t('the estimate is the latest one for that month', nowcast.periods['2026-10'].m.cpi === 0.24 && nowcast.periods['2026-10'].y.cpi === 3.74, nowcast.periods)
t('months are zero-padded, as the data dates are', !!nowcast.periods['2026-10'] && !nowcast.periods['2026-9']?.m.cpi, Object.keys(nowcast.periods))
t('a month already reported has no estimate', nowcast.periods['2026-9']?.m.cpi === undefined)
t('the miss is against the last estimate before the number', Math.abs(nowcast.miss.m.cpi.avg - 0.15) < 1e-9 && nowcast.miss.m.cpi.n === 1, nowcast.miss.m)
t('the date it was made', nowcast.asOf === Date.UTC(2026, 10, 6), nowcast.asOf)
t('a file that cannot be read is no estimate at all', parseNowcast(null, null) === null && parseNowcast([], []) === null)
t('one file missing still gives the other', parseNowcast(ncM, null).periods['2026-10'].m.cpi === 0.24)

// ── what Bitcoin did on report days ──
const D0B = 20000
const btcPts = Array.from({ length: 12 }, (_, i) => [(D0B + i) * 864e5, 100 + i * 0])
btcPts[5][1] = 100; btcPts[6][1] = 110      // day 5 to day 6: +10%
btcPts[7][1] = 99                           // day 6 to day 7: -10%
btcPts.push([(D0B + 11) * 864e5 + 5000, 500]) // "now": the same day as the last midnight, and must not replace it
const btc = parseBtcChart({ prices: btcPts })
t('one price a day, the first of it', btc.length === 12 && btc.at(-1)[1] === 100, btc.at(-1))
t('no prices is null', parseBtcChart({ prices: [] }) === null && parseBtcChart(null) === null)
const reNow = (D0B + 12) * 864e5
const re = btcReactions({ bls: [{ t: (D0B + 5) * 864e5 + 3600e3, kind: 'cpi' }, { t: (D0B + 6) * 864e5 + 3600e3, kind: 'cpi' }, { t: reNow + 864e5, kind: 'cpi' }, { t: (D0B + 5) * 864e5, kind: 'jobs' }] }, btc, reNow)
t('its move across that UTC day', re.cpi.recent.find(r => r[0] === D0B + 5)[1] === 10, re.cpi.recent)
t('average size, either direction', Math.abs(re.cpi.avgAbs - 10) < 1e-9, re.cpi)
t('days it rose', re.cpi.up === 1 && re.cpi.n === 2, re.cpi)
t('a report still to come does not count', !re.cpi.recent.some(r => r[0] === D0B + 13), re.cpi.recent)
t('newest first', re.cpi.recent[0][0] === D0B + 6, re.cpi.recent)
t('kinds stay separate', re.jobs.n === 1, re.jobs)
t('beside a typical day', re.cpi.normal > 0 && re.cpi.normal < re.cpi.avgAbs, re.cpi.normal)
t('no price history is null, not "no reaction"', btcReactions({ bls: [] }, null) === null)
const skip = btcReactions({ bls: [{ t: (D0B + 20) * 864e5, kind: 'cpi' }] }, btc, reNow + 30 * 864e5)
t('a day with no price is left out', !skip.cpi, skip)

// ── the Fed's projections ──
const sep = buildMacro({ series: { FEDTARMD: [['2026-01-01', 4.1], ['2027-01-01', 3.9]], UNRATEMD: [['2026-01-01', 4.1]] } }, Date.UTC(2026, 10, 7)).sep
t('this year and next, by date', sep.rate === 4.1 && sep.rateNext === 3.9 && sep.year === 2026, sep)
t('one not read stays null', sep.core === null, sep)
t('none at all is null', buildMacro({ series: {} }, 0).sep === null)

// ── what the page prints ──
t('jobs lost is signed', fmtMacro('jobs', -12) === '−12K', fmtMacro('jobs', -12))
t('unknown is a dash', fmtMacro('pct1', null) === '—')
t('a zero is a zero', fmtMacro('pct1', 0) === '0.0%')
t('a change in a rate is points, not percent', fmtDelta('pct1', 0.2) === '+0.2 pt', fmtDelta('pct1', 0.2))
t('no change has no sign', fmtDelta('pct1', 0) === '0.0 pt', fmtDelta('pct1', 0))
t('rounding to nothing has no sign', fmtDelta('pct1', -0.01) === '0.0 pt', fmtDelta('pct1', -0.01))
t('a quarter', periodLabel('q', '2026-07-01') === 'Q3 2026', periodLabel('q', '2026-07-01'))
t('a month stays that month west of UTC', /Sep/.test(periodLabel('m', '2026-09-01')), periodLabel('m', '2026-09-01'))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
