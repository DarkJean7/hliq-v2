// Outcome charts (src/ocmulti.js): a y range that fits, and an event's options on one chart.
// Driven for real in tests/outcomes-browser.mjs.
import fs from 'fs'
import { yRange, pickLegs, alignSeries, spreadLabels, shortName, fmtTick } from '../../src/ocmulti.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('-- the y range fits the line ("make them more responsive") --')
const r1 = yRange([1.2, 2.5, 3.1])
t('a market at 1-3% is not drawn on a 0-100 axis', r1.min >= 0 && r1.max <= 10, r1)
t('the line is inside the range', r1.min <= 1.2 && r1.max >= 3.1, r1)
const r2 = yRange([97, 98.5])
t('near 100% it stays inside 100', r2.max === 100 && r2.min < 97, r2)
t('a flat line still gets height', yRange([50, 50]).max - yRange([50, 50]).min >= 6)
t('round steps, not 4 / 25', [yRange([5, 22]).min, yRange([5, 22]).max].every(v => v % 5 === 0), yRange([5, 22]))
t('nothing to draw: the full range', JSON.stringify(yRange([])) === '{"min":0,"max":100}')

console.log('-- an event\'s options --')
t('the most likely, n of them', pickLegs([{ id: 1, p: .1 }, { id: 2, p: .4 }, { id: 3, p: .2 }], 2).map(l => l.id).join() === '2,3')
const a = alignSeries([[{ t: 1, c: '0.2' }, { t: 3, c: '0.3' }], [{ t: 2, c: '0.5' }]])
t('one time axis for all', a.times.join() === '1,2,3')
t('a quiet hour carries the last odds forward', JSON.stringify(a.lines[0]) === '[20,20,30]', a.lines[0])
t('and nothing is invented before a leg first traded', a.lines[1][0] === null && a.lines[1][2] === 50, a.lines[1])
const ys = spreadLabels([100, 104, 106, 300], 26, 0, 400)
t('end labels are pushed apart, not stacked', ys[1] - ys[0] >= 26 && ys[2] - ys[1] >= 26 && ys[3] === 300, ys)
const yb = spreadLabels([390, 395], 26, 0, 400)
t('and kept inside the plot', yb.every(y => y <= 400) && yb[1] - yb[0] >= 26, yb)
t('a team goes by its name', shortName('San Antonio Spurs') === 'Spurs' && shortName('Miami Heat') === 'Miami Heat')
const D = 24 * 3600e3, now = new Date(2026, 10, 16, 18).getTime()
t('ticks: dates over a week, date+hour over two days, time within one',
  /^[A-Z][a-z]{2} \d+$/.test(fmtTick(now, 7 * D)) && /^[A-Z][a-z]{2} \d+ \d/.test(fmtTick(now, 2 * D)) && /\d:\d\d/.test(fmtTick(now, D)),
  [fmtTick(now, 7 * D), fmtTick(now, 2 * D), fmtTick(now, D)])

console.log('-- wiring --')
const m = fs.readFileSync('src/main.js', 'utf8')
t('the single chart fits its range', m.includes('display: true, min: yr.min, max: yr.max, grace: 0,'))
t('and follows the live tick', m.includes('const r = yRange(data); chart.options.scales.y.min = r.min'))
t('outcome charts opt out of the Trade chart\'s global plugins', (m.match(/yPriceBoxes: false, markDot: false/g) ?? []).length === 2)
t('an event\'s chart loads on a press, never for every card', m.includes("window.__ocEvtChart = async function(evId, btn)") && !/_ocLegHistory\([^)]*\)[^\n]*forEach/.test(m))
t('and its history is kept a few minutes', m.includes('Date.now() - hit.t < 300_000'))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
