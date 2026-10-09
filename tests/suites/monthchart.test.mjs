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
  MODES, DEFAULT_MODE, monthBounds, dayBounds, isSpan, windowHistory, pickWindow, valueSeries,
  accumSeries, realizedSeries, seriesFor, availableModes, modeHasData, maxDrawdown, panelHtml,
  isOpen, setOpen, setMode, currentMode, collapse, canvasId, heroId, emptyNote, MONTH, DAY,
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
// The series take a SPAN now, not a year and a month: the same three are drawn for a pressed
// DAY as for the month, and two copies of that arithmetic would drift. monthBounds/dayBounds
// are the two ways of making one.
const SEP = monthBounds(Y, M)

console.log(nl + '-- the month, bounded where the grid bounds it --')
{
  const { from, to } = monthBounds(Y, M)
  t('starts at the first instant of the 1st', new Date(from).getDate() === 1 && new Date(from).getHours() === 0)
  t('ends before the 1st of next month', to < new Date(Y, M + 1, 1).getTime() && to > at(30, 23))
  t('and it is local time, not UTC — the squares are too', new Date(from).getMonth() === M)
}

console.log(nl + '-- ONE window, and never a perp-only one --')
{
  // Reported as "in all accounts the charts are very bad… they are so wrong", with a line
  // that looked like a scribble between two levels.
  //
  // HL answers the portfolio call with EIGHT windows: day/week/month/allTime for the whole
  // account, and a perp-only twin of each. Points from all eight were merged into one series,
  // so two quantities hundreds or thousands of dollars apart, sampled on grids that do not
  // line up, were drawn alternately as if they were one line. The combined view made it
  // obvious because there the perp and unified totals are far apart and every window is
  // resampled independently.
  const portfolio = [
    ['day',         { accountValueHistory: [[at(26, 9), '10500'], [at(26, 10), '10600']], pnlHistory: [] }],
    ['month',       { accountValueHistory: [[aug(30), '9400'], [at(2), '9500'], [at(10), '9800'], [at(20), '10200'], [at(26, 9), '10500']], pnlHistory: [] }],
    ['allTime',     { accountValueHistory: [[aug(30), '9000'], [at(1), '9500'], [at(20), '10200'], [oct(2), '11000']], pnlHistory: [] }],
    // The perp side of the same account: real numbers, a different quantity.
    ['perpMonth',   { accountValueHistory: [[at(3), '2100'], [at(11), '2400'], [at(21), '2600']], pnlHistory: [] }],
    ['perpAllTime', { accountValueHistory: [[at(4), '2000'], [at(22), '2500']], pnlHistory: [] }],
  ]
  const v = valueSeries(portfolio, SEP)
  t('no perp-only point is in the line', !v.some(p => p.y < 5000), v.map(p => p.y))
  t('and the line is one window, not a blend of them',
    v.length === 4 && v.every(p => [9500, 9800, 10200, 10500].some(y => near(p.y, y))), v.map(p => p.y))
  // `month` covers the whole of September so far; `day` covers one hour of it and `allTime`
  // has three points in it. Coverage first, then resolution.
  t('the window chosen is the one that covers the month best', pickWindow(portfolio, 'accountValueHistory', SEP).name === 'month')
  // An older month is only in allTime, and that is then the right answer rather than no answer.
  const old = [['month', { accountValueHistory: [[at(2), '9500']] }],
               ['allTime', { accountValueHistory: [[aug(3), '8000'], [aug(19), '8400']] }]]
  t('an older month falls to the window that reaches it', pickWindow(old, 'accountValueHistory', monthBounds(Y, M - 1)).name === 'allTime')
  t('cut to the month — August and October are not in it', v.every(p => p.x >= at(1, 0) && p.x <= at(30, 23)))
  // Empty is not unknown: no portfolio held is a different answer from a flat account.
  t('no portfolio: null, not an empty line', valueSeries(null, SEP) === null && windowHistory(undefined, 'pnlHistory', 'day') === null)
  t('a window with no history at all: null', windowHistory([['day', {}]], 'pnlHistory', 'day') === null)
  t('a month no window reaches: empty', valueSeries(portfolio, 2019, 0).length === 0)
}

console.log(nl + '-- accumulative PnL is rebased to the 1st --')
{
  // HL's pnlHistory is ALL-TIME. Drawn as it comes, a month of a profitable account is a line
  // that starts at $9,000 and the month's own shape is invisible inside it.
  const portfolio = [['allTime', { accountValueHistory: [], pnlHistory: [
    [aug(31, 23), '4000'],    // where the account stood going into September
    [at(2), '4300'], [at(10), '3600'], [at(20), '4800'], [at(26), '6497'],
  ] }],
  // The perp-only twin says something quite different about the same month. It is not this.
  ['perpAllTime', { pnlHistory: [[aug(31, 23), '900'], [at(12), '1500'], [at(26), '1200']] }]]
  const a = accumSeries(portfolio, SEP)
  t('the perp window is not what the month is measured from', near(a.at(-1).y, 2497))
  t('it starts at zero on the 1st', a[0].x === monthBounds(Y, M).from && a[0].y === 0)
  t('and reads as what the month has made', near(a.at(-1).y, 2497))
  // The drawdown the calendar cannot show: +300, then −700 from there.
  t('the dip in the middle is in the line', near(a[1].y, 300) && near(a[2].y, -400))
  t('measured from the last reading BEFORE the month, not the first one inside it',
    !near(a.at(-1).y, 6497 - 4300), a.at(-1).y)
  // With no reading before the month (a new account), the first in-month point IS the start.
  const fresh = [['allTime', { pnlHistory: [[at(3), '0'], [at(9), '120']] }]]
  t('a month with no history before it starts from its own first point',
    accumSeries(fresh, SEP).length === 2 && near(accumSeries(fresh, SEP).at(-1).y, 120))
  t('a month with no points at all is empty, and says so', accumSeries(portfolio, monthBounds(Y, M + 1)).length === 0)
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
  const r = realizedSeries(fills, SEP)
  t('it starts at zero on the 1st', r[0].y === 0 && r[0].x === monthBounds(Y, M).from)
  t('one step per close, in time order', r.length === 4 && r[1].y === 120 && near(r[2].y, 75))
  // The last point has to equal the Month PnL card, or the chart and the grid above it are
  // telling the reader two different things about the same month.
  t('and it ends on the month\'s own PnL', near(r.at(-1).y, 375.5))
  t('other months are not in it', !r.some(p => near(p.y, 500) || near(p.y, 900)))
  t('no fills held: null', realizedSeries(null, SEP) === null)
  t('no closes this month: empty, which is a real answer', realizedSeries([{ time: aug(2), closedPnl: 5 }], SEP).length === 0)
  t('and it is said as one', emptyNote('realized', { fills: [] }) === 'No trades closed in this month')
}

console.log(nl + '-- how far the month gave back --')
{
  // The calendar's Max Drawdown card reads this. It used to walk the daily CLOSED PnL, which
  // is a different question: an account can hand back $600 of open profit over a week and
  // close nothing at a loss, and the card said "$0 - never gave any back".
  const curve = [{ x: 1, y: 0 }, { x: 2, y: 500 }, { x: 3, y: 2200 }, { x: 4, y: 1600 }, { x: 5, y: 1900 }]
  const dd = maxDrawdown(curve)
  t('the drop is peak to trough', near(dd.drop, 600))
  t('and it names both ends', dd.from === 3 && dd.to === 4)
  t('a month that only went up gave nothing back', maxDrawdown([{ x: 1, y: 0 }, { x: 2, y: 9 }]).drop === 0)
  // The deepest run, not the last one: 2200 -> 1600 is 600, and a later 1900 -> 1500 is 400.
  t('the DEEPEST run wins, not the latest',
    near(maxDrawdown([...curve, { x: 6, y: 1500 }]).drop, 700))
  t('a month still under water measures from its own high',
    near(maxDrawdown([{ x: 1, y: 0 }, { x: 2, y: -300 }, { x: 3, y: -1200 }]).drop, 1200))
  t('nothing to walk: null, not zero', maxDrawdown([]) === null && maxDrawdown([{ x: 1, y: 5 }]) === null)
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
  t('seriesFor routes to each', seriesFor('value', { portfolio }, SEP).length === 1 &&
    seriesFor('realized', { fills: [] }, SEP).length === 0)
}

console.log(nl + '-- the row itself --')
{
  const data = { portfolio: [['allTime', { accountValueHistory: [[at(2), '1']], pnlHistory: [[at(2), '1']] }]], fills: [] }
  collapse()
  const shut = panelHtml('mobCalRoot', SEP, data, MONTH)
  t('it is closed to begin with', !isOpen() && !shut.includes('<canvas'))
  t('and says what it is', shut.includes("Month's chart performance") && shut.includes('September 2026'))
  t('pressing it is the whole affordance', shut.includes("__calChartToggle('mobCalRoot','month')"))
  setOpen(true)
  const open = panelHtml('mobCalRoot', SEP, data, MONTH)
  t('open, it carries a canvas of its own per calendar', open.includes(`id="${canvasId('mobCalRoot', MONTH)}"`))
  t('and the three tabs', ['Value', 'Accum.', 'Realized'].every(l => open.includes('>' + l + '<')))
  t('every mode is offered even where its data is missing',
    ['>Value<', '>Accum.<', '>Realized<'].every(l =>
      panelHtml('mobCalRoot', SEP, { portfolio: null, fills: [] }, MONTH).includes(l)))
  setMode('value')
  collapse()
  t('collapse shuts it', !isOpen() && !panelHtml('mobCalRoot', SEP, data, MONTH).includes('<canvas'))
}

console.log(nl + '-- the same row, for the day that was pressed --')
{
  // Asked for: "similar as month's chart performance, no the same for the selected day".
  // One module, one set of series, two spans — a second copy of the arithmetic would drift
  // from this one, and this file's whole subject is that each series measures a different
  // thing.
  const D = '2026-09-14'
  const sp = dayBounds(D)
  t('a day key becomes a span', isSpan(sp))
  t('starting at midnight, local time, where the square starts',
    new Date(sp.from).getHours() === 0 && new Date(sp.from).getDate() === 14)
  t('and ending one millisecond before the next day', sp.to - sp.from === 86400000 - 1)
  t('tomorrow is a different span', dayBounds('2026-09-15').from === sp.to + 1)
  t('anything that is not a day key is null, not a guess',
    dayBounds('2026-9-14') === null && dayBounds('nope') === null && dayBounds(null) === null)
  t('and a bad span draws nothing rather than everything',
    !isSpan({ from: 1, to: 1 }) && !isSpan({ from: 2, to: 1 }) && !isSpan(null))

  // The three series, cut to the day instead of the month.
  const h = (hour) => new Date(2026, 8, 14, hour).getTime()
  const portfolio = [['month', {
    accountValueHistory: [[h(-6), '900'], [h(2), '1000'], [h(9), '1100'], [h(18), '1050'], [new Date(2026, 8, 15, 6).getTime(), '1200']],
    pnlHistory:          [[h(-6), '40'],  [h(2), '50'],   [h(9), '150'],  [h(18), '100'],  [new Date(2026, 8, 15, 6).getTime(), '250']],
  }]]
  const dv = valueSeries(portfolio, sp)
  t('value keeps only that day', dv.length === 3 && dv.every(p => p.x >= sp.from && p.x <= sp.to), dv.map(p => p.y))
  const da = accumSeries(portfolio, sp)
  t('accum starts at zero at midnight', da[0].x === sp.from && da[0].y === 0)
  // Rebased on the last reading BEFORE the day, not the first one inside it, or whatever
  // happened between midnight and the first bucket is silently dropped.
  t('and is measured from the reading before midnight', near(da.at(-1).y, 60), da.map(p => p.y))
  const fills = [
    { time: new Date(2026, 8, 13, 20).getTime(), closedPnl: 99 },
    { time: h(3),  closedPnl: 10 },
    { time: h(16), closedPnl: -4 },
    { time: new Date(2026, 8, 15, 1).getTime(), closedPnl: 77 },
  ]
  const dr = realizedSeries(fills, sp)
  t('realized is that day\'s closes only', dr.length === 3 && near(dr.at(-1).y, 6), dr.map(p => p.y))
  t('and it is the number the day square shows', near(dr.at(-1).y, 10 - 4))
  t('a day that closed nothing is empty, which is a real answer',
    realizedSeries(fills, dayBounds('2026-09-12')).length === 0)
}

console.log(nl + '-- two rows on one screen, told apart --')
{
  const data = { portfolio: [['allTime', { accountValueHistory: [[at(2), '1']], pnlHistory: [[at(2), '1']] }]], fills: [] }
  const sp = dayBounds('2026-09-14')
  collapse()
  const day = panelHtml('mobCalRoot', sp, data, DAY)
  t('the day row calls itself what it is', day.includes("Day's chart performance"))
  t('and names the day, not the month', day.includes('September 14, 2026'))
  t('the month row still names the month', panelHtml('mobCalRoot', SEP, data, MONTH).includes('September 2026'))
  // They are on screen together: one canvas id for both would have Chart.js draw one over
  // the other, and one open flag would open and close them as a pair.
  t('their canvases cannot collide', canvasId('r', DAY) !== canvasId('r', MONTH) && heroId('r', DAY) !== heroId('r', MONTH))
  setOpen(true, DAY)
  t('opening the day leaves the month shut', isOpen(DAY) && !isOpen(MONTH))
  t('and only the day grows a canvas',
    panelHtml('r', sp, data, DAY).includes('<canvas') && !panelHtml('r', SEP, data, MONTH).includes('<canvas'))
  // The month row was left on 'value' by the section above; put it somewhere known so this
  // is testing independence rather than leftovers.
  setMode('accum', MONTH)
  setMode('value', DAY)
  t('a tab pressed on one does not move the other',
    currentMode(DAY) === 'value' && currentMode(MONTH) === 'accum')
  // The span is written onto the element, because the day panel is rebuilt from scratch on
  // every press and asking the calendar which day is open would be stale exactly then.
  t('each row carries its own span', day.includes(`data-from="${sp.from}"`) && day.includes(`data-to="${sp.to}"`))
  t('and its scope', day.includes('data-scope="day"'))
  collapse()
  t('opening a calendar shuts both', !isOpen(DAY) && !isOpen(MONTH))
}

console.log(nl + '-- what an empty day says --')
{
  // A day far enough back that HL only keeps a coarse reading of it has no points. That is
  // not a flat day, and it must not be drawn as one.
  t('no history for the day, said as the day', emptyNote('accum', { portfolio: [] }, DAY) === 'No account history for this day')
  t('no closes, said as the day', emptyNote('realized', { fills: [] }, DAY) === 'No trades closed in this day')
  t('the month still says month', emptyNote('accum', { portfolio: [] }, MONTH) === 'No account history for this month')
  t('and "not loaded yet" is still told apart from "none"',
    emptyNote('accum', { portfolio: null }, DAY) === 'Account history has not loaded yet')
}

console.log(nl + '-- wired in --')
{
  const rnd  = fs.readFileSync('src/render.js', 'utf8')
  const main = fs.readFileSync('src/main.js', 'utf8')
  const cht  = fs.readFileSync('src/charts.js', 'utf8')
  t('the row sits between the cards and the grid',
    /\$\{calChartPanel\(rootId, monthBounds\(year, month\), monthChartData\(fills\), CHART_MONTH\)\}\s*\n\s*<div style="overflow-x:auto/.test(rnd))
  t('and is drawn after the calendar is painted', /try \{ drawMonthChart\(rootId\) \} catch \{\}/.test(rnd))
  t('the day row sits under the pills, above the trades',
    /<div class="cal-day-chart">\$\{calChartPanel\(rootId, dayBounds\(key\), monthChartData\(cache\.fills\), CHART_DAY\)\}<\/div>\s*\n\s*\$\{tradesHtml\}/.test(rnd))
  t('and is drawn after the day panel is painted', /try \{ drawDayChart\(rootId\) \} catch \{\}/.test(rnd))
  t('every calendar draws its own, and each scope its own again',
    /export const canvasId = \(rootId, scope\) =>/.test(fs.readFileSync('src/monthchart.js', 'utf8')))
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
  t('the card asks for an axis that cannot be clipped by a late font', /axisMin: 66,/.test(fs.readFileSync('src/monthchart.js', 'utf8')))
  // The frame is measured from the data, so the card can also say WHEN — the x axis is the
  // month itself, from the 1st to the last day or to today in the month still running.
  t('and for a frame that is the span', /dates: true, xMin: from, xMax: now > from && now < to \? now : to,/.test(fs.readFileSync('src/monthchart.js', 'utf8')))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
