// src/macro.js: dates, gaps and failures. No network; every fetch here is a stub.
import { parseFredCsv, yoy, mom, monthDiff, buildMacro, parseFng, parseGlobal, parseIcs, blsEvents, beaEvents, parseFomc, easternToUtc, refreshMacro, fredUrl, macroHasData } from '../../src/macro.js'
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
const fng = parseFng({ data: [{ value: '25', value_classification: 'Extreme Fear', timestamp: '300' }, { value: '28', value_classification: 'Fear', timestamp: '200' }, { value: 'x', timestamp: '100' }] })
t('newest wins whatever order it arrives in', fng.value === 25 && fng.label === 'Extreme Fear', fng)
t('yesterday', fng.d1 === 28, fng)
t('no value a week ago is null', fng.d7 === null, fng)
t('history runs oldest first', fng.pts[0][1] === 28 && fng.pts.length === 2, fng.pts)
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
t('everything is read the first time', calls.filter(u => u.includes('fredgraph')).length === 20, calls.length)
t('reads the window it asked for', fredUrl('DGS10', NOW).includes('cosd=2025-'), fredUrl('DGS10', NOW))
t('a calendar that failed stays unknown', first.events.bls === null)
calls = []
await refreshMacro(first, ok, NOW + 60e3)
t('a minute later nothing is due', calls.length === 3, calls)   // only the three calendars, which failed and never succeeded
calls = []
const later = await refreshMacro(first, ok, NOW + 11 * 60e3)
t('market cap refreshes sooner than reports', calls.some(u => u.includes('coingecko')) && !calls.some(u => u.includes('fredgraph')), calls)
const down = await refreshMacro(first, async () => { throw new Error('down') }, NOW + 40 * 60e3)
t('an outage keeps the last good data', down.series.UNRATE?.length === 1 && down.fng?.value === 50 && down.global?.cap === 9, down.fng)
t('and tries again next time', down.srcAt['series:UNRATE'] === NOW, down.srcAt['series:UNRATE'])
t('later is fine', later.at === NOW + 11 * 60e3)

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
