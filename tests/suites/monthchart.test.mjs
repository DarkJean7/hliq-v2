// The month, as a curve — src/monthchart.js.
//
// Asked for: a row between the calendar's stat cards and its grid that opens into the
// Portfolio tab's chart for the month being looked at, "so the user can see how a month's
// drawback may have affected" it. Nine totals and a grid of squares cannot say what order
// things happened in: +$2,497 that never gave anything back and +$2,497 that was $1,800 down
// in the middle are the same nine cards.
//
// What these fix in place is the arithmetic of the three series, because each one is
// measuring something different and only one of them is HL's own number as it comes.
import fs from 'fs'
import {
  MODES, DEFAULT_MODE, monthBounds, mergedHistory, valueSeries, accumSeries, realizedSeries,
  seriesFor, availableModes, modeHasData, panelHtml, isOpen, setOpen, setMode, collapse,
  canvasId, emptyNote,
} from '../../src/monthchart.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

// September 2026, in the reader's own timezone — the same boundary the day squares use.
const Y = 2026, M = 8
const at = (day, hour = 12) => new Date(Y, M, day, hour).getTime()
const aug = (day, hour = 12) => new Date(Y, M - 1, day, hour).getTime()
const oct = (day, hour = 12) => new Date(Y, M + 1, day, hour).getTime()

console.log(nl + '-- the month, bounded where the grid bounds it --')
{
  const { from, to } = monthBounds(Y, M)
  t('starts at the first instant of the 1st', new Date(from).getDate() === 1 && new Date(from).getHours() === 0)
  t('ends before the 1st of next month', to < new Date(Y, M + 1, 1).getTime() && to > at(30, 23))
  t('and it is local time, not UTC — the squares are too', new Date(from).getMonth() === M)
}

console.log(nl + '-- every window HL sent, at the best resolution it has --')
{
  // HL answers in four windows at four resolutions. `month` cannot reach March; `allTime`
  // reaches it coarsely. Merging is what lets one row serve whichever month is on screen.
  const portfolio = [
    ['day',     { accountValueHistory: [[at(26, 9), '10500'], [at(26, 10), '10600']], pnlHistory: [] }],
    ['month',   { accountValueHistory: [[at(20), '10200'], [at(26, 9), '10500']],     pnlHistory: [] }],
    ['allTime', { accountValueHistory: [[aug(30), '9000'], [at(1), '9500'], [at(20), '10200'], [oct(2), '11000']], pnlHistory: [] }],
  ]
  const all = mergedHistory(portfolio, 'accountValueHistory')
  t('each timestamp once', all.length === 6, all.length)
  t('in order', all.every((p, i) => i === 0 || p.x >= all[i - 1].x))
  const v = valueSeries(portfolio, Y, M)
  t('cut to the month — August and October are not this month', v.length === 4 && v.every(p => p.x >= at(1, 0) && p.x <= at(30, 23)))
  t('the fine points survive the cut', v.some(p => near(p.y, 10600)))
  // Empty is not unknown: no portfolio held is a different answer from a flat account.
  t('no portfolio: null, not an empty line', valueSeries(null, Y, M) === null && mergedHistory(undefined, 'pnlHistory') === null)
  t('a portfolio with no history at all: null', mergedHistory([['day', {}]], 'pnlHistory') === null)
}

console.log(nl + '-- accumulative PnL is rebased to the 1st --')
{
  // HL's pnlHistory is ALL-TIME. Drawn as it comes, a month of a profitable account is a line
  // that starts at $9,000 and the month's own shape is invisible inside it.
  const portfolio = [['allTime', { accountValueHistory: [], pnlHistory: [
    [aug(31, 23), '4000'],    // where the account stood going into September
    [at(2), '4300'], [at(10), '3600'], [at(20), '4800'], [at(26), '6497'],
  ] }]]
  const a = accumSeries(portfolio, Y, M)
  t('it starts at zero on the 1st', a[0].x === monthBounds(Y, M).from && a[0].y === 0)
  t('and reads as what the month has made', near(a.at(-1).y, 2497))
  // The drawdown the calendar cannot show: +300, then −700 from there.
  t('the dip in the middle is in the line', near(a[1].y, 300) && near(a[2].y, -400))
  t('measured from the last reading BEFORE the month, not the first one inside it',
    !near(a.at(-1).y, 6497 - 4300), a.at(-1).y)
  // With no reading before the month (a new account), the first in-month point IS the start.
  const fresh = [['allTime', { pnlHistory: [[at(3), '0'], [at(9), '120']] }]]
  t('a month with no history before it starts from its own first point',
    accumSeries(fresh, Y, M).length === 2 && near(accumSeries(fresh, Y, M).at(-1).y, 120))
  t('a month with no points at all is empty, and says so', accumSeries(portfolio, Y, M + 1).length === 0)
}

console.log(nl + '-- realized PnL is the closes, accumulated --')
{
  const fills = [
    { time: aug(28), closedPnl: 500 },            // last month
    { time: at(3),  closedPnl: 120 },
    { time: at(3, 15), closedPnl: -45 },
    { time: at(18), closedPnl: 300.5 },
    { time: at(19), closedPnl: 0 },               // an opening fill: not a close
    { time: oct(1), closedPnl: 900 },             // next month
  ]
  const r = realizedSeries(fills, Y, M)
  t('it starts at zero on the 1st', r[0].y === 0 && r[0].x === monthBounds(Y, M).from)
  t('one step per close, in time order', r.length === 4 && r[1].y === 120 && near(r[2].y, 75))
  // The last point has to equal the Month PnL card, or the chart and the grid above it are
  // telling the reader two different things about the same month.
  t('and it ends on the month\'s own PnL', near(r.at(-1).y, 375.5))
  t('other months are not in it', !r.some(p => near(p.y, 500) || near(p.y, 900)))
  t('no fills held: null', realizedSeries(null, Y, M) === null)
  t('no closes this month: empty, which is a real answer', realizedSeries([{ time: aug(2), closedPnl: 5 }], Y, M).length === 0)
  t('and it is said as one', emptyNote('realized', { fills: [] }) === 'No trades closed in this month')
}

console.log(nl + '-- all three are always offered --')
{
  const portfolio = [['allTime', { accountValueHistory: [[at(2), '1']], pnlHistory: [[at(2), '1']] }]]
  // Reported as "how can i see the month account equity and accumulative pnl": the modes used
  // to be filtered by what was held, so a view without an account history showed one lone
  // Realized tab and no way to tell that the other two existed at all.
  t('three modes with an account history', availableModes({ portfolio, fills: [] }).length === 3)
  t('and three without one', availableModes({ portfolio: null, fills: [] }).length === 3)
  t('what is missing is said in the chart, not by hiding the tab',
    emptyNote('value', { portfolio: null }) === 'Account history has not loaded yet' &&
    emptyNote('value', { portfolio: [] }) === 'No account history for this month')
  t('and a mode knows what it needs',
    modeHasData('realized', { fills: [] }) && !modeHasData('accum', { fills: [] }))
  t('the default is the one that shows the shape of the month', DEFAULT_MODE === 'accum')
  t('each mode says what it is', MODES.every(m => m.id && m.label && m.title && m.needs))
  t('seriesFor routes to each', seriesFor('value', { portfolio }, Y, M).length === 1 &&
    seriesFor('realized', { fills: [] }, Y, M).length === 0)
}

console.log(nl + '-- the row itself --')
{
  const data = { portfolio: [['allTime', { accountValueHistory: [[at(2), '1']], pnlHistory: [[at(2), '1']] }]], fills: [] }
  collapse()
  const shut = panelHtml('mobCalRoot', Y, M, data)
  t('it is closed to begin with', !isOpen() && !shut.includes('<canvas'))
  t('and says what it is', shut.includes("Month's chart performance") && shut.includes('September 2026'))
  t('pressing it is the whole affordance', shut.includes('__calMonthChartToggle(\'mobCalRoot\')'))
  setOpen(true)
  const open = panelHtml('mobCalRoot', Y, M, data)
  t('open, it carries a canvas of its own per calendar', open.includes(`id="${canvasId('mobCalRoot')}"`))
  t('and the three tabs', ['Value', 'Accum.', 'Realized'].every(l => open.includes('>' + l + '<')))
  t('every mode is offered even where its data is missing',
    ['>Value<', '>Accum.<', '>Realized<'].every(l =>
      panelHtml('mobCalRoot', Y, M, { portfolio: null, fills: [] }).includes(l)))
  setMode('value')
  collapse()
  t('collapse shuts it', !isOpen() && !panelHtml('mobCalRoot', Y, M, data).includes('<canvas'))
}

console.log(nl + '-- wired in --')
{
  const rnd  = fs.readFileSync('src/render.js', 'utf8')
  const main = fs.readFileSync('src/main.js', 'utf8')
  const cht  = fs.readFileSync('src/charts.js', 'utf8')
  t('the row sits between the cards and the grid',
    /\$\{monthChartPanel\(rootId, year, month, monthChartData\(fills\)\)\}\s*\n\s*<div style="overflow-x:auto/.test(rnd))
  t('and is drawn after the calendar is painted', /try \{ drawMonthChart\(rootId\) \} catch \{\}/.test(rnd))
  t('every calendar draws its own', /export const canvasId = \(rootId\) =>/.test(fs.readFileSync('src/monthchart.js', 'utf8')))
  // In the combined view state.portfolio is already every visible wallet's history resampled
  // and summed (_mergePortfolio) — the series the All Accounts charts themselves use. Handing
  // the row null there is what hid two of its three tabs.
  t('the portfolio is asked for at draw time, not threaded through seven callers',
    /setMonthChartSource\(\(\) => \(\{ portfolio: state\.portfolio \}\)\)/.test(main))
  t('and the combined view uses the history it already merges',
    /portfolio:   _mergePortfolio\(visible\),/.test(main))
  t('opening a calendar closes it — both shells and the More menu',
    (main.match(/_collapseMonthChart\(\)/g) ?? []).length >= 3)
  // A value line is not a PnL line: it is never negative, and what it is saying is the change
  // across what is on screen.
  t('the chart knows an amount from a result', /kind = 'pnl', empty = 'No closed trades in range'/.test(cht) &&
    /const up    = kind === 'value' \? last >= first : last >= 0/.test(cht))
  // Two bugs this row made visible, both older than it and both on every dollar chart in the
  // app: a price-chart plugin registered on Chart itself was painting a SECOND set of tick
  // labels over these ones, and the axis wrote a negative as "$-1,000".
  t('one set of axis labels, not two', /yPriceBoxes: false,/.test(cht))
  t('and the minus goes before the dollar', /callback: v => \(v < 0 \? '-\$' : '\$'\) \+ Math\.abs\(Number\(v\)\)/.test(cht))
  t('the card asks for an axis that cannot be clipped by a late font', /maxTicks: 3, axisMin: 66,/.test(fs.readFileSync('src/monthchart.js', 'utf8')))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
