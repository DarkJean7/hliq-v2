// Dates on the Overview chart's time axis and hover tag (src/chartdates.js). Asked: "lets add
// fixed days in the chart and the one when scrolling the chart like hovering".
import fs from 'fs'
import { chartDateTick, chartDateHover } from '../../src/chartdates.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const DAY = 864e5
const at = new Date(2026, 9, 21, 14, 5).getTime()   // local time, as the app shows it

t('a day on screen: ticks are times', chartDateTick(at, DAY) === '14:05', chartDateTick(at, DAY))
t('a week: ticks are days', chartDateTick(at, 7 * DAY) === 'Oct 21', chartDateTick(at, 7 * DAY))
t('a month too', chartDateTick(at, 30 * DAY) === 'Oct 21')
t('all time: months with the year', chartDateTick(at, 600 * DAY) === 'Oct 2026', chartDateTick(at, 600 * DAY))
t('hovering a week: the day and the time', chartDateHover(at, 7 * DAY) === 'Oct 21, 14:05', chartDateHover(at, 7 * DAY))
t('hovering all time: the full date', chartDateHover(at, 600 * DAY) === 'Oct 21, 2026', chartDateHover(at, 600 * DAY))
t('nonsense in, nothing out', chartDateTick('x', DAY) === '' && chartDateHover(NaN, DAY) === '')

const ch = fs.readFileSync('src/charts.js', 'utf8')
t('the Overview chart shows its time axis', /x: \{\s*type: 'linear', display: true/.test(ch) && ch.includes('callback(v) { return chartDateTick(v, this.max - this.min) }'))
t('the crosshair tags the date it is on, for charts whose x is a time', ch.includes("if (typeof xVal === 'number' && xVal > 1e12)") && ch.includes('chartDateHover(xVal, span)'))
t('and keeps the tag inside a chart with no axis below', ch.includes('bottom + 2 + bh <= chart.height ? bottom + 2 : bottom - bh - 2'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
